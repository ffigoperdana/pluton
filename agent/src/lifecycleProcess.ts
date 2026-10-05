import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { open, lstat, chmod } from "node:fs/promises";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";

export type ProcessFailureCode =
  | "cancelled"
  | "timeout"
  | "output-limit"
  | "auth-failed"
  | "unavailable"
  | "failed"
  | "start-failed";
export class LifecycleProcessError extends Error {
  constructor(readonly code: ProcessFailureCode) {
    super("Lifecycle process failed.");
  }
}

function stopTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* Already stopped. */
  }
}

/** No output leaves this runner. Database SQL is streamed directly to a private fd. */
export async function runLifecycleProcess(input: {
  binary: string;
  args: string[];
  cwd: string;
  timeoutSeconds: number;
  shouldCancel: () => Promise<boolean>;
  output?: { file: string; maxBytes: number };
  env?: NodeJS.ProcessEnv;
}): Promise<{ bytes: number; sha256: string }> {
  if (await input.shouldCancel()) throw new LifecycleProcessError("cancelled");
  const file = input.output
    ? await open(
        input.output.file,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      )
    : undefined;
  let child: ChildProcess | undefined;
  let failure: ProcessFailureCode | undefined;
  let bytes = 0;
  let stderr = "";
  const hash = createHash("sha256");
  try {
    if (file) await file.chmod(0o600);
    child = spawn(input.binary, input.args, {
      shell: false,
      detached: true,
      cwd: input.cwd,
      env: input.env || {
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        HOME: input.cwd,
        TMPDIR: input.cwd,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const stop = (code: ProcessFailureCode) => {
      failure ||= code;
      if (closed) return;
      stopTree(child!);
      if (!killTimer)
        killTimer = setTimeout(() => {
          try {
            if (child?.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            /* Already stopped. */
          }
        }, 1000);
    };
    const deadline = setTimeout(
      () => stop("timeout"),
      input.timeoutSeconds * 1000,
    );
    let checking = false;
    const cancellation = setInterval(() => {
      if (checking || closed) return;
      checking = true;
      void input
        .shouldCancel()
        .then((cancel) => {
          if (cancel) stop("cancelled");
        })
        .catch(() => {
          // Control-plane outages do not turn a partially written dump into success.
          // The hard deadline still applies while the lease/status request is unavailable.
        })
        .finally(() => {
          checking = false;
        });
    }, 1000);
    const status = new Promise<number | null>((resolve) => {
      child!.once("error", () => {
        stop("start-failed");
      });
      child!.once("close", (code) => {
        closed = true;
        resolve(code);
      });
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.length + chunk.length > 64 * 1024) {
        stop("output-limit");
        return;
      }
      stderr += chunk.toString("utf8");
    });
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > (input.output?.maxBytes ?? 64 * 1024)) {
          stop("output-limit");
          callback(new LifecycleProcessError("output-limit"));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    let writing: Promise<void>;
    if (file) {
      // Keep sole ownership of the fd: pipeline destruction must not double-close
      // it and replace an output-limit/cancellation reason with EBADF.
      const destination = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          void file.writeFile(chunk).then(() => callback(), callback);
        },
      });
      writing = pipeline(child.stdout!, bounded, destination).catch(() => {
        stop("failed");
      });
    } else {
      bounded.resume();
      writing = pipeline(child.stdout!, bounded).catch(() => {
        stop("failed");
      });
    }
    try {
      const code = await status;
      await writing;
      if (failure) throw new LifecycleProcessError(failure);
      if (code !== 0) {
        // Provider text is consumed only for closed classification, never logged/returned.
        const category = /(?:\b1045\b|Access denied)/i.test(stderr)
          ? "auth-failed"
          : /(?:\b200[2356]\b|Can't connect|Unknown MySQL server host)/i.test(
                stderr,
              )
            ? "unavailable"
            : "failed";
        throw new LifecycleProcessError(category);
      }
    } finally {
      clearTimeout(deadline);
      clearInterval(cancellation);
      // Also refuse background descendants on successful hook exit: hooks are
      // bounded jobs, never a daemon-launch facility. Stdio may already be closed.
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already stopped. */
      }
      if (killTimer) clearTimeout(killTimer);
    }
  } finally {
    await file?.close();
  }
  if (input.output) {
    const info = await lstat(input.output.file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== bytes ||
      !bytes
    )
      throw new LifecycleProcessError("failed");
    await chmod(input.output.file, 0o600);
  }
  return { bytes, sha256: hash.digest("hex") };
}

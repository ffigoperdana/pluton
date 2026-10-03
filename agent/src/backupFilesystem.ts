import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { assertPathWithinAllowedRoots } from "./filesystemPolicy.js";
import { privateBinaryPath } from "./inventory.js";
import type { AgentConfig } from "./types.js";

const MAX_OUTPUT_BYTES = 64 * 1024;
const PROGRESS_INTERVAL_MS = 5_000;

/**
 * Only the password-authenticated SFTP subset is supported for the first
 * remote data-plane path. In particular, never accept rclone options that
 * invoke an external SSH binary, a remote shell command, or an agent-local
 * credential file.
 */
const SFTP_OPTION_KEYS = new Set(["host", "port", "user", "pass"]);

export type BackupFilesystemPayload = {
  version: 1;
  backupId: string;
  planId: string;
  sourcePath: string;
  excludes: string[];
  repository: {
    remoteName: "pluton";
    path: string;
    initialize: boolean;
  };
  rclone: {
    type: "sftp";
    options: Record<string, string>;
  };
  repositoryPassword: string;
};

export type ResticSummary = {
  message_type: "summary";
  files_new: number;
  files_changed: number;
  files_unmodified: number;
  dirs_new: number;
  dirs_changed: number;
  dirs_unmodified: number;
  data_blobs: number;
  tree_blobs: number;
  data_added: number;
  data_added_packed: number;
  total_files_processed: number;
  total_bytes_processed: number;
  total_duration: number;
  snapshot_id: string;
};

export type BackupFilesystemResult = {
  snapshotId: string;
  summary: ResticSummary;
};

export class BackupCancelledError extends Error {
  constructor() {
    super("Backup was cancelled.");
  }
}

type ProcessResult = {
  code: number | null;
  stdout: string;
};

type ProcessOptions = {
  env: NodeJS.ProcessEnv;
  allowFailure?: boolean;
  stdin?: string;
  shouldCancel: () => Promise<boolean>;
  onJsonLine?: (value: Record<string, unknown>) => Promise<void>;
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, max = 8_192): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function validateId(value: unknown, label: string): string {
  const id = requiredString(value, label, 160);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`${label} is invalid.`);
  return id;
}

function validateRepositoryPath(value: unknown): string {
  const repositoryPath = requiredString(value, "Repository path");
  if (repositoryPath.split(/[\\/]+/).includes("..")) {
    throw new Error("Repository path contains traversal.");
  }
  return repositoryPath;
}

function validateExcludes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error("Backup excludes are invalid.");
  return value.map((entry, index) => {
    const item = requiredString(entry, `Backup exclude ${index + 1}`, 4_096);
    if (item.split(/[\\/]+/).includes(".."))
      throw new Error("Backup excludes cannot contain traversal.");
    return item;
  });
}

function validateRcloneOptions(value: unknown): Record<string, string> {
  const input = asRecord(value, "SFTP configuration");
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (!SFTP_OPTION_KEYS.has(key))
      throw new Error("SFTP configuration contains an unsupported option.");
    const item = requiredString(entry, `SFTP option ${key}`, 16_384);
    result[key] = item;
  }
  if (!result.host || !result.user || !result.pass) {
    throw new Error("SFTP host, user, and password are required.");
  }
  return result;
}

/**
 * Parse the short, server-signed workflow envelope. Unknown fields are refused
 * so this cannot gradually turn into a generic remote execution protocol.
 */
export function parseBackupFilesystemPayload(
  value: Record<string, unknown>,
): BackupFilesystemPayload {
  const allowed = new Set([
    "version",
    "backupId",
    "planId",
    "sourcePath",
    "excludes",
    "repository",
    "rclone",
    "repositoryPassword",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Backup command contains unsupported fields.");
  }
  if (value.version !== 1)
    throw new Error("Backup command version is unsupported.");
  const repository = asRecord(value.repository, "Repository configuration");
  const rclone = asRecord(value.rclone, "Rclone configuration");
  if (
    repository.remoteName !== "pluton" ||
    typeof repository.initialize !== "boolean"
  ) {
    throw new Error("Repository configuration is invalid.");
  }
  if (rclone.type !== "sftp")
    throw new Error("Only SFTP storage is supported by this agent.");
  const password = requiredString(
    value.repositoryPassword,
    "Repository password",
    512,
  );
  if (password.length < 20) throw new Error("Repository password is invalid.");
  return {
    version: 1,
    backupId: validateId(value.backupId, "Backup ID"),
    planId: validateId(value.planId, "Plan ID"),
    sourcePath: requiredString(value.sourcePath, "Source path", 4_096),
    excludes: validateExcludes(value.excludes),
    repository: {
      remoteName: "pluton",
      path: validateRepositoryPath(repository.path),
      initialize: repository.initialize,
    },
    rclone: { type: "sftp", options: validateRcloneOptions(rclone.options) },
    repositoryPassword: password,
  };
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function assertSourceDoesNotOverlapState(
  source: string,
  dataDir: string,
): Promise<void> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const state = await realpath(dataDir);
  if (isWithin(source, state) || isWithin(state, source)) {
    throw new Error(
      "The backup source must not include the agent state directory.",
    );
  }
}

function appendBounded(existing: string, chunk: string): string {
  if (existing.length >= MAX_OUTPUT_BYTES) return existing;
  return (existing + chunk).slice(0, MAX_OUTPUT_BYTES);
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.killed) return;
  try {
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => {
        try {
          child.kill("SIGTERM");
        } catch {
          // The process has already stopped.
        }
      });
      killer.unref();
    } else if (child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const forceKill = setTimeout(() => {
    try {
      if (process.platform === "win32" && child.pid) {
        const killer = spawn(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
          },
        );
        killer.once("error", () => {
          try {
            child.kill("SIGKILL");
          } catch {
            // The process has already stopped.
          }
        });
        killer.unref();
      } else if (child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      // The process has already stopped.
    }
  }, 5_000);
  forceKill.unref();
}

async function runProgram(
  binary: string,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  await access(binary, constants.X_OK);
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stdoutBuffer = "";
    let cancelled = false;
    let eventChain = Promise.resolve();
    let settled = false;

    const cancellationTimer = setInterval(() => {
      void options
        .shouldCancel()
        .then((shouldCancel) => {
          if (!shouldCancel || cancelled || settled) return;
          cancelled = true;
          terminateProcessTree(child);
        })
        .catch(() => {
          // A transient control-plane outage must not terminate a data-plane backup.
        });
    }, 10_000);
    cancellationTimer.unref();

    const consumeLine = (line: string) => {
      if (!options.onJsonLine || !line.trim()) return;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          return;
        eventChain = eventChain.then(() =>
          options.onJsonLine!(parsed as Record<string, unknown>),
        );
      } catch {
        // Restic may emit non-JSON diagnostics. They are never forwarded to the control plane.
      }
    };

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout = appendBounded(stdout, text);
      stdoutBuffer += text;
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        consumeLine(line);
      }
    });
    child.stderr.on("data", (chunk) => {
      // Consume diagnostics so a child process cannot block on a full pipe. They
      // are deliberately never returned or forwarded: provider diagnostics can
      // include storage paths and credential-adjacent details.
      void chunk;
    });
    child.stdin.end(options.stdin || "");
    child.once("error", (error) => {
      settled = true;
      clearInterval(cancellationTimer);
      reject(error);
    });
    child.once("close", (code: number | null) => {
      settled = true;
      clearInterval(cancellationTimer);
      consumeLine(stdoutBuffer);
      void eventChain.then(
        () => {
          if (cancelled) return reject(new BackupCancelledError());
          if (code !== 0 && !options.allowFailure) {
            return reject(
              new Error(
                `Backup process exited with status ${code ?? "unknown"}.`,
              ),
            );
          }
          resolve({ code, stdout });
        },
        (error) => reject(error),
      );
    });
  });
}

function rcloneConfigValue(value: string): string {
  if (/[\r\n\x00]/.test(value))
    throw new Error("SFTP configuration contains an unsafe value.");
  return value;
}

async function writeTemporaryRcloneConfig(
  dataDir: string,
  options: Record<string, string>,
): Promise<{ directory: string; configPath: string }> {
  const directory = await mkdtemp(path.join(dataDir, "rclone-"));
  await chmod(directory, 0o700);
  const configPath = path.join(directory, "rclone.conf");
  const lines = ["[pluton]", "type = sftp"];
  for (const key of Object.keys(options).sort()) {
    lines.push(`${key} = ${rcloneConfigValue(options[key])}`);
  }
  await writeFile(configPath, `${lines.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(configPath, 0o600);
  return { directory, configPath };
}

async function obscureSensitiveSftpOptions(
  rclone: string,
  options: Record<string, string>,
  env: NodeJS.ProcessEnv,
  shouldCancel: () => Promise<boolean>,
): Promise<Record<string, string>> {
  const obscured = { ...options };
  for (const key of ["pass", "key_file_pass"]) {
    if (!obscured[key]) continue;
    const result = await runProgram(rclone, ["obscure", "-"], {
      env,
      stdin: `${obscured[key]}\n`,
      shouldCancel,
    });
    const value = result.stdout.trim();
    if (!value || /[\r\n\x00]/.test(value)) {
      throw new Error(
        "Could not prepare the SFTP authentication configuration.",
      );
    }
    obscured[key] = value;
  }
  return obscured;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function summaryFromRestic(
  value: Record<string, unknown>,
): ResticSummary | null {
  if (
    value.message_type !== "summary" ||
    typeof value.snapshot_id !== "string" ||
    !/^[A-Fa-f0-9]{8,128}$/.test(value.snapshot_id)
  ) {
    return null;
  }
  return {
    message_type: "summary",
    files_new: numeric(value.files_new),
    files_changed: numeric(value.files_changed),
    files_unmodified: numeric(value.files_unmodified),
    dirs_new: numeric(value.dirs_new),
    dirs_changed: numeric(value.dirs_changed),
    dirs_unmodified: numeric(value.dirs_unmodified),
    data_blobs: numeric(value.data_blobs),
    tree_blobs: numeric(value.tree_blobs),
    data_added: numeric(value.data_added),
    data_added_packed: numeric(value.data_added_packed),
    total_files_processed: numeric(value.total_files_processed),
    total_bytes_processed: numeric(value.total_bytes_processed),
    total_duration: numeric(value.total_duration),
    snapshot_id: value.snapshot_id.slice(0, 128),
  };
}

function progressFromRestic(
  value: Record<string, unknown>,
): Record<string, unknown> | null {
  if (value.message_type !== "status") return null;
  return {
    phase: "running",
    progress: {
      bytesProcessed: numeric(value.bytes_processed),
      filesProcessed: numeric(value.files_processed),
      totalBytesProcessed: numeric(value.total_bytes_processed),
      totalFilesProcessed: numeric(value.total_files_processed),
    },
  };
}

async function ensureManagedRepository(
  payload: BackupFilesystemPayload,
  restic: string,
  rclone: string,
  repository: string,
  resticEnv: NodeJS.ProcessEnv,
  rcloneEnv: NodeJS.ProcessEnv,
  shouldCancel: () => Promise<boolean>,
): Promise<void> {
  if (!payload.repository.initialize) return;
  const snapshots = await runProgram(
    restic,
    ["-r", repository, "snapshots", "--json"],
    {
      env: resticEnv,
      allowFailure: true,
      shouldCancel,
    },
  );
  if (snapshots.code === 0) return;

  const listing = await runProgram(
    rclone,
    ["lsf", `${payload.repository.remoteName}:${payload.repository.path}`],
    {
      env: rcloneEnv,
      allowFailure: true,
      shouldCancel,
    },
  );
  if (listing.code !== 0) {
    throw new Error(
      "Could not verify that the managed repository target is empty.",
    );
  }
  if (listing.stdout.trim()) {
    throw new Error(
      "Managed repository target is not empty; refusing to initialize it.",
    );
  }

  try {
    await runProgram(restic, ["-r", repository, "init"], {
      env: resticEnv,
      shouldCancel,
    });
  } catch (error) {
    // A lost completion response can cause an idempotent retry after `init`
    // succeeded. Accept it only when this exact password can open the repo.
    const retry = await runProgram(
      restic,
      ["-r", repository, "snapshots", "--json"],
      {
        env: resticEnv,
        allowFailure: true,
        shouldCancel,
      },
    );
    if (retry.code !== 0) throw error;
  }
}

function summaryForExistingSnapshot(snapshotId: string): ResticSummary {
  return {
    message_type: "summary",
    files_new: 0,
    files_changed: 0,
    files_unmodified: 0,
    dirs_new: 0,
    dirs_changed: 0,
    dirs_unmodified: 0,
    data_blobs: 0,
    tree_blobs: 0,
    data_added: 0,
    data_added_packed: 0,
    total_files_processed: 0,
    total_bytes_processed: 0,
    total_duration: 0,
    snapshot_id: snapshotId,
  };
}

/**
 * If an earlier successful Restic run lost its completion ACK, the durable
 * command can be leased again. Reuse the snapshot tagged with its stable
 * backup ID rather than creating a second unrelated snapshot.
 */
async function findExistingBackupSnapshot(
  restic: string,
  repository: string,
  backupId: string,
  env: NodeJS.ProcessEnv,
  shouldCancel: () => Promise<boolean>,
): Promise<BackupFilesystemResult | null> {
  const result = await runProgram(
    restic,
    [
      "-r",
      repository,
      "snapshots",
      "--json",
      "--tag",
      `pluton-backup-${backupId}`,
    ],
    {
      env,
      allowFailure: true,
      shouldCancel,
    },
  );
  if (result.code !== 0 || !result.stdout.trim()) return null;
  try {
    const snapshots = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(snapshots)) return null;
    const snapshot = snapshots
      .slice()
      .reverse()
      .find((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          return false;
        const id = (value as Record<string, unknown>).id;
        return typeof id === "string" && /^[a-f0-9]{8,128}$/i.test(id);
      });
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
      return null;
    const snapshotId = (snapshot as Record<string, unknown>).id as string;
    return { snapshotId, summary: summaryForExistingSnapshot(snapshotId) };
  } catch {
    // Treat malformed tool output as a non-match. Repository initialization
    // below remains fail-closed if the target is not a valid managed repo.
    return null;
  }
}

export async function executeFilesystemBackup(input: {
  payload: Record<string, unknown>;
  config: AgentConfig;
  allowedRoots: string[];
  shouldCancel: () => Promise<boolean>;
  onEvent: (event: Record<string, unknown>) => Promise<void>;
}): Promise<BackupFilesystemResult> {
  const payload = parseBackupFilesystemPayload(input.payload);
  const source = await assertPathWithinAllowedRoots(
    payload.sourcePath,
    input.allowedRoots,
  );
  await assertSourceDoesNotOverlapState(source, input.config.dataDir);
  if (await input.shouldCancel()) throw new BackupCancelledError();

  const restic = privateBinaryPath(input.config.binDir, "restic");
  const rclone = privateBinaryPath(input.config.binDir, "rclone");
  await Promise.all([
    access(restic, constants.X_OK),
    access(rclone, constants.X_OK),
  ]);

  let temporary: { directory: string; configPath: string } | undefined;
  try {
    const env: NodeJS.ProcessEnv = {
      PATH: `${path.dirname(restic)}${path.delimiter}${process.env.PATH || ""}`,
      RESTIC_PASSWORD: payload.repositoryPassword,
      RESTIC_CACHE_DIR: path.join(input.config.dataDir, "restic-cache"),
    };
    const rcloneEnv: NodeJS.ProcessEnv = { PATH: env.PATH };
    const rcloneOptions = await obscureSensitiveSftpOptions(
      rclone,
      payload.rclone.options,
      rcloneEnv,
      input.shouldCancel,
    );
    temporary = await writeTemporaryRcloneConfig(
      input.config.dataDir,
      rcloneOptions,
    );
    env.RCLONE_CONFIG = temporary.configPath;
    rcloneEnv.RCLONE_CONFIG = temporary.configPath;
    const repository = `rclone:${payload.repository.remoteName}:${payload.repository.path}`;
    const existing = await findExistingBackupSnapshot(
      restic,
      repository,
      payload.backupId,
      env,
      input.shouldCancel,
    );
    if (existing) return existing;
    await ensureManagedRepository(
      payload,
      restic,
      rclone,
      repository,
      env,
      rcloneEnv,
      input.shouldCancel,
    );

    let summary: ResticSummary | null = null;
    let lastProgress = 0;
    const args = [
      "-r",
      repository,
      "backup",
      source,
      "--json",
      "--tag",
      `pluton-plan-${payload.planId}`,
      "--tag",
      `pluton-backup-${payload.backupId}`,
    ];
    for (const exclude of payload.excludes) args.push("--exclude", exclude);
    await runProgram(restic, args, {
      env,
      shouldCancel: input.shouldCancel,
      onJsonLine: async (event) => {
        const parsedSummary = summaryFromRestic(event);
        if (parsedSummary) {
          summary = parsedSummary;
          return;
        }
        const progress = progressFromRestic(event);
        if (!progress || Date.now() - lastProgress < PROGRESS_INTERVAL_MS)
          return;
        lastProgress = Date.now();
        await input.onEvent(progress);
      },
    });
    if (!summary)
      throw new Error("Restic completed without a snapshot summary.");
    // TypeScript cannot observe the assignment performed by the async JSON-line
    // callback, but runProgram awaits that callback chain before returning.
    const completedSummary = summary as ResticSummary;
    return {
      snapshotId: completedSummary.snapshot_id,
      summary: completedSummary,
    };
  } finally {
    if (temporary)
      await rm(temporary.directory, { recursive: true, force: true });
  }
}

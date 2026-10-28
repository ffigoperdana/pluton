import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import {
  buildWorker,
  assertWorkerBundle,
} from "../build-mysql-recovery-worker.mjs";
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { build } = require("esbuild");

function readinessDiagnostics(result, durationMs) {
  // Never include Error.message, stdout or stderr. Only closed labels and
  // bounded numeric metadata may cross this subprocess/security boundary.
  const codes = new Set([
    "E2BIG",
    "EACCES",
    "EAGAIN",
    "EINVAL",
    "EMFILE",
    "ENFILE",
    "ENOENT",
    "ENOMEM",
    "ENOBUFS",
    "EPERM",
    "ETIMEDOUT",
    "UNKNOWN",
  ]);
  const code = result.error
    ? codes.has(result.error.code)
      ? result.error.code
      : "other"
    : "none";
  const signal = result.signal
    ? Object.hasOwn(constants.signals, result.signal)
      ? result.signal
      : "other"
    : "none";
  const status = Number.isInteger(result.status) ? result.status : "none";
  const scenarios =
    "ready|delayed|exit|configuration|native-client|module-loading|oom|permission|timeout|stale-socket";
  const progressPattern = new RegExp(
    `^READINESS scenario=(${scenarios}) profile=(normal|busy) polls=\\d{1,3} delays=\\d{1,3} virtual-ms=\\d{1,5} wall-ms=\\d{1,7}$`,
  );
  const failurePattern = new RegExp(
    `^READINESS failure scenario=(${scenarios}) profile=(normal|busy) check=(valid-startup|expected-category|safe-diagnostic|poll-count|delay-count|virtual-time|deadline|unexpected-error)$`,
  );
  const records = (typeof result.stdout === "string" ? result.stdout : "")
    .split(/\r?\n/)
    .filter((line) => progressPattern.test(line) || failurePattern.test(line));
  const assertionFailed = records.some((line) => failurePattern.test(line));
  const outcome =
    code === "ETIMEDOUT"
      ? "timeout"
      : result.error
        ? "spawn-error"
        : result.signal
          ? "signal-termination"
          : result.status === 0
            ? "success"
            : assertionFailed
              ? "assertion-failure"
              : "nonzero-exit";
  const elapsed = Number.isFinite(durationMs)
    ? Math.min(3600000, Math.max(0, Math.round(durationMs)))
    : 0;
  return `Readiness driver: outcome=${outcome}; code=${code}; signal=${signal}; status=${status}; duration-ms=${elapsed}; last=${records.at(-1) ?? "none"}. Raw subprocess output withheld.`;
}

test("readiness subprocess diagnostics distinguish failures without exposing captured output or error messages", () => {
  const privateOutput = "synthetic-private-provider-output synthetic-password";
  for (const [fields, outcome] of [
    [
      {
        status: null,
        signal: "SIGTERM",
        error: { code: "ETIMEDOUT", message: privateOutput },
      },
      "timeout",
    ],
    [{ status: 143, signal: null, error: { code: "ETIMEDOUT" } }, "timeout"],
    [
      { status: null, error: { code: "ENOENT", message: privateOutput } },
      "spawn-error",
    ],
    [
      { status: null, error: { code: "ENOBUFS", message: privateOutput } },
      "spawn-error",
    ],
    [{ status: null, signal: "SIGKILL" }, "signal-termination"],
    [
      {
        status: 1,
        stdout:
          "READINESS failure scenario=delayed profile=busy check=valid-startup",
      },
      "assertion-failure",
    ],
    [{ status: 1 }, "nonzero-exit"],
    [{ status: 0 }, "success"],
    [
      { status: null, signal: privateOutput, error: { code: privateOutput } },
      "spawn-error",
    ],
  ]) {
    const diagnostic = readinessDiagnostics(
      { stdout: privateOutput, stderr: privateOutput, ...fields },
      1234.5,
    );
    assert(diagnostic.includes(`outcome=${outcome};`));
    assert(diagnostic.includes("duration-ms=1235;"));
    assert(
      !diagnostic.includes("synthetic-private") &&
        !diagnostic.includes("synthetic-password"),
    );
    assert(diagnostic.length < 512);
  }
  const diagnostic = readinessDiagnostics(
    {
      status: null,
      error: { code: "ETIMEDOUT" },
      stdout:
        "READINESS scenario=delayed profile=normal polls=3 delays=2 virtual-ms=500 wall-ms=18\n" +
        privateOutput,
    },
    20002,
  );
  assert(
    diagnostic.includes(
      "code=ETIMEDOUT; signal=none; status=none; duration-ms=20002;",
    ),
  );
  assert(
    diagnostic.includes(
      "last=READINESS scenario=delayed profile=normal polls=3",
    ),
  );
  assert(!diagnostic.includes(privateOutput));
});

test("actual standalone worker graph excludes the managed index/native SQLite and reaches guarded configuration", async () => {
  const result = await buildWorker();
  assert(
    !Object.keys(result.metafile.inputs).some((file) =>
      /ManagedSnapshotIndex|better-sqlite3|bindings/.test(file),
    ),
  );
  assert(!result.outputFiles[0].text.includes("Dynamic require of"));
  const executed = spawnSync(
    process.execPath,
    ["mysql-worker-dist/worker.mjs"],
    {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4096,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    },
  );
  assert.equal(executed.status, 1);
  assert.equal(executed.stdout, "");
  assert.equal(
    executed.stderr.trim(),
    JSON.stringify({
      event: "mysql-worker-startup",
      stage: "configuration",
      status: "refused",
    }),
  );
});
test("reinstating the incident runtime import reproduces the graph regression and is refused before artifact publication", async () => {
  const result = await build({
    entryPoints: ["backend/src/mysql-worker/index.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    write: false,
    metafile: true,
    plugins: [
      {
        name: "reproduce-incident",
        setup(builder) {
          builder.onLoad(
            { filter: /[\\/]utils[\\/]recoveryValidation\.ts$/ },
            async (args) => {
              const source = await fs.readFile(args.path, "utf8");
              assert(source.includes("import type { ManagedSnapshotIndex }"));
              return {
                contents: source
                  .replace(
                    "import type { ManagedSnapshotIndex }",
                    "import { ManagedSnapshotIndex }",
                  )
                  .replace(
                    "!Array.isArray(files)",
                    "files instanceof ManagedSnapshotIndex",
                  ),
                loader: "ts",
              };
            },
          );
        },
      },
    ],
  });
  assert(
    Object.keys(result.metafile.inputs).some((file) =>
      file.includes("better-sqlite3"),
    ),
  );
  assert.throws(
    () => assertWorkerBundle(result),
    /unsupported native\/CommonJS/,
  );
});
test("worker graph gate refuses unresolved packages and executable CommonJS shims", () => {
  const result = {
    metafile: {
      inputs: {},
      outputs: {
        "worker.mjs": {
          imports: [{ external: true, path: "unreviewed-package" }],
        },
      },
    },
    outputFiles: [{ text: "export {};" }],
  };
  assert.throws(() => assertWorkerBundle(result), /external package/);
  result.metafile.outputs["worker.mjs"].imports = [
    { external: true, path: "node:fs" },
  ];
  assert.doesNotThrow(() => assertWorkerBundle(result));
  result.outputFiles[0].text = "Dynamic require of";
  assert.throws(() => assertWorkerBundle(result), /CommonJS/);
});
test("bounded readiness distinguishes safe startup stages and never emits captured provider contents", () => {
  const started = performance.now();
  const result = spawnSync(
    process.platform === "win32" ? "pwsh.exe" : "pwsh",
    ["-NoProfile", "-File", "scripts/__tests__/mysqlWorkerReadiness.test.ps1"],
    { encoding: "utf8", timeout: 20000, maxBuffer: 8192 },
  );
  const diagnostic = readinessDiagnostics(result, performance.now() - started);
  assert.equal(result.status, 0, diagnostic);
  assert(
    /PASS bounded worker startup diagnostics/.test(result.stdout),
    diagnostic,
  );
  assert(
    !/synthetic-private-provider-output|synthetic-password/.test(
      result.stdout + result.stderr,
    ),
    diagnostic,
  );
});

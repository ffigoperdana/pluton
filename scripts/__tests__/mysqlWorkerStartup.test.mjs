import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  buildWorker,
  assertWorkerBundle,
} from "../build-mysql-recovery-worker.mjs";
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { build } = require("esbuild");

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
  const result = spawnSync(
    process.platform === "win32" ? "pwsh.exe" : "pwsh",
    ["-NoProfile", "-File", "scripts/__tests__/mysqlWorkerReadiness.test.ps1"],
    { encoding: "utf8", timeout: 20000, maxBuffer: 8192 },
  );
  assert.equal(
    result.status,
    0,
    "Readiness regression driver must pass; raw subprocess output withheld.",
  );
  assert.match(result.stdout, /PASS bounded worker startup diagnostics/);
  assert(
    !/synthetic-private-provider-output|synthetic-password/.test(
      result.stdout + result.stderr,
    ),
  );
});

import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BackupFilesystemError,
  executeFilesystemBackup,
  parseBackupFilesystemPayload,
  writeTemporaryRcloneConfig,
} from "./backupFilesystem.js";

const validPayload = {
  version: 1,
  backupId: "backup-01",
  planId: "plan-01",
  sourcePath: "/srv/example-app",
  excludes: [],
  repository: {
    remoteName: "pluton",
    path: "managed-repositories/example",
    initialize: true,
  },
  rclone: {
    type: "sftp",
    options: {
      host: "sftp.example.internal",
      port: "22",
      user: "backup-user",
      pass: "this-is-a-test-only-password-value",
    },
  },
  repositoryPassword: "test-only-repository-password-value",
};

test("accepts the fixed BACKUP_FILESYSTEM envelope", () => {
  const parsed = parseBackupFilesystemPayload(validPayload);
  assert.equal(parsed.sourcePath, "/srv/example-app");
  assert.deepEqual(parsed.rclone.options, validPayload.rclone.options);
});

test("refuses external-SSH and generic-command SFTP options", () => {
  assert.throws(
    () =>
      parseBackupFilesystemPayload({
        ...validPayload,
        rclone: {
          ...validPayload.rclone,
          options: {
            ...validPayload.rclone.options,
            ssh: "ssh -o ProxyCommand=unsafe",
          },
        },
      }),
    /unsupported option/,
  );
});

test("refuses traversal, control characters, and unexpected command fields", () => {
  assert.throws(
    () =>
      parseBackupFilesystemPayload({
        ...validPayload,
        repository: { ...validPayload.repository, path: "managed/../other" },
      }),
    /traversal/,
  );
  assert.throws(
    () =>
      parseBackupFilesystemPayload({
        ...validPayload,
        sourcePath: "/srv/example\u0000app",
      }),
    /invalid/,
  );
  assert.throws(
    () =>
      parseBackupFilesystemPayload({
        ...validPayload,
        arbitraryShell: "never",
      }),
    /unsupported fields/,
  );
});

const permissionTest = process.platform === "win32" ? test.skip : test;

permissionTest("creates a private temporary Rclone config", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pluton-agent-config-"));
  try {
    const temporary = await writeTemporaryRcloneConfig(dataDir, {
      host: "sftp.example.internal",
      pass: "obscured-test-password",
      user: "backup-user",
    });
    const directoryMode = (await stat(temporary.directory)).mode & 0o777;
    const fileMode = (await stat(temporary.configPath)).mode & 0o777;
    const contents = await readFile(temporary.configPath, "utf8");
    assert.equal(directoryMode, 0o700);
    assert.equal(fileMode, 0o600);
    assert.match(contents, /type = sftp/);
    assert.match(contents, /pass = obscured-test-password/);
    await rm(temporary.directory, { recursive: true, force: true });
    await assert.rejects(() => stat(temporary.directory));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

/** The real agent runs on Linux; executable shebang fixtures are not portable on Windows. */
const linuxExecutionTest = process.platform === "win32" ? test.skip : test;

async function createExecutionFixture(
  listing: string,
  exitCode = 0,
  diagnostics = "",
): Promise<{
  root: string;
  source: string;
  dataDir: string;
  binDir: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pluton-agent-execution-"));
  const source = path.join(root, "source");
  const dataDir = path.join(root, "state");
  const binDir = path.join(root, "bin");
  await Promise.all([mkdir(source), mkdir(dataDir), mkdir(binDir)]);
  const rclone = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const config = process.env.RCLONE_CONFIG || "";
const state = config ? path.dirname(path.dirname(config)) : "";
const log = state ? path.join(state, "rclone.calls") : "";
if (log) appendFileSync(log, JSON.stringify(args) + "\\n");
if (args[0] === "obscure") {
  let input = "";
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => process.stdout.write("obscured-test-value\\n"));
} else if (args[0] === "lsf") {
  const contents = readFileSync(config, "utf8");
  if (state) appendFileSync(path.join(state, "rclone.config-check"), contents.includes("obscured-test-value") ? "obscured\\n" : "plaintext\\n");
  process.stdout.write(${JSON.stringify(listing)});
  process.stderr.write(${JSON.stringify(diagnostics)});
  process.exitCode = ${exitCode};
}
`;
  const restic = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const config = process.env.RCLONE_CONFIG || "";
const state = config ? path.dirname(path.dirname(config)) : "";
const log = state ? path.join(state, "restic-calls") : "";
if (log) appendFileSync(log, JSON.stringify(args) + "\\n");
if (args.includes("snapshots")) process.exit(1);
if (args.includes("init")) process.exit(0);
if (args.includes("backup")) process.stdout.write(JSON.stringify({message_type:"summary",snapshot_id:"abcdef0123456789",files_new:0,files_changed:0,files_unmodified:0,dirs_new:0,dirs_changed:0,dirs_unmodified:0,data_blobs:0,tree_blobs:0,data_added:0,data_added_packed:0,total_files_processed:0,total_bytes_processed:0,total_duration:0}) + "\\n");
`;
  await writeFile(path.join(binDir, "rclone"), rclone);
  await writeFile(path.join(binDir, "restic"), restic);
  await Promise.all([
    chmod(path.join(binDir, "rclone"), 0o755),
    chmod(path.join(binDir, "restic"), 0o755),
  ]);
  return { root, source, dataDir, binDir };
}

function executionInput(
  fixture: Awaited<ReturnType<typeof createExecutionFixture>>,
) {
  return {
    payload: { ...validPayload, sourcePath: fixture.source },
    config: {
      serverUrl: new URL("https://example.invalid"),
      dataDir: fixture.dataDir,
      allowedRoots: [fixture.source],
      binDir: fixture.binDir,
      allowInsecureHttp: false,
    },
    allowedRoots: [fixture.source],
    shouldCancel: async () => false,
    onEvent: async () => undefined,
  };
}

async function readCalls(file: string): Promise<string[][]> {
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

linuxExecutionTest(
  "reports a non-empty managed target before Restic init or backup",
  async () => {
    const fixture = await createExecutionFixture("repo\n");
    const stages: string[] = [];
    try {
      await assert.rejects(
        () =>
          executeFilesystemBackup({
            ...executionInput(fixture),
            onStage: (event) => stages.push(`${event.stage}:${event.message}`),
          }),
        (error) => {
          assert.ok(error instanceof BackupFilesystemError);
          assert.equal(error.stage, "repository-target-check");
          assert.equal(error.code, "repository-target-not-empty");
          return true;
        },
      );
      assert.ok(stages.includes("source-validation:source validated"));
      assert.ok(
        stages.includes(
          "temporary-storage-config:temporary storage config created",
        ),
      );
      assert.ok(stages.includes("repository-check:repository check started"));
      const resticCalls = await readCalls(
        path.join(fixture.dataDir, "restic-calls"),
      );
      const rcloneCalls = await readCalls(
        path.join(fixture.dataDir, "rclone.calls"),
      );
      assert.ok(rcloneCalls.some((args) => args[0] === "lsf"));
      assert.equal(
        await readFile(
          path.join(fixture.dataDir, "rclone.config-check"),
          "utf8",
        ),
        "obscured\n",
      );
      assert.ok(resticCalls.some((args) => args.includes("snapshots")));
      assert.ok(!resticCalls.some((args) => args.includes("init")));
      assert.ok(!resticCalls.some((args) => args.includes("backup")));
      assert.deepEqual(
        (await readdir(fixture.dataDir)).filter((name) =>
          name.startsWith("rclone-"),
        ),
        [],
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

linuxExecutionTest(
  "initializes an empty managed target and reaches Restic backup",
  async () => {
    const fixture = await createExecutionFixture("");
    const stages: string[] = [];
    try {
      const result = await executeFilesystemBackup({
        ...executionInput(fixture),
        onStage: (event) => stages.push(`${event.stage}:${event.message}`),
      });
      assert.equal(result.snapshotId, "abcdef0123456789");
      assert.ok(stages.includes("repository-target-check:target-empty"));
      assert.ok(
        stages.includes(
          "repository-initialization:repository initialization started",
        ),
      );
      assert.ok(stages.includes("restic-backup:restic backup started"));
      assert.ok(stages.includes("restic-backup:backup completed"));
      const resticCalls = await readCalls(
        path.join(fixture.dataDir, "restic-calls"),
      );
      assert.ok(resticCalls.some((args) => args.includes("init")));
      assert.ok(resticCalls.some((args) => args.includes("backup")));
      assert.deepEqual(
        (await readdir(fixture.dataDir)).filter((name) =>
          name.startsWith("rclone-"),
        ),
        [],
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

linuxExecutionTest(
  "initializes a missing managed target instead of treating exit code 3 as fatal",
  async () => {
    const fixture = await createExecutionFixture(
      "",
      3,
      "Failed to lsf: directory not found\n",
    );
    const stages: string[] = [];
    try {
      await executeFilesystemBackup({
        ...executionInput(fixture),
        onStage: (event) => stages.push(`${event.stage}:${event.message}`),
      });
      assert.ok(stages.includes("repository-target-check:target-not-found"));
      const resticCalls = await readCalls(
        path.join(fixture.dataDir, "restic-calls"),
      );
      const rcloneCalls = await readCalls(
        path.join(fixture.dataDir, "rclone.calls"),
      );
      assert.deepEqual(rcloneCalls, [
        ["lsf", "pluton:managed-repositories/example"],
      ]);
      assert.ok(
        resticCalls.some(
          (args) =>
            args.includes("init") &&
            args[1] === "rclone:pluton:managed-repositories/example",
        ),
      );
      assert.ok(resticCalls.some((args) => args.includes("backup")));
      assert.deepEqual(
        (await readdir(fixture.dataDir)).filter((name) =>
          name.startsWith("rclone-"),
        ),
        [],
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  },
);

for (const scenario of [
  {
    name: "authentication",
    diagnostics:
      "ssh: handshake failed: ssh: unable to authenticate, attempted methods [none password], no supported methods remain",
    code: "target-check-auth-failed",
  },
  {
    name: "permission",
    diagnostics: "error listing target: permission denied",
    code: "target-check-access-failed",
  },
  {
    name: "transport",
    diagnostics: "dial tcp: connection refused",
    code: "target-check-transport-failed",
  },
  {
    name: "malformed configuration",
    diagnostics: "config section not found",
    code: "repository-target-check-failed",
  },
]) {
  linuxExecutionTest(
    `refuses init on ${scenario.name} failure and cleans up credentials`,
    async () => {
      const fixtureSecret = "synthetic-provider-secret-marker";
      const fixture = await createExecutionFixture(
        "",
        1,
        `${scenario.diagnostics}: ${fixtureSecret}\n`,
      );
      const stages: string[] = [];
      try {
        await assert.rejects(
          () =>
            executeFilesystemBackup({
              ...executionInput(fixture),
              onStage: (event) =>
                stages.push(`${event.stage}:${event.message}`),
            }),
          (error) => {
            assert.ok(error instanceof BackupFilesystemError);
            assert.equal(error.stage, "repository-target-check");
            assert.equal(error.code, scenario.code);
            assert.ok(!error.message.includes(fixtureSecret));
            assert.ok(!JSON.stringify(error).includes(fixtureSecret));
            return true;
          },
        );
        const calls = await readCalls(
          path.join(fixture.dataDir, "restic-calls"),
        );
        assert.ok(
          !calls.some(
            (args) => args.includes("init") || args.includes("backup"),
          ),
        );
        assert.ok(
          !stages.some(
            (stage) =>
              stage.includes("target-empty") ||
              stage.includes("target-not-found"),
          ),
        );
        assert.ok(!JSON.stringify(stages).includes(fixtureSecret));
        assert.deepEqual(
          (await readdir(fixture.dataDir)).filter((name) =>
            name.startsWith("rclone-"),
          ),
          [],
        );
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
  );
}

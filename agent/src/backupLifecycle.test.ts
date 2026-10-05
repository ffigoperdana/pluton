import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  stat,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import {
  executeFilesystemBackup,
  BackupFilesystemError,
} from "./backupFilesystem.js";
import { BackupLifecycleJob } from "./backupLifecycle.js";
import {
  detectDatabaseBinary,
  parseBackupLifecycle,
  validateHookExecutable,
  type BackupLifecycle,
} from "./lifecyclePolicy.js";
import type { AgentConfig } from "./types.js";

const database = {
  engine: "mariadb" as const,
  host: "localhost",
  port: 3306,
  tls: "local" as const,
  database: "example_db",
  username: "backup_reader",
  password: "test-only-db-secret",
  dumpFilename: "app.sql",
  timeoutSeconds: 5,
  maxDumpBytes: 1024 * 1024,
  includeRoutines: false,
  includeEvents: false,
};
const lifecycle: BackupLifecycle = {
  version: 1,
  database,
  preHook: { id: "prepare", args: ["app-01"], timeoutSeconds: 5 },
  postHook: { id: "cleanup", args: [], timeoutSeconds: 5 },
};
const tools = process.env.PLUTON_PHASE5_TEST_TOOLS;
const executionTest =
  process.platform === "linux" && tools && process.getuid?.() !== 0
    ? test
    : test.skip;

test("lifecycle payload is declarative and rejects shell fields, path escapes, option injection and nonlocal plaintext DB", () => {
  assert.deepEqual(parseBackupLifecycle(lifecycle), lifecycle);
  assert.equal(
    parseBackupLifecycle({
      ...lifecycle,
      database: { ...database, host: "::1" },
    }).database?.host,
    "::1",
  );
  for (const bad of [
    { ...lifecycle, command: "sh" },
    { ...lifecycle, database: { ...database, flags: ["--force"] } },
    { ...lifecycle, database: { ...database, host: "db.example.internal" } },
    { ...lifecycle, database: { ...database, dumpFilename: "../app.sql" } },
  ])
    assert.throws(() => parseBackupLifecycle(bad));
  for (const id of ["../prepare", "/bin/sh", "folder/prepare", "$(command)"])
    assert.throws(() =>
      parseBackupLifecycle({
        version: 1,
        preHook: { id, args: [], timeoutSeconds: 5 },
      }),
    );
  for (const arg of [
    "$(id)",
    "curl | sh",
    "`id`",
    "../etc",
    "/etc/passwd",
    "--command",
    "x\nsecret",
  ])
    assert.throws(() =>
      parseBackupLifecycle({
        version: 1,
        preHook: { id: "prepare", args: [arg], timeoutSeconds: 5 },
      }),
    );
});

async function fixture(patch: Partial<BackupLifecycle> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pluton-phase5-"));
  const source = path.join(root, "source");
  const dataDir = path.join(root, "state");
  await mkdir(source);
  await mkdir(dataDir, { mode: 0o700 });
  await writeFile(
    path.join(source, "example.txt"),
    "unchanged application fixture",
  );
  const config: AgentConfig = {
    serverUrl: new URL("https://example.invalid"),
    dataDir,
    allowedRoots: [source],
    allowInsecureHttp: false,
    binDir: path.join(tools!, "bin"),
    databaseBinDirs: [path.join(tools!, "bin")],
    hookRoot: path.join(tools!, "hooks"),
  };
  const events: Record<string, unknown>[] = [];
  const input = {
    payload: {
      version: 2,
      backupId: "backup-01",
      planId: "plan-01",
      sourcePath: source,
      excludes: [],
      repository: {
        remoteName: "pluton",
        path: "managed/app-01",
        initialize: true,
      },
      rclone: {
        type: "sftp",
        options: {
          host: "sftp.example.internal",
          user: "backup_reader",
          pass: "test-only-sftp-password",
        },
      },
      repositoryPassword: "test-only-managed-repository-password",
      lifecycle: { ...lifecycle, ...patch },
    },
    config,
    allowedRoots: [source],
    shouldCancel: async () => false,
    onEvent: async (event: Record<string, unknown>) => {
      events.push(event);
    },
  };
  return { root, source, dataDir, config, input, events };
}
async function absent(file: string) {
  await assert.rejects(stat(file), { code: "ENOENT" });
}
async function calls(file: string) {
  try {
    return (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

for (const engine of ["mysql", "mariadb"] as const)
  executionTest(
    `${engine}: private dump + live source in one confirmed snapshot, cleanup and safe argv`,
    async () => {
      const f = await fixture({
        database: {
          ...database,
          engine,
          password: 'test-only-db-secret\\"\nline\tend',
        },
      });
      try {
        const result = await executeFilesystemBackup(f.input);
        assert.equal(result.snapshotId.length, 64);
        assert.equal(
          result.lifecycle?.database?.path,
          "/pluton/database/app.sql",
        );
        assert.equal(result.lifecycle?.database?.sha256.length, 64);
        assert.deepEqual(result.lifecycle?.warnings, []);
        const dumps = await calls(path.join(f.dataDir, "dump-calls"));
        assert.equal(dumps.length, 1);
        assert.equal(
          dumps[0].engine,
          engine === "mysql" ? "mysqldump" : "mariadb-dump",
        );
        assert.equal(dumps[0].mode, 0o600);
        assert.equal(
          dumps[0].args.some((arg: string) =>
            arg.includes("test-only-db-secret"),
          ),
          false,
        );
        const restic = await calls(path.join(f.dataDir, "restic-calls"));
        const backup = restic.find((args: string[]) => args.includes("backup"));
        assert.ok(backup.includes(f.source));
        assert.ok(backup.includes("pluton/database/app.sql"));
        assert.deepEqual(
          f.events.map((event) => event.lifecycleStage).filter(Boolean),
          [
            "pre-backup-started",
            "database-dump-started",
            "database-dump-completed",
            "backup-started",
            "backup-completed",
            "post-backup-started",
            "cleanup-completed",
          ],
        );
        assert.equal(
          await readFile(path.join(f.source, "example.txt"), "utf8"),
          "unchanged application fixture",
        );
        assert.deepEqual(await readdir(path.join(f.dataDir, "jobs")), []);
        await absent(dumps[0].workspace);
        assert.equal(
          JSON.stringify(result).includes("test-only-db-secret"),
          false,
        );
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    },
  );

for (const [name, code] of [
  ["auth_failure", "database-auth-failed"],
  ["unavailable", "database-unavailable"],
  ["slow_dump", "database-dump-timeout"],
  ["empty_dump", "database-dump-failed"],
  ["oversize", "database-dump-output-limit"],
] as const)
  executionTest(
    `${name}: blocks backup, classifies without secrets, post and cleanup still run`,
    async () => {
      const f = await fixture({
        database: {
          ...database,
          database: name,
          timeoutSeconds: 1,
          maxDumpBytes: 1024,
        },
      });
      try {
        await assert.rejects(executeFilesystemBackup(f.input), (error) => {
          assert.ok(error instanceof BackupFilesystemError);
          assert.equal(error.code, code);
          assert.equal(error.message.includes("test-only-db-secret"), false);
          return true;
        });
        assert.equal(
          (await calls(path.join(f.dataDir, "restic-calls"))).some(
            (args: string[]) => args.includes("backup"),
          ),
          false,
        );
        assert.equal(
          (await calls(path.join(f.dataDir, "hook-calls"))).at(-1).name,
          "cleanup",
        );
        assert.deepEqual(await readdir(path.join(f.dataDir, "jobs")), []);
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    },
  );

executionTest(
  "missing client and invalid/nonexecutable/symlink hooks fail before job or backup",
  async () => {
    assert.equal(detectDatabaseBinary("mysql", ["/nonexistent"]), undefined);
    const f = await fixture();
    try {
      const noClient = { ...f.config, databaseBinDirs: ["/nonexistent"] };
      await assert.rejects(
        BackupLifecycleJob.create(
          noClient,
          lifecycle,
          async () => false,
          async () => {},
        ),
        (error) =>
          (error as { code: string }).code === "database-tool-unavailable",
      );
      for (const id of [
        "link",
        "not-executable",
        "writable",
        "setuid",
        "../prepare",
        "/bin/sh",
      ])
        assert.throws(() =>
          validateHookExecutable(f.config.hookRoot!, {
            id,
            args: [],
            timeoutSeconds: 5,
          }),
        );
      await assert.rejects(
        BackupLifecycleJob.create(
          f.config,
          {
            ...lifecycle,
            preHook: { id: "link", args: [], timeoutSeconds: 5 },
          },
          async () => false,
          async () => {},
        ),
      );
      await absent(path.join(f.dataDir, "jobs"));
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

executionTest(
  "hook-only lifecycle confirms its filesystem snapshot without a DB dump",
  async () => {
    const f = await fixture({ database: undefined });
    try {
      const result = await executeFilesystemBackup(f.input);
      assert.equal(result.snapshotId.length, 64);
      assert.equal(result.lifecycle?.database, undefined);
      assert.deepEqual(result.lifecycle?.warnings, []);
      assert.deepEqual(await calls(path.join(f.dataDir, "dump-calls")), []);
      assert.deepEqual(
        (await calls(path.join(f.dataDir, "hook-calls"))).map(
          (value) => value.name,
        ),
        ["prepare", "cleanup"],
      );
      assert.deepEqual(await readdir(path.join(f.dataDir, "jobs")), []);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

executionTest(
  "pre failure prevents filesystem backup; post failure preserves completed snapshot with warning",
  async () => {
    const f = await fixture({
      preHook: { id: "fail", args: [], timeoutSeconds: 5 },
    });
    try {
      await assert.rejects(
        executeFilesystemBackup(f.input),
        (error) => (error as BackupFilesystemError).code === "hook-failed",
      );
      assert.equal(
        (await calls(path.join(f.dataDir, "restic-calls"))).some(
          (args: string[]) => args.includes("backup"),
        ),
        false,
      );
      f.input.payload.lifecycle = {
        ...lifecycle,
        postHook: { id: "fail", args: [], timeoutSeconds: 5 },
      };
      const result = await executeFilesystemBackup(f.input);
      assert.equal(result.snapshotId.length, 64);
      assert.deepEqual(result.lifecycle?.warnings, [
        { stage: "post-backup", code: "hook-failed" },
      ]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

executionTest(
  "backup failure cleans artifacts; retry creates a fresh workspace and does not reuse a dump",
  async () => {
    const f = await fixture();
    try {
      const failed = path.join(f.dataDir, "fail-backup");
      await writeFile(failed, "1");
      await assert.rejects(executeFilesystemBackup(f.input));
      const previous = (await calls(path.join(f.dataDir, "dump-calls")))[0]
        .workspace;
      await absent(previous);
      await rm(failed);
      await executeFilesystemBackup(f.input);
      const dumps = await calls(path.join(f.dataDir, "dump-calls"));
      assert.equal(dumps.length, 2);
      assert.notEqual(dumps[1].workspace, previous);
      const replay = await executeFilesystemBackup(f.input);
      assert.equal(replay.snapshotId.length, 64);
      assert.equal((await calls(path.join(f.dataDir, "dump-calls"))).length, 2);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

executionTest(
  "cancellation stops dump, runs bounded post cleanup, removes files and never starts backup",
  async () => {
    const f = await fixture({
      database: { ...database, database: "slow_dump", timeoutSeconds: 5 },
    });
    try {
      const started = Date.now();
      f.input.shouldCancel = async () => Date.now() - started > 300;
      await assert.rejects(
        executeFilesystemBackup(f.input),
        (error) => (error as BackupFilesystemError).code === "cancelled",
      );
      assert.deepEqual(await readdir(path.join(f.dataDir, "jobs")), []);
      assert.equal(
        (await calls(path.join(f.dataDir, "restic-calls"))).some(
          (args: string[]) => args.includes("backup"),
        ),
        false,
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

for (const [id, code] of [
  ["slow", "hook-timeout"],
  ["noisy", "hook-output-limit"],
] as const)
  executionTest(`${id} hook is bounded and blocks backup`, async () => {
    const f = await fixture({ preHook: { id, args: [], timeoutSeconds: 1 } });
    try {
      await assert.rejects(
        executeFilesystemBackup(f.input),
        (error) => (error as BackupFilesystemError).code === code,
      );
      assert.deepEqual(await readdir(path.join(f.dataDir, "jobs")), []);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

executionTest(
  "cleanup failure is a separate warning after a successful snapshot",
  async () => {
    const f = await fixture({
      postHook: { id: "dirty", args: [], timeoutSeconds: 5 },
    });
    try {
      const result = await executeFilesystemBackup(f.input);
      assert.equal(result.snapshotId.length, 64);
      assert.deepEqual(result.lifecycle?.warnings, [
        { stage: "cleanup", code: "cleanup-failed" },
      ]);
      const workspace = (await calls(path.join(f.dataDir, "dump-calls")))[0]
        .workspace;
      await chmod(path.join(workspace, "cleanup-test"), 0o700);
      assert.ok(
        f.events.some((event) => event.lifecycleStage === "cleanup-warning"),
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

executionTest(
  "cancellation terminates hook descendants, not just its parent",
  async () => {
    const f = await fixture({
      preHook: { id: "child", args: [], timeoutSeconds: 5 },
    });
    try {
      const started = Date.now();
      f.input.shouldCancel = async () => Date.now() - started > 400;
      await assert.rejects(
        executeFilesystemBackup(f.input),
        (error) => (error as BackupFilesystemError).code === "cancelled",
      );
      const pid = (
        await readFile(path.join(f.dataDir, "child-pid"), "utf8")
      ).trim();
      try {
        const status = await readFile(`/proc/${pid}/stat`, "utf8");
        assert.match(
          status,
          /\) Z /,
          "Only an unreaped zombie, never a running descendant, may remain.",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      assert.deepEqual(await readdir(path.join(f.dataDir, "jobs")), []);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

executionTest(
  "post cleanup keeps polling the lease but ignores cancellation and remains bounded",
  async () => {
    const f = await fixture();
    let polls = 0;
    try {
      const job = await BackupLifecycleJob.create(
        f.config,
        { version: 1, postHook: { id: "slow", args: [], timeoutSeconds: 2 } },
        async () => {
          polls += 1;
          return true;
        },
        async () => {},
      );
      await job.cleanup();
      assert.ok(
        polls >= 2,
        "Cleanup must refresh the command lease, not disable status polling.",
      );
      assert.deepEqual(job.report.warnings, [
        { stage: "post-backup", code: "hook-timeout" },
      ]);
      await absent(job.workspace);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

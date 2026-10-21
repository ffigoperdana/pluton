import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  writeFile,
  chmod,
  rm,
  symlink,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import {
  parseBackupExclusions,
  backupExclusionMatches,
  sourceResticExclusions,
} from "./backupExclusions.js";
import { preflightSource, SourceAccessError } from "./filesystemPolicy.js";
import { parseBackupFilesystemPayload } from "./backupFilesystem.js";

test("bounded relative matching distinguishes root anchoring, hidden names, directory entries and recursive components", () => {
  for (const [patterns, included, excluded] of [
    [
      [".git/", "node_modules/", ".cache/"],
      ["cache/x", "node_modules-old/x", "api/main.js"],
      [".git", "nested/.git/x", "node_modules", "a/node_modules/x", ".cache/x"],
    ],
    [
      ["*/cache/", "*/logs/"],
      ["cache/x", "a/b/cache/x"],
      ["a/cache", "a/cache/x", "b/logs/x"],
    ],
    [
      ["**/vendor/**", "*.tmp", "public/file?.txt"],
      ["api/main.js", "public/file10.txt"],
      ["vendor", "a/vendor/x", "nested/cache.tmp", "public/file1.txt"],
    ],
  ] as [string[], string[], string[]][]) {
    for (const name of included)
      assert.equal(backupExclusionMatches(patterns, name), false, name);
    for (const name of excluded)
      assert.equal(backupExclusionMatches(patterns, name), true, name);
  }
  assert.throws(() => parseBackupExclusions(["!node_modules"]));
  assert.equal(
    backupExclusionMatches(["*a".repeat(100) + "b"], "a".repeat(255)),
    false,
  );
});

const linux = process.platform === "linux" && process.getuid?.() !== 0;
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pluton-exclusions-"));
  const source = path.join(root, "source");
  await mkdir(source);
  const denied: string[] = [];
  t.after(async () => {
    for (const directory of denied) await chmod(directory, 0o700);
    await rm(root, { recursive: true, force: true });
  });
  for (const directory of [
    "api",
    "config",
    "public",
    "extensions",
    "build",
    "nested",
    ".git",
    "node_modules",
    ".cache",
    "nested/node_modules",
  ]) {
    await mkdir(path.join(source, directory), { recursive: true });
    await writeFile(
      path.join(source, directory, "entry"),
      `synthetic ${directory}`,
    );
  }
  for (const directory of [
    ".git",
    "node_modules",
    ".cache",
    "nested/node_modules",
  ]) {
    const name = path.join(source, directory);
    denied.push(name);
    await chmod(name, 0);
  }
  return { root, source };
}

test(
  "Linux excluded mode-000 directories are pruned; included denied files, root permissions and allowed-root checks still fail closed",
  { skip: !linux },
  async (t) => {
    const { root, source } = await fixture(t);
    const patterns = [".git/", "node_modules/", ".cache/"];
    await assert.rejects(
      preflightSource(source, [source], { scan: true }),
      (e: unknown) =>
        e instanceof SourceAccessError &&
        e.code === "source-entry-inaccessible",
    );
    const report = await preflightSource(source, [source], {
      scan: true,
      exclusions: patterns,
    });
    assert.equal(report.scan, "complete");
    assert.equal(report.entriesExcluded, 4);
    const fullPolicy = [
      ...patterns,
      ...Array.from({ length: 97 }, (_, index) => `ignored-${index}`),
    ];
    assert.equal(
      (
        await preflightSource(source, [source], {
          scan: true,
          exclusions: fullPolicy,
          mandatoryExclusions: ["**/.ssh", "**/.aws", "**/.gnupg", "**/.kube"],
        })
      ).scan,
      "complete",
    );
    const denied = path.join(source, "api/entry");
    await chmod(denied, 0);
    await assert.rejects(
      preflightSource(source, [source], { scan: true, exclusions: patterns }),
      (e: unknown) =>
        e instanceof SourceAccessError &&
        e.code === "source-entry-inaccessible",
    );
    await chmod(denied, 0o600);
    await symlink(
      path.join(root, "outside"),
      path.join(source, "outside-link"),
    );
    assert.equal(
      (
        await preflightSource(source, [source], {
          scan: true,
          exclusions: patterns,
        })
      ).linksNotFollowed,
      1,
    );
    await assert.rejects(
      preflightSource(source, [path.join(source, "public")], {
        exclusions: ["**"],
      }),
    );
    await chmod(source, 0);
    try {
      await assert.rejects(
        preflightSource(source, [source], { scan: true, exclusions: ["**"] }),
        (e: unknown) =>
          e instanceof SourceAccessError &&
          e.code === "source-root-not-readable",
      );
    } finally {
      await chmod(source, 0o700);
    }
  },
);

test(
  "Linux real Restic snapshot matches preflight exclusions and keeps separately generated SQL/metadata",
  { skip: !linux || !process.env.PLUTON_EXCLUSIONS_RESTIC },
  async (t) => {
    const { root, source } = await fixture(t),
      restic = process.env.PLUTON_EXCLUSIONS_RESTIC!;
    const workspace = path.join(root, "workspace"),
      repository = path.join(root, "repository");
    await mkdir(workspace);
    const sql = path.join(workspace, "app.sql"),
      metadata = path.join(workspace, "manifest.json");
    await writeFile(sql, "CREATE TABLE synthetic_table (id INT);");
    await writeFile(metadata, '{"synthetic":true}');
    await writeFile(path.join(source, "private.sql"), "synthetic source sql");
    const patterns = [
      ".git/",
      "node_modules/",
      ".cache/",
      "*.sql",
      "manifest.json",
    ];
    assert.equal(
      (
        await preflightSource(source, [source], {
          scan: true,
          exclusions: patterns,
        })
      ).scan,
      "complete",
    );
    const env = {
      ...process.env,
      RESTIC_PASSWORD: randomBytes(24).toString("hex"),
      RESTIC_CACHE_DIR: path.join(root, "cache"),
    };
    const run = (args: string[]) =>
      execFileSync(restic, ["-r", repository, ...args], {
        env,
        encoding: "utf8",
        timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    run(["init"]);
    const filters = sourceResticExclusions(source, patterns).flatMap(
      (pattern) => ["--exclude", pattern],
    );
    run(["backup", source, sql, metadata, "--json", ...filters]);
    const entries = run(["ls", "--json", "latest"])
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.struct_type === "node");
    const names = entries.map((entry) => entry.path);
    for (const directory of ["api", "config", "public", "extensions", "build"])
      assert(names.includes(`${source}/${directory}/entry`));
    for (const directory of [
      ".git",
      "node_modules",
      ".cache",
      "nested/node_modules",
    ])
      assert(
        !names.some(
          (name) =>
            name === `${source}/${directory}` ||
            name.startsWith(`${source}/${directory}/`),
        ),
      );
    assert(!names.includes(`${source}/private.sql`));
    assert(names.includes(sql));
    assert(names.includes(metadata));
    assert.throws(() => sourceResticExclusions(source, ["**/dir/**/cache"]));
    // Check the complete supported wildcard grammar against genuine Restic,
    // including directory entries and zero-directory ** matches.
    const matrix = path.join(root, "matrix");
    const matrixFiles = [
      "node_modules/a",
      "nested/node_modules/a",
      "cache/a",
      ".cache/a",
      "dir/cache/a",
      "dir/deep/cache/a",
      "public/file1.txt",
      "public/file12.txt",
      "vendor/lib",
      "a/vendor/lib",
      "unicode/μ.txt",
      "space dir/output.log",
    ];
    const matrixEntries = new Set<string>();
    for (const name of matrixFiles) {
      await mkdir(path.dirname(path.join(matrix, name)), { recursive: true });
      await writeFile(path.join(matrix, name), `synthetic ${name}`);
      let entry = name;
      while (entry !== ".") {
        matrixEntries.add(entry);
        entry = path.posix.dirname(entry);
      }
    }
    for (const selection of [
      ["node_modules/**"],
      ["**/node_modules/**"],
      ["*/cache/"],
      ["**/cache/"],
      [".cache/"],
      ["*.txt", "**/*.log"],
      ["public/file?.txt"],
      ["**/vendor/**"],
      ["unicode/?.txt"],
      ["space dir/"],
      ["dir/**/cache"],
      ["**"],
    ]) {
      const argumentsForSource = sourceResticExclusions(
        matrix,
        selection,
      ).flatMap((pattern) => ["--exclude", pattern]);
      run(["backup", matrix, "--json", ...argumentsForSource]);
      const selected = new Set(
        run(["ls", "--json", "latest"])
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .filter((entry) => entry.struct_type === "node")
          .map((entry) => entry.path),
      );
      for (const relative of matrixEntries)
        assert.equal(
          selected.has(`${matrix}/${relative}`),
          !backupExclusionMatches(selection, relative),
          JSON.stringify({ selection, relative }),
        );
    }
    await chmod(path.join(source, "api/entry"), 0);
    assert.throws(
      () => run(["backup", source, "--json", ...filters]),
      (error: unknown) => (error as { status: number }).status === 3,
    );
  },
);

test("v4 explicitly validates exclusions without changing legacy empty-exclusion envelopes", () => {
  const payload = {
    version: 1,
    backupId: "backup-01",
    planId: "plan-01",
    sourcePath: "/srv/example-app",
    excludes: [],
    repository: {
      remoteName: "pluton",
      path: "managed-repositories/example",
      initialize: false,
    },
    rclone: {
      type: "sftp",
      options: {
        host: "sftp.example.internal",
        user: "backup-user",
        pass: "synthetic-only",
      },
    },
    repositoryPassword: "synthetic-repository-fixture-password",
  };
  assert.equal(parseBackupFilesystemPayload(payload).version, 1);
  assert.deepEqual(
    parseBackupFilesystemPayload({
      ...payload,
      version: 4,
      excludes: [".git/"],
    }).excludes,
    [".git"],
  );
  const database = {
    engine: "mysql",
    host: "localhost",
    port: 3306,
    tls: "local",
    database: "example_db",
    username: "backup_reader",
    password: "synthetic-db-password",
    dumpFilename: "app.sql",
    timeoutSeconds: 30,
    maxDumpBytes: 1024 * 1024,
    includeRoutines: false,
    includeEvents: false,
  };
  for (const lifecycle of [
    { version: 1, database },
    { version: 2, databases: [{ ...database, databaseId: "db_one" }] },
  ]) {
    const parsed = parseBackupFilesystemPayload({
      ...payload,
      version: 4,
      excludes: ["*.sql"],
      lifecycle,
    });
    assert.equal(parsed.lifecycle?.version, lifecycle.version);
    assert(parsed.lifecycle);
  }
  assert.throws(() =>
    parseBackupFilesystemPayload({
      ...payload,
      version: 4,
      excludes: ["../outside"],
    }),
  );
  assert.throws(() =>
    parseBackupFilesystemPayload({
      ...payload,
      version: 4,
      arbitraryCommand: "not-supported",
    }),
  );
});

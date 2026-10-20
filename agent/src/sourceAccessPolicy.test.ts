import assert from "node:assert/strict";
import test from "node:test";
import { constants, type Stats } from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import {
  SourceAccessPolicy,
  SourcePolicyError,
  assertNonoverlappingRoots,
  isNewSourceRootAllowed,
  parseSourceAccessEnvironment,
  validateSourcePaths,
  type SourcePolicyIO,
} from "./sourceAccessPolicy.js";
import type { AgentConfig, AgentCommandEnvelope } from "./types.js";
import {
  appendSourceBackupExcludes,
  executeFilesystemBackup,
  BackupFilesystemError,
} from "./backupFilesystem.js";

type Entry = {
  uid: number;
  mode: number;
  directory?: boolean;
  link?: string;
  data: string;
  ino: number;
  mtime: number;
  nlink?: number;
};
function fixture() {
  let bootId = "synthetic-boot-01",
    uptimeMs = 10_000;
  let inode = 0;
  const entries = new Map<string, Entry>();
  const log: string[] = [];
  const denied = new Set<string>();
  let failDirectorySync = 0,
    directorySyncs = 0;
  let realpathHook: ((filename: string) => void) | undefined;
  const add = (
    filename: string,
    uid = 0,
    mode = 0o755,
    directory = true,
    data = "",
  ) => {
    entries.set(filename, {
      uid,
      mode,
      directory,
      data,
      ino: ++inode,
      mtime: 1,
    });
  };
  for (const filename of [
    "/",
    "/etc",
    "/etc/pluton-agent",
    "/srv",
    "/srv/example-app",
    "/srv/example-two",
    "/srv/example-three",
    "/var",
    "/var/www",
  ])
    add(filename);
  add("/state", 1001, 0o700);
  const errno = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error("synthetic filesystem refusal"), { code });
  const get = (filename: string) => {
    const entry = entries.get(filename);
    if (!entry) throw errno("ENOENT");
    return entry;
  };
  const stat = (entry: Entry): Stats =>
    ({
      uid: entry.uid,
      gid: entry.uid,
      mode: entry.mode,
      dev: 1,
      ino: entry.ino,
      mtimeMs: entry.mtime,
      size: Buffer.byteLength(entry.data),
      nlink: entry.nlink || 1,
      isDirectory: () => !!entry.directory,
      isFile: () => !entry.directory && !entry.link,
      isSymbolicLink: () => !!entry.link,
    }) as Stats;
  const io: SourcePolicyIO = {
    lstat: async (filename) => stat(get(filename)),
    realpath: async (filename) => {
      realpathHook?.(filename);
      if (denied.has(filename)) throw errno("EACCES");
      return get(filename).link || filename;
    },
    access: async (filename) => {
      get(filename);
      if (denied.has(filename)) throw errno("EACCES");
    },
    mkdir: async (filename, options) => {
      add(filename, 0, options.mode);
    },
    open: async (filename, flags, mode = 0o600) => {
      const numeric = typeof flags === "number" ? flags : 0;
      if (numeric & constants.O_CREAT) {
        if (entries.has(filename) && numeric & constants.O_EXCL)
          throw errno("EEXIST");
        if (!entries.has(filename))
          add(filename, filename.startsWith("/state/") ? 1001 : 0, mode, false);
      }
      const entry = get(filename);
      if (entry.link && numeric & constants.O_NOFOLLOW) throw errno("ELOOP");
      return {
        writeFile: async (value) => {
          entry.data = String(value);
          entry.mtime++;
          log.push(`write:${filename}`);
        },
        readFile: async () => entry.data,
        stat: async () => stat(entry),
        sync: async () => {
          log.push(`sync:${filename}`);
          if (entry.directory && ++directorySyncs === failDirectorySync)
            throw errno("EIO");
        },
        close: async () => undefined,
        chmod: async (mode) => {
          entry.mode =
            typeof mode === "string" ? Number.parseInt(mode, 8) : mode;
        },
        chown: async (uid) => {
          entry.uid = uid;
        },
      } as Awaited<ReturnType<SourcePolicyIO["open"]>>;
    },
    rename: async (oldPath, newPath) => {
      entries.set(newPath, get(oldPath));
      entries.delete(oldPath);
      log.push(`rename:${newPath}`);
    },
    unlink: async (filename) => {
      if (!entries.delete(filename)) throw errno("ENOENT");
      log.push(`unlink:${filename}`);
    },
    chmod: async (filename, mode) => {
      get(filename).mode = mode;
    },
  };
  const config: AgentConfig = {
    serverUrl: new URL("https://example.invalid"),
    dataDir: "/state",
    allowedRoots: ["/srv/example-app"],
    allowInsecureHttp: false,
  };
  const context = {
    config,
    agentId: "agent-01",
    io,
    platform: "linux",
    uid: 1001,
    bootClock: async () => ({ bootId, uptimeMs }),
  };
  const policy = () => new SourceAccessPolicy(context);
  const hostPolicy = () =>
    new SourceAccessPolicy({ ...context, operatorUid: 0 });
  const payload = async (roots: string[], id = "request_0001") => {
    const report = await policy().report();
    return {
      version: 1,
      requestId: id,
      expectedVersion: report.effectiveVersion,
      expectedHostPolicyRevision: report.hostPolicyRevision,
      roots,
    };
  };
  return {
    entries,
    log,
    denied,
    add,
    config,
    policy,
    coldPolicy: () => new SourceAccessPolicy({ ...context, io: { ...io } }),
    hostPolicy,
    payload,
    failSync: (at: number) => {
      failDirectorySync = at;
      directorySyncs = 0;
    },
    onRealpath: (fn: (filename: string) => void) => {
      realpathHook = fn;
    },
    boot: (value: string) => {
      bootId = value;
    },
    advanceUptime: (value: number) => {
      uptimeMs += value;
    },
  };
}

const modeSecret = "synthetic-mode-receipt-secret";
async function setupMode(
  f: ReturnType<typeof fixture>,
  mode: "host-approved" | "server-managed",
  roots: string[],
  id = "mode_request_0001",
) {
  const payload = {
    ...(await f.payload(roots, id)),
    authorizationMode: mode,
    expiresAt: Date.now() + 14 * 60_000,
  };
  const command: AgentCommandEnvelope = {
    id: `command_${id}`,
    type: "SOURCE_ACCESS_MODE_SETUP",
    payload,
    idempotencyKey: id,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    leaseToken: "synthetic-mode-lease-token-0001",
    signatureTimestamp: Date.now().toString(),
    signature: "",
  };
  command.signature = createHmac("sha256", modeSecret)
    .update(
      [
        "command",
        command.signatureTimestamp,
        command.id,
        command.type,
        JSON.stringify(payload),
        command.idempotencyKey,
        command.leaseToken,
        Date.parse(command.leaseExpiresAt!).toString(),
      ].join("\n"),
    )
    .digest("base64");
  const result = await f.policy().prepareModeSetup(command, modeSecret);
  return {
    command,
    result,
    local: {
      agentId: "agent-01",
      expectedRevision: payload.expectedHostPolicyRevision,
      requestId: id,
      authorizationMode: mode,
      roots,
      secret: modeSecret,
      confirmDelegation: mode === "server-managed",
      confirmDrained: true,
    },
  };
}

test("Server-Managed delegation is explicit local authority; bulk UI Apply then enables only readable canonical directories inside multiple prefixes", async () => {
  const f = fixture();
  f.add("/srv/example-two/app");
  f.add("/srv/example-three/app");
  assert.equal((await f.policy().report()).authorizationMode, "host-approved");
  const setup = await setupMode(f, "server-managed", [
    "/srv/example-two",
    "/srv/example-three",
  ]);
  assert.equal(setup.result.sourceAccess.authorizationMode, "host-approved");
  await assert.rejects(
    f.policy().changeAuthorizationMode(setup.local),
    /source-host-operator-required/,
  );
  await assert.rejects(
    f
      .hostPolicy()
      .changeAuthorizationMode({ ...setup.local, confirmDelegation: false }),
    /confirmation/,
  );
  await f.hostPolicy().changeAuthorizationMode(setup.local);
  let report = await f.policy().report();
  assert.equal(report.authorizationMode, "server-managed");
  assert.deepEqual(report.delegatedRoots, setup.local.roots);
  assert.deepEqual(report.approvedRoots, ["/srv/example-app"]);
  assert.deepEqual(report.effectiveRoots, ["/srv/example-app"]);
  const selected = [
    "/srv/example-app",
    "/srv/example-two/app",
    "/srv/example-three/app",
  ];
  const request = await f.payload(selected, "apply_mode_0001");
  assert.equal((await f.policy().apply(request)).success, true);
  assert.deepEqual((await f.policy().report()).effectiveRoots, selected);
  f.add("/srv/example-two/new-app");
  assert.equal(
    (
      await f
        .policy()
        .apply(
          await f.payload(
            [...selected, "/srv/example-two/new-app"],
            "apply_mode_0002",
          ),
        )
    ).success,
    true,
  );
  report = await f.policy().report();
  assert.equal(report.effectiveVersion, 2);
  assert.equal((await f.policy().apply(request)).success, false);
  await assert.rejects(f.hostPolicy().changeAuthorizationMode(setup.local));
});

test("Server-Managed denies outside prefixes, sensitive components and canonical symlink escapes while Linux permission failures remain explicit", async () => {
  const f = fixture();
  f.add("/srv/example-two/app");
  f.add("/srv/example-two/.ssh");
  f.add("/srv/example-two/.ssh/key");
  const setup = await setupMode(f, "server-managed", ["/srv/example-two"]);
  await f.hostPolicy().changeAuthorizationMode(setup.local);
  f.add("/var/www/example-alias", 1001, 0o755, false);
  f.entries.get("/var/www/example-alias")!.link = "/srv/example-three";
  f.add("/var/www/private-alias", 1001, 0o755, false);
  f.entries.get("/var/www/private-alias")!.link = "/srv/example-two/.ssh";
  const result = await f
    .policy()
    .validate(
      await f.payload([
        "/srv/example-three",
        "/var/www/example-alias",
        "/srv/example-two/.ssh/key",
        "/var/www/private-alias",
      ]),
    );
  assert.equal(result.validation[0].code, "source-outside-delegated-scope");
  assert.equal(result.validation[1].code, "source-outside-delegated-scope");
  assert.equal(result.validation[2].code, "source-sensitive-root");
  assert.equal(result.validation[3].code, "source-sensitive-root");
  f.denied.add("/srv/example-two/app");
  const denied = await f
    .policy()
    .validate(await f.payload(["/srv/example-two/app"]));
  assert.equal(denied.validation[0].code, "source-root-not-readable");
  assert.equal(
    (await f.policy().apply(await f.payload(["/srv/example-three"]))).success,
    false,
  );
});

test("delegated backup argument construction always excludes private credential directories and leaves strict static contents unchanged", () => {
  const strictArgs = ["backup", "/srv/example-app"];
  appendSourceBackupExcludes(strictArgs, ["*.tmp"], false);
  assert.deepEqual(strictArgs, [
    "backup",
    "/srv/example-app",
    "--exclude",
    "*.tmp",
  ]);
  const delegatedArgs = ["backup", "/srv/example-two"];
  appendSourceBackupExcludes(delegatedArgs, ["*.tmp", "!**/.ssh"], true);
  for (const pattern of ["**/.ssh", "**/.aws", "**/.gnupg", "**/.kube"]) {
    const index = delegatedArgs.indexOf(pattern);
    assert.ok(index > 0);
    assert.equal(delegatedArgs[index - 1], "--exclude");
  }
});

test("a signed delegated backup naming a credential subdirectory is refused before local filesystem or SFTP execution", async () => {
  await assert.rejects(
    executeFilesystemBackup({
      payload: {
        version: 1,
        backupId: "backup-example",
        planId: "plan-example",
        sourcePath: "/srv/example-app/.ssh",
        excludes: [],
        repository: {
          remoteName: "pluton",
          path: "managed/example",
          initialize: false,
        },
        rclone: {
          type: "sftp",
          options: {
            host: "sftp.example.internal",
            user: "example",
            pass: "synthetic-only-sftp-password",
          },
        },
        repositoryPassword: "synthetic-only-repository-password",
      },
      config: {
        serverUrl: new URL("https://example.invalid"),
        dataDir: "/synthetic-unused-state",
        allowedRoots: ["/srv/example-app"],
        allowInsecureHttp: false,
      },
      allowedRoots: ["/srv/example-app"],
      serverManagedSource: true,
      shouldCancel: async () => false,
      onEvent: async () => undefined,
    }),
    (error) =>
      error instanceof BackupFilesystemError &&
      error.stage === "source-validation" &&
      error.code === "source-policy-violation",
  );
});

test("Host-Approved mode reversion revokes delegated selections, preserves strict roots and requires explicit Apply after later re-delegation", async () => {
  const f = fixture();
  let setup = await setupMode(f, "server-managed", ["/srv/example-two"]);
  await f.hostPolicy().changeAuthorizationMode(setup.local);
  await f
    .policy()
    .apply(
      await f.payload(
        ["/srv/example-app", "/srv/example-two"],
        "apply_switch_0001",
      ),
    );
  setup = await setupMode(f, "host-approved", [], "mode_request_0002");
  await f.hostPolicy().changeAuthorizationMode(setup.local);
  let report = await f.policy().report();
  assert.equal(report.authorizationMode, "host-approved");
  assert.deepEqual(report.delegatedRoots, []);
  assert.deepEqual(report.effectiveRoots, ["/srv/example-app"]);
  assert.equal(
    report.rootStatuses.find((root) => root.path === "/srv/example-two")!
      .status,
    "rejected",
  );
  setup = await setupMode(
    f,
    "server-managed",
    ["/srv/example-two"],
    "mode_request_0003",
  );
  await f.hostPolicy().changeAuthorizationMode(setup.local);
  report = await f.policy().report();
  assert.deepEqual(report.effectiveRoots, ["/srv/example-app"]);
  assert.equal(
    (
      await f
        .policy()
        .apply(
          await f.payload(
            ["/srv/example-app", "/srv/example-two"],
            "apply_switch_0002",
          ),
        )
    ).success,
    true,
  );
});

test("mode receipts reject wrong scope, identity, signature, active execution and pending selection; receipt replay never extends its deadline", async () => {
  const f = fixture();
  const setup = await setupMode(f, "server-managed", ["/srv/example-two"]);
  const initialReceipt = f.entries.get(
    "/state/source-access-mode-setup.json",
  )!.data;
  f.advanceUptime(1000);
  await f.policy().prepareModeSetup(setup.command, modeSecret);
  assert.equal(
    f.entries.get("/state/source-access-mode-setup.json")!.data,
    initialReceipt,
  );
  await assert.rejects(
    f.hostPolicy().changeAuthorizationMode({
      ...setup.local,
      roots: ["/srv/example-three"],
    }),
  );
  await assert.rejects(
    f.hostPolicy().changeAuthorizationMode({
      ...setup.local,
      secret: "wrong-synthetic-key",
    }),
  );
  await assert.rejects(
    f
      .hostPolicy()
      .changeAuthorizationMode({ ...setup.local, agentId: "agent-other" }),
  );
  f.add("/state/source-access-activity.json", 1001, 0o600, false, "{}");
  await assert.rejects(
    f.hostPolicy().changeAuthorizationMode(setup.local),
    /source-agent-operation-active/,
  );
  f.entries.delete("/state/source-access-activity.json");
  f.add("/state/source-access-pending.json", 1001, 0o600, false, "{}");
  await assert.rejects(
    f.hostPolicy().changeAuthorizationMode(setup.local),
    /source-policy-stale/,
  );
  f.entries.delete("/state/source-access-pending.json");
  f.advanceUptime(15 * 60_000);
  await assert.rejects(
    f.hostPolicy().changeAuthorizationMode(setup.local),
    /source-mode-setup-expired/,
  );
  await assert.rejects(
    f.policy().prepareModeSetup(setup.command, modeSecret),
    /source-mode-setup-expired/,
  );
});

test("a reboot invalidates a prepared mode receipt and publication failure durably consumes it before leaving the host fail closed", async () => {
  const f = fixture();
  const setup = await setupMode(f, "server-managed", ["/srv/example-two"]);
  f.boot("synthetic-reboot");
  await assert.rejects(
    f.hostPolicy().changeAuthorizationMode(setup.local),
    /source-mode-setup-expired/,
  );
  f.boot("synthetic-boot-01");
  f.failSync(4);
  await assert.rejects(
    f.hostPolicy().changeAuthorizationMode(setup.local),
    /durability/,
  );
  assert.equal(
    JSON.parse(f.entries.get("/state/source-access-mode-setup.json")!.data)
      .consumedRequestId,
    setup.local.requestId,
  );
  assert.ok((await f.policy().report()).policyError);
  assert.ok(f.entries.has("/etc/pluton-agent/.source-access.lock"));
});

test("wall-clock rollback cannot extend a boot-bound receipt and an activity release fsync failure remains fenced across policy instances", async () => {
  const f = fixture();
  const setup = await setupMode(f, "server-managed", ["/srv/example-two"]);
  const wallClock = Date.now;
  try {
    f.advanceUptime(15 * 60_000);
    Date.now = () => wallClock() - 60_000;
    await assert.rejects(
      f.hostPolicy().changeAuthorizationMode(setup.local),
      /source-mode-setup-expired/,
    );
  } finally {
    Date.now = wallClock;
  }
  const execution = fixture();
  execution.failSync(2);
  await assert.rejects(
    execution.policy().withActivity(async () => undefined),
    /durability/,
  );
  assert.ok(execution.entries.has("/state/source-access-activity.json"));
  await assert.rejects(
    execution.policy().withActivity(async () => undefined),
    /durability/,
  );
  await assert.rejects(
    execution.coldPolicy().withActivity(async () => undefined),
    /source-agent-operation-active/,
  );
});

test("Linux path validation denies traversal, controls, broad/system roots, duplicates and overlapping selection", () => {
  for (const bad of [
    "relative",
    "C:\\source",
    "/srv/../etc",
    "/srv/./app",
    "/srv/app\n",
    "//srv/app",
    "/srv/app/",
  ])
    assert.throws(() => validateSourcePaths([bad]), SourcePolicyError);
  for (const bad of [
    "/",
    "/home",
    "/srv",
    "/var/www",
    "/etc/config",
    "/proc/self",
    "/root/private",
    "/opt/pluton-agent/app",
  ])
    assert.equal(isNewSourceRootAllowed(bad), false);
  assert.equal(isNewSourceRootAllowed("/srv/example-app"), true);
  assert.throws(() => assertNonoverlappingRoots(["/srv/app", "/srv/app"]));
  assert.throws(() =>
    assertNonoverlappingRoots(["/srv/app", "/srv/app/child"]),
  );
  assert.doesNotThrow(() =>
    assertNonoverlappingRoots(["/srv/app", "/srv/app-other"]),
  );
  assert.throws(() => validateSourcePaths(Array(33).fill("/srv/app")));
});

test("static roots stay effective; validation is read-only, canonicalizes an explicitly requested alias and marks outside maximum pending", async () => {
  const f = fixture();
  f.add("/var/www/example-app", 1001, 0o755, false);
  f.entries.get("/var/www/example-app")!.link = "/srv/example-two";
  const initial = await f.policy().report();
  assert.deepEqual(initial.effectiveRoots, ["/srv/example-app"]);
  assert.equal(initial.effectiveVersion, 0);
  const result = await f
    .policy()
    .validate(await f.payload(["/srv/example-app", "/var/www/example-app"]));
  assert.equal(result.validation[0].status, "approved");
  assert.deepEqual(result.validation[1], {
    requestedPath: "/var/www/example-app",
    canonicalPath: "/srv/example-two",
    status: "pending-host-approval",
  });
  assert.deepEqual(f.log, []);
  const apply = await f.policy().apply(await f.payload(["/srv/example-two"]));
  assert.equal(apply.success, false);
  assert.equal(apply.error, "source-host-approval-required");
  assert.deepEqual(
    (await f.policy().report()).effectiveRoots,
    initial.effectiveRoots,
  );
});

test("host approval is local/root-only, version/identity bound, supports bulk roots and never auto-enables them", async () => {
  const f = fixture();
  const revision = (await f.policy().report()).hostPolicyRevision;
  await assert.rejects(
    f.policy().changeHostApproval({
      action: "approve",
      agentId: "agent-01",
      expectedRevision: revision,
      roots: ["/srv/example-two"],
    }),
  );
  await assert.rejects(
    f.hostPolicy().changeHostApproval({
      action: "approve",
      agentId: "other-agent",
      expectedRevision: revision,
      roots: ["/srv/example-two"],
    }),
  );
  const changed = await f.hostPolicy().changeHostApproval({
    action: "approve",
    agentId: "agent-01",
    expectedRevision: revision,
    roots: ["/srv/example-two", "/srv/example-three"],
  });
  assert.notEqual(changed.hostPolicyRevision, revision);
  assert.deepEqual(changed.approvedRoots, [
    "/srv/example-app",
    "/srv/example-three",
    "/srv/example-two",
  ]);
  assert.deepEqual((await f.policy().report()).effectiveRoots, [
    "/srv/example-app",
  ]);
  await assert.rejects(
    f.hostPolicy().changeHostApproval({
      action: "approve",
      agentId: "agent-01",
      expectedRevision: revision,
      roots: ["/srv/example-two"],
    }),
  );
});

test("explicit selection is durably published before success; same request is idempotent, old/stale versions cannot re-enable a revoked root", async () => {
  const f = fixture();
  const first = await f.payload(["/srv/example-app"]);
  const applied = await f.policy().apply(first);
  assert.equal(applied.success, true);
  assert.equal(applied.sourceAccess.effectiveVersion, 1);
  const rename = f.log.indexOf("rename:/state/source-access-selection.json");
  assert.ok(rename > 0);
  assert.ok(
    f.log
      .slice(0, rename)
      .some((line) =>
        line.startsWith("sync:/state/source-access-selection.json."),
      ),
  );
  assert.ok(f.log.slice(rename + 1).includes("sync:/state"));
  assert.equal((await f.policy().apply(first)).success, true);
  const disable = await f.payload([], "request_0002");
  assert.equal((await f.policy().apply(disable)).success, true);
  assert.deepEqual((await f.policy().report()).effectiveRoots, []);
  assert.equal((await f.policy().apply(first)).success, false);
  assert.equal((await f.policy().report()).effectiveVersion, 2);
  assert.deepEqual((await f.policy().report()).effectiveRoots, []);
});

test("missing or replaced initialized state fails closed without reconstructing old/static authorization", async () => {
  const f = fixture();
  assert.equal((await f.policy().apply(await f.payload([]))).success, true);
  f.entries.delete("/state/source-access-selection.json");
  let report = await f.policy().report();
  assert.equal(report.policyError, "source-policy-state-invalid");
  assert.deepEqual(report.effectiveRoots, []);
  f.add("/state/source-access-selection.json", 1001, 0o600, false, "{}");
  report = await f.policy().report();
  assert.equal(report.policyError, "source-policy-state-invalid");
  assert.deepEqual(report.effectiveRoots, []);
});

test("directory fsync failure leaves durable transaction marker and restart fails closed", async () => {
  const f = fixture();
  f.failSync(3); // selection was renamed; its parent directory cannot be confirmed
  const applied = await f.policy().apply(await f.payload([]));
  assert.equal(applied.success, false);
  assert.equal(applied.error, "source-policy-durability-uncertain");
  assert.ok(f.entries.has("/state/source-access-pending.json"));
  const report = await f.policy().report();
  assert.equal(report.policyError, "source-policy-durability-uncertain");
  assert.deepEqual(report.effectiveRoots, []);
});

test("local explicit recovery confirms exact persisted request; cannot manufacture new approval or a sequence", async () => {
  const f = fixture();
  const input = await f.payload([]);
  f.failSync(3);
  assert.equal((await f.policy().apply(input)).success, false);
  f.failSync(0);
  await assert.rejects(
    f.hostPolicy().recoverSelection({
      agentId: "agent-01",
      expectedRevision: input.expectedHostPolicyRevision,
      requestId: "unrelated_request",
    }),
  );
  await f.hostPolicy().recoverSelection({
    agentId: "agent-01",
    expectedRevision: input.expectedHostPolicyRevision,
    requestId: input.requestId,
  });
  const report = await f.policy().report();
  assert.equal(report.policyError, undefined);
  assert.equal(report.effectiveVersion, 1);
  assert.deepEqual(report.effectiveRoots, []);
});

test("unprotected/symlinked host approval file, replaced canonical root and special file are rejected", async () => {
  for (const mutate of [
    (entry: Entry) => {
      entry.uid = 1001;
    },
    (entry: Entry) => {
      entry.mode = 0o666;
    },
    (entry: Entry) => {
      entry.link = "/srv/example-app";
    },
  ]) {
    const f = fixture();
    f.add(
      "/etc/pluton-agent/source-access.json",
      0,
      0o644,
      false,
      JSON.stringify({
        version: 1,
        agentId: "agent-01",
        hostVersion: 1,
        roots: ["/srv/example-two"],
      }),
    );
    mutate(f.entries.get("/etc/pluton-agent/source-access.json")!);
    assert.ok((await f.policy().report()).policyError);
  }
  const f = fixture();
  f.add("/srv/special", 1001, 0o600, false);
  const result = await f.policy().validate(await f.payload(["/srv/special"]));
  assert.equal(result.validation[0].status, "rejected");
  assert.equal(result.validation[0].code, "source-unsupported-type");
});

test("service-user Linux access denial and source replacement during realpath validation are actionable rejections", async () => {
  const f = fixture();
  f.denied.add("/srv/example-two");
  const denied = await f
    .policy()
    .validate(await f.payload(["/srv/example-two"]));
  assert.equal(denied.validation[0].code, "source-root-not-readable");
  f.denied.clear();
  let checks = 0;
  f.onRealpath((filename) => {
    if (filename === "/srv/example-two" && ++checks === 2)
      f.entries.get(filename)!.ino++;
  });
  const changed = await f
    .policy()
    .validate(await f.payload(["/srv/example-two"]));
  assert.equal(changed.validation[0].code, "source-symlink-changed");
});

test("host revocation removes access while retaining identity and explicit selection revision", async () => {
  const f = fixture();
  let report = await f.policy().report();
  await f.hostPolicy().changeHostApproval({
    action: "approve",
    agentId: "agent-01",
    expectedRevision: report.hostPolicyRevision,
    roots: ["/srv/example-two"],
  });
  const input = await f.payload(["/srv/example-two"]);
  assert.equal((await f.policy().apply(input)).success, true);
  report = await f.policy().report();
  await f.hostPolicy().changeHostApproval({
    action: "revoke",
    agentId: "agent-01",
    expectedRevision: report.hostPolicyRevision,
    roots: ["/srv/example-two"],
  });
  report = await f.policy().report();
  assert.deepEqual(report.effectiveRoots, []);
  assert.equal(report.effectiveVersion, 1);
  assert.equal(report.rootStatuses[0].code, "source-host-approval-revoked");
});

test("concurrent writers and malformed commands cannot overwrite pending or completed authorization", async () => {
  const f = fixture();
  const one = await f.payload([], "request_0001"),
    two = { ...one, requestId: "request_0002" };
  const results = await Promise.all([
    f.policy().apply(one),
    f.policy().apply(two),
  ]);
  assert.equal(results.filter((item) => item.success).length, 1);
  assert.equal((await f.policy().report()).effectiveVersion, 1);
  assert.equal(
    (await f.policy().apply({ ...one, command: "shell", roots: ["/"] }))
      .success,
    false,
  );
});

test("local config literal parser preserves multiple old roots without shell evaluation or identities", () => {
  assert.deepEqual(
    parseSourceAccessEnvironment(
      'PLUTON_AGENT_ALLOWED_ROOTS="/srv/example-app,/srv/example-two"\nPLUTON_AGENT_DATA_DIR="/var/lib/pluton-agent"\nIGNORED="$(do-not-run)"\n',
    ),
    {
      dataDir: "/var/lib/pluton-agent",
      allowedRoots: ["/srv/example-app", "/srv/example-two"],
      sourcePolicyFile: undefined,
    },
  );
  assert.throws(() =>
    parseSourceAccessEnvironment(
      'PLUTON_AGENT_DATA_DIR="/state"\nPLUTON_AGENT_DATA_DIR="/other"',
    ),
  );
  assert.throws(() =>
    parseSourceAccessEnvironment(
      'PLUTON_AGENT_ALLOWED_ROOTS="/srv/example-app\\q"',
    ),
  );
  assert.equal(
    path.posix.dirname("/state/source-access-selection.json"),
    "/state",
  );
});

test("an expired lease cannot publish access; expiry during publication retains a fail-closed pending marker", async () => {
  const before = fixture(),
    after = fixture();
  const rejected = await before
    .policy()
    .apply(await before.payload([]), () => false);
  assert.equal(rejected.success, false);
  assert.equal(rejected.error, "source-command-lease-expired");
  assert.deepEqual(before.log, []);
  const interrupted = await after
    .policy()
    .apply(
      await after.payload([]),
      () => !after.log.includes("rename:/state/source-access-selection.json"),
    );
  assert.equal(interrupted.success, false);
  assert.equal(interrupted.error, "source-command-lease-expired");
  assert.ok(after.entries.has("/state/source-access-pending.json"));
  assert.equal(
    (await after.policy().report()).policyError,
    "source-policy-durability-uncertain",
  );
  assert.deepEqual((await after.policy().report()).effectiveRoots, []);
});

test("final directory fsync failure restores the fence and survives a fresh policy/process model", async () => {
  const f = fixture();
  await f.hostPolicy().changeHostApproval({
    action: "approve",
    agentId: "agent-01",
    expectedRevision: (await f.policy().report()).hostPolicyRevision,
    roots: ["/srv/example-two"],
  });
  const input = await f.payload(["/srv/example-app", "/srv/example-two"]);
  f.failSync(4); // final unlink, after selection is already durable
  const result = await f.policy().apply(input);
  assert.equal(result.success, false);
  assert.equal(result.error, "source-policy-durability-uncertain");
  assert.ok(f.entries.has("/state/source-access-pending.json"));
  for (const restarted of [f.policy(), f.coldPolicy()]) {
    assert.equal(
      (await restarted.report()).policyError,
      "source-policy-durability-uncertain",
    );
    assert.deepEqual((await restarted.report()).effectiveRoots, []);
  }
  f.failSync(0);
  await f.hostPolicy().recoverSelection({
    agentId: "agent-01",
    expectedRevision: input.expectedHostPolicyRevision,
    requestId: input.requestId,
  });
  assert.deepEqual((await f.policy().report()).effectiveRoots, input.roots);
  assert.equal((await f.policy().report()).effectiveVersion, 1);
});

test("host revoke/reapprove needs a new explicit selection; unrelated host additions do not disable existing grants", async () => {
  const f = fixture();
  const change = async (action: "approve" | "revoke", roots: string[]) =>
    f.hostPolicy().changeHostApproval({
      action,
      agentId: "agent-01",
      expectedRevision: (await f.policy().report()).hostPolicyRevision,
      roots,
    });
  await change("approve", ["/srv/example-two"]);
  assert.equal(
    (
      await f
        .policy()
        .apply(await f.payload(["/srv/example-app", "/srv/example-two"]))
    ).success,
    true,
  );
  await change("approve", ["/srv/example-three"]);
  assert.deepEqual((await f.policy().report()).effectiveRoots, [
    "/srv/example-app",
    "/srv/example-two",
  ]);
  await change("revoke", ["/srv/example-two"]);
  assert.deepEqual((await f.policy().report()).effectiveRoots, [
    "/srv/example-app",
  ]);
  await change("approve", ["/srv/example-two"]);
  let report = await f.policy().report();
  assert.deepEqual(report.effectiveRoots, ["/srv/example-app"]);
  assert.equal(report.effectiveVersion, 1);
  assert.equal(
    report.rootStatuses.find((item) => item.path === "/srv/example-two")?.code,
    "source-host-approval-changed",
  );
  assert.equal(
    (
      await f
        .policy()
        .apply(
          await f.payload(
            ["/srv/example-app", "/srv/example-two"],
            "explicit_reapproval_0002",
          ),
        )
    ).success,
    true,
  );
  report = await f.policy().report();
  assert.deepEqual(report.effectiveRoots, [
    "/srv/example-app",
    "/srv/example-two",
  ]);
  assert.equal(report.effectiveVersion, 2);
});

test("missing unused maximum and missing static root cannot disable healthy sources; exact absent approval can be revoked", async () => {
  const f = fixture();
  await f.hostPolicy().changeHostApproval({
    action: "approve",
    agentId: "agent-01",
    expectedRevision: (await f.policy().report()).hostPolicyRevision,
    roots: ["/srv/example-two"],
  });
  f.entries.delete("/srv/example-two");
  let report = await f.policy().report();
  assert.equal(report.policyError, undefined);
  assert.deepEqual(report.effectiveRoots, ["/srv/example-app"]);
  await f.hostPolicy().changeHostApproval({
    action: "revoke",
    agentId: "agent-01",
    expectedRevision: report.hostPolicyRevision,
    roots: ["/srv/example-two"],
  });
  report = await f.policy().report();
  assert.deepEqual(report.approvedRoots, ["/srv/example-app"]);
  f.config.allowedRoots.push("/srv/absent-static-app");
  report = await f.policy().report();
  assert.equal(report.policyError, undefined);
  assert.deepEqual(report.effectiveRoots, ["/srv/example-app"]);
  assert.equal(
    report.rootStatuses.find((item) => item.path === "/srv/absent-static-app")
      ?.status,
    "missing",
  );
});

test("concurrent host approval writers cannot overwrite another operator lock", async () => {
  const f = fixture();
  const initial = (await f.policy().report()).hostPolicyRevision;
  const results = await Promise.allSettled([
    f.hostPolicy().changeHostApproval({
      action: "approve",
      agentId: "agent-01",
      expectedRevision: initial,
      roots: ["/srv/example-two"],
    }),
    f.hostPolicy().changeHostApproval({
      action: "approve",
      agentId: "agent-01",
      expectedRevision: initial,
      roots: ["/srv/example-three"],
    }),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal((await f.policy().report()).approvedRoots.length, 2);
  const lock = "/etc/pluton-agent/.source-access.lock";
  f.add(lock, 0, 0o600, false, "owned-by-another-operator");
  await assert.rejects(
    f.hostPolicy().changeHostApproval({
      action: "approve",
      agentId: "agent-01",
      expectedRevision: (await f.policy().report()).hostPolicyRevision,
      roots: ["/srv/example-three"],
    }),
    (error) =>
      error instanceof SourcePolicyError &&
      error.code === "source-host-policy-busy",
  );
  assert.equal(f.entries.get(lock)!.data, "owned-by-another-operator");
});

test("replacement of one selected root by a symlink never widens it or disables healthy sources", async () => {
  const f = fixture();
  await f.hostPolicy().changeHostApproval({
    action: "approve",
    agentId: "agent-01",
    expectedRevision: (await f.policy().report()).hostPolicyRevision,
    roots: ["/srv/example-two"],
  });
  assert.equal(
    (
      await f
        .policy()
        .apply(await f.payload(["/srv/example-app", "/srv/example-two"]))
    ).success,
    true,
  );
  f.entries.get("/srv/example-two")!.link = "/srv/example-three";
  const report = await f.policy().report();
  assert.equal(report.policyError, undefined);
  assert.deepEqual(report.effectiveRoots, ["/srv/example-app"]);
  assert.equal(
    report.rootStatuses.find((item) => item.path === "/srv/example-two")?.code,
    "source-symlink-changed",
  );
});

test("uncertain host approval publication retains its owned lock and refuses all grants until operator review", async () => {
  for (const failedSync of [2, 3]) {
    const f = fixture();
    const revision = (await f.policy().report()).hostPolicyRevision;
    f.failSync(failedSync); // host file publication or final lock removal
    await assert.rejects(
      f.hostPolicy().changeHostApproval({
        action: "approve",
        agentId: "agent-01",
        expectedRevision: revision,
        roots: ["/srv/example-two"],
      }),
      (error) =>
        error instanceof SourcePolicyError &&
        error.code === "source-policy-durability-uncertain",
    );
    assert.ok(f.entries.has("/etc/pluton-agent/.source-access.lock"));
    for (const instance of [f.policy(), f.coldPolicy()]) {
      const report = await instance.report();
      assert.equal(report.policyError, "source-host-policy-busy");
      assert.deepEqual(report.effectiveRoots, []);
    }
  }
});

test("all 32 maximum-length Unicode directory approvals and selection bindings fit the bounded durable state", async () => {
  const f = fixture();
  f.config.allowedRoots = [];
  const roots = Array.from(
    { length: 32 },
    (_, index) => `/srv/${String(index).padStart(2, "0")}-${"語".repeat(1016)}`,
  );
  for (const root of roots) {
    assert.equal(root.length, 1024);
    f.add(root);
  }
  await f.hostPolicy().changeHostApproval({
    action: "approve",
    agentId: "agent-01",
    expectedRevision: (await f.policy().report()).hostPolicyRevision,
    roots,
  });
  const result = await f.policy().apply(await f.payload(roots));
  assert.equal(result.success, true);
  assert.deepEqual((await f.policy().report()).effectiveRoots, roots);
  assert.ok(
    Buffer.byteLength(
      f.entries.get("/state/source-access-selection.json")!.data,
    ) >
      64 * 1024,
  );
});

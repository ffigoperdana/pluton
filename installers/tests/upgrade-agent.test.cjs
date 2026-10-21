"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const upgrade = require("../lib/upgrade-agent.cjs");
const diagnostics = require("../lib/upgrade-diagnostics.cjs");
const root = path.resolve(__dirname, "../../tmp/agent-upgrade");
fs.mkdirSync(root, { recursive: true });
const linux = process.platform === "linux";

function fixture(t, { wasActive = true } = {}) {
  const temporary = fs.mkdtempSync(path.join(root, "fixture-"));
  t.after(() => {
    assert(temporary.startsWith(root + path.sep));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const c = {
    install: path.join(temporary, "opt/pluton-agent"),
    state: path.join(temporary, "state"),
    config: path.join(temporary, "agent.env"),
    unit: path.join(temporary, "unit"),
    policy: path.join(temporary, "policy"),
    backups: path.join(temporary, "upgrades"),
    commit: "a".repeat(40),
    owner: process.getuid?.() ?? 0,
    agentUid: process.getuid?.() ?? 0,
    agentGid: process.getgid?.() ?? 0,
    enforceModes: linux,
    // Windows exercises the state machine, not Linux directory-fsync semantics.
    sync: linux ? upgrade.syncDirectory : () => {},
    checkpoint: () => {},
    processAlive: () => false,
  };
  c.app = path.join(c.install, "app");
  c.hold = path.join(c.install, ".upgrade-lock");
  c.node = path.join(c.install, "private-node");
  c.provenance = path.join(c.install, ".verified-install");
  for (const directory of [
    c.install,
    c.state,
    c.policy,
    path.join(c.app, "dist"),
  ])
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  fs.writeFileSync(c.node, "private-runtime-unchanged");
  fs.writeFileSync(path.join(c.app, "dist/index.js"), "old app");
  fs.writeFileSync(
    path.join(c.app, "package.json"),
    '{"name":"@plutonhq/pluton-agent"}',
  );
  fs.writeFileSync(c.provenance, "old verified provenance");
  fs.writeFileSync(
    c.config,
    'PLUTON_SERVER_URL="https://pluton.example.internal"\nPLUTON_AGENT_ALLOWED_ROOTS="/srv/example-app,/srv/example-worker"\nPLUTON_AGENT_HOOK_ROOT="/etc/pluton-agent/hooks"\nPLUTON_AGENT_CLIENT_KEY_FILE="/etc/example-client.key"\n',
  );
  fs.writeFileSync(c.unit, "original custom bytes kept unchanged");
  fs.writeFileSync(
    path.join(c.policy, "source-access.json"),
    '{"version":2,"authorizationMode":"server-managed"}',
  );
  fs.writeFileSync(
    path.join(c.state, "source-access-selection.json"),
    '{"effectiveVersion":7,"requestId":"explicit-source-request"}',
  );
  fs.writeFileSync(
    path.join(c.state, "identity.json"),
    JSON.stringify({
      agentId: "agent-01",
      deviceId: "app-01",
      secret: "synthetic-only-test-secret",
      pollIntervalSeconds: 5,
      completedCommands: [
        { commandId: "previous-receipt", sequence: 1, success: true },
      ],
    }),
  );
  const calls = [];
  let active = wasActive;
  c.service = {
    active: () => active,
    assertIdle: () => calls.push("idle"),
    assertEmpty: () => assert.equal(active, false),
    stop: () => {
      calls.push("stop");
      active = false;
    },
    start: () => {
      calls.push("start");
      active = true;
    },
    health: () => {
      calls.push("health");
      assert.equal(fs.existsSync(c.hold), true);
      assert.equal(
        fs.existsSync(path.join(c.state, "source-access-activity.json")),
        true,
      );
    },
  };
  c.preflight = () => {
    calls.push("preflight");
    assert(fs.existsSync(c.config));
    upgrade.identityBinding(c.state);
  };
  c.build = (id, next) => {
    calls.push("build");
    assert.equal(active, wasActive);
    fs.mkdirSync(path.join(next, "dist"), { recursive: true });
    fs.writeFileSync(path.join(next, "dist/index.js"), "new app");
    fs.writeFileSync(
      path.join(next, "package.json"),
      '{"name":"@plutonhq/pluton-agent"}',
    );
  };
  c.verifyCandidate = (next) => {
    calls.push("verify");
    assert.equal(
      fs.readFileSync(path.join(next, "dist/index.js"), "utf8"),
      "new app",
    );
  };
  c.writeProvenance = () =>
    upgrade.durableWrite(
      c.provenance,
      "new verified provenance",
      c.sync,
      0o644,
    );
  c.verifyReceipt = (file) =>
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  const before = upgrade.preservedDigest(c),
    old = upgrade.treeDigest(c.app, c.owner, linux);
  return {
    c,
    calls,
    before,
    old,
    temporary,
    app: () => fs.readFileSync(path.join(c.app, "dist/index.js"), "utf8"),
    retained: () =>
      fs.readdirSync(c.backups).filter((name) => /^\d{14}-/.test(name)),
    assertPreserved: () => assert.equal(upgrade.preservedDigest(c), before),
  };
}

test("upgrade builds before stopping, atomically replaces only app and preserves exact identity/config/unit/policy/receipts", (t) => {
  const f = fixture(t),
    runtime = fs.readFileSync(f.c.node);
  const result = upgrade.upgrade(f.c);
  assert.equal(result.phase, "healthy");
  assert.equal(f.app(), "new app");
  f.assertPreserved();
  assert(f.calls.indexOf("build") < f.calls.indexOf("stop"));
  assert.deepEqual(fs.readFileSync(f.c.node), runtime);
  assert.equal(fs.existsSync(f.c.hold), false);
  assert.equal(
    fs.existsSync(path.join(f.c.state, "source-access-activity.json")),
    false,
  );
  assert.equal(
    fs.readFileSync(
      path.join(f.c.backups, result.id, "app/dist/index.js"),
      "utf8",
    ),
    "old app",
  );
  assert.equal(
    fs.existsSync(path.join(f.c.backups, result.id, "identity.json")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(f.c.backups, result.id, "agent.env")),
    true,
  );
});
test("active Agent fence refuses without stopping a service or applying a command", (t) => {
  const f = fixture(t),
    activity = path.join(f.c.state, "source-access-activity.json");
  fs.writeFileSync(activity, '{"operationId":"unrelated-backup"}');
  assert.throws(() => upgrade.upgrade(f.c), /operation is active/);
  assert.equal(f.app(), "old app");
  assert(!f.calls.includes("stop"));
  f.assertPreserved();
  assert.equal(
    fs.readFileSync(activity, "utf8"),
    '{"operationId":"unrelated-backup"}',
  );
});
test("a child job discovered after build is refused before Stop", (t) => {
  const f = fixture(t);
  const build = f.c.build;
  f.c.build = (...args) => {
    build(...args);
    f.c.service.assertIdle = () => {
      throw new Error("child active");
    };
  };
  assert.throws(() => upgrade.upgrade(f.c), /failed safely/);
  assert(!f.calls.includes("stop"));
  f.assertPreserved();
});
for (const name of [
  "source-access-pending.json",
  "jobs",
  "source-access-mode-setup.json",
]) {
  test(`pending ${name} refuses without changing lifecycle state`, (t) => {
    const f = fixture(t),
      file = path.join(f.c.state, name);
    if (name === "jobs") {
      fs.mkdirSync(file);
      fs.mkdirSync(path.join(file, "owned-job"));
    } else
      fs.writeFileSync(
        file,
        name.includes("mode")
          ? JSON.stringify({
              command: { payload: { expiresAt: Date.now() + 60000 } },
            })
          : "{}",
      );
    assert.throws(() => upgrade.upgrade(f.c), /Pending|workspace/);
    assert(!f.calls.includes("stop"));
    assert.equal(f.app(), "old app");
  });
}
test("failed dependencies/build leaves original app and service running", (t) => {
  const f = fixture(t);
  f.c.build = () => {
    throw new Error("synthetic build failure");
  };
  assert.throws(() => upgrade.upgrade(f.c), /failed safely/);
  assert(!f.calls.includes("stop"));
  assert.equal(f.app(), "old app");
  f.assertPreserved();
});
test("missing or malformed enrolled identity refuses upgrade before any hold/build/Stop", (t) => {
  const f = fixture(t),
    identity = path.join(f.c.state, "identity.json");
  fs.unlinkSync(identity);
  assert.throws(() => upgrade.upgrade(f.c));
  fs.writeFileSync(identity, "{}");
  assert.throws(() => upgrade.upgrade(f.c), /enrolled identity/);
  assert.equal(fs.existsSync(f.c.hold), false);
  assert(!f.calls.includes("build"));
  assert(!f.calls.includes("stop"));
});
test("uncertain initial activity publication retains exact fences without stopping the current Agent", (t) => {
  const f = fixture(t),
    sync = f.c.sync;
  f.c.sync = (directory) => {
    if (directory === f.c.state) throw new Error("synthetic fsync failure");
    sync(directory);
  };
  assert.throws(() => upgrade.upgrade(f.c), /hold and artifacts retained/);
  assert.equal(fs.existsSync(f.c.hold), true);
  assert.equal(
    fs.existsSync(path.join(f.c.state, "source-access-activity.json")),
    true,
  );
  assert(!f.calls.includes("stop"));
  assert.equal(f.app(), "old app");
  f.assertPreserved();
});
test("unsafe or missing build artifact is refused before Stop", (t) => {
  const f = fixture(t);
  f.c.verifyCandidate = () => {
    throw new Error("invalid artifact");
  };
  assert.throws(() => upgrade.upgrade(f.c), /failed safely/);
  assert(!f.calls.includes("stop"));
  assert.equal(f.app(), "old app");
  f.assertPreserved();
});
test("failed startup restores app/provenance only, health-checks previous app, and keeps backup files", (t) => {
  const f = fixture(t);
  let first = true;
  const healthy = f.c.service.health;
  f.c.service.health = () => {
    if (first) {
      first = false;
      throw new Error("bad startup");
    }
    healthy();
  };
  assert.throws(() => upgrade.upgrade(f.c), /failed safely/);
  assert.equal(f.app(), "old app");
  f.assertPreserved();
  assert.equal(
    fs.readFileSync(f.c.provenance, "utf8"),
    "old verified provenance",
  );
  assert.equal(
    fs.existsSync(path.join(f.c.install, `.failed-${f.retained()[0]}`)),
    true,
  );
});
for (const phase of ["prepared", "old-moved", "activated"]) {
  test(`interrupted ${phase} leaves durable hold and exact rollback recovers without state rewind`, (t) => {
    const f = fixture(t);
    f.c.checkpoint = (point) => {
      if (point === phase) {
        const error = new Error("synthetic interruption");
        error.interrupted = true;
        throw error;
      }
    };
    assert.throws(() => upgrade.upgrade(f.c), /synthetic interruption/);
    const [id] = f.retained();
    assert.equal(fs.existsSync(f.c.hold), true);
    assert.throws(() => upgrade.upgrade(f.c), /already active/);
    const result = upgrade.rollback(f.c, id);
    assert.equal(result.phase, "rolled-back");
    assert.equal(f.app(), "old app");
    f.assertPreserved();
    assert.equal(fs.existsSync(f.c.hold), false);
  });
}
test("interrupted build can release only its dead owner hold while original app remains untouched", (t) => {
  const f = fixture(t);
  f.c.build = () => {
    const error = new Error("synthetic interruption");
    error.interrupted = true;
    throw error;
  };
  assert.throws(() => upgrade.upgrade(f.c), /synthetic interruption/);
  const result = upgrade.rollback(f.c, f.retained()[0]);
  assert.equal(result.phase, "aborted-before-replacement");
  assert.equal(f.app(), "old app");
  f.assertPreserved();
  assert(!f.calls.includes("stop"));
});
test("normal explicit rollback preserves current exact state and never copies old identity", (t) => {
  const f = fixture(t),
    { id } = upgrade.upgrade(f.c);
  upgrade.rollback(f.c, id);
  assert.equal(f.app(), "old app");
  f.assertPreserved();
});
test("rollback refuses if identity receipts or policy evolved since upgrade", (t) => {
  const f = fixture(t),
    { id } = upgrade.upgrade(f.c);
  const identity = path.join(f.c.state, "identity.json"),
    value = JSON.parse(fs.readFileSync(identity));
  value.completedCommands.push({ commandId: "new-real-command", sequence: 3 });
  fs.writeFileSync(identity, JSON.stringify(value));
  assert.throws(() => upgrade.rollback(f.c, id), /changed since upgrade/);
  assert.equal(f.app(), "new app");
  assert.equal(
    JSON.parse(fs.readFileSync(identity)).completedCommands.length,
    2,
  );
});
test("unknown/live upgrade owners or activity fences are never removed", (t) => {
  const f = fixture(t);
  f.c.checkpoint = () => {
    const error = new Error("crash");
    error.interrupted = true;
    throw error;
  };
  assert.throws(() => upgrade.upgrade(f.c));
  const id = f.retained()[0];
  f.c.processAlive = () => true;
  assert.throws(() => upgrade.rollback(f.c, id), /owner is still alive/);
  assert.equal(fs.existsSync(f.c.hold), true);
  f.c.processAlive = () => false;
  fs.writeFileSync(
    path.join(f.c.state, "source-access-activity.json"),
    '{"operationId":"someone-else"}',
  );
  assert.throws(() => upgrade.rollback(f.c, id), /Unknown\/live activity/);
});
test("wrong backup digest fails closed and leaves candidate plus receipts intact", (t) => {
  const f = fixture(t),
    { id } = upgrade.upgrade(f.c);
  fs.writeFileSync(
    path.join(f.c.backups, id, "app/dist/index.js"),
    "tampered backup",
  );
  assert.throws(() => upgrade.rollback(f.c, id), /integrity mismatch/);
  assert.equal(f.app(), "new app");
  f.assertPreserved();
  assert.equal(fs.existsSync(f.c.hold), true);
});
test("rollback validates exact IDs, never arbitrary paths", (t) => {
  const f = fixture(t);
  for (const id of ["../../etc", "/var/lib", "unknown"])
    assert.throws(() => upgrade.rollback(f.c, id), /Invalid upgrade ID/);
});
test("failed publication cannot claim success or erase the activity/upgrade fence", (t) => {
  const f = fixture(t),
    sync = f.c.sync;
  f.c.service.health = () => {
    f.c.sync = (directory) => {
      if (directory === f.c.state) throw new Error("synthetic fsync failure");
      sync(directory);
    };
  };
  assert.throws(() => upgrade.upgrade(f.c), /hold and artifacts retained/);
  assert.equal(fs.existsSync(f.c.hold), true);
  assert.equal(
    fs.existsSync(path.join(f.c.state, "source-access-activity.json")),
    true,
  );
  f.assertPreserved();
});
test("unknown hold files prevent cleanup without removing owner evidence", (t) => {
  const f = fixture(t);
  f.c.service.health = () =>
    fs.writeFileSync(path.join(f.c.hold, "unknown"), "unrelated");
  const error = captureFailure(() => upgrade.upgrade(f.c));
  assert.match(
    error.message,
    /Unknown files/,
    JSON.stringify(diagnostics.safeRecord(error)),
  );
  assert.equal(fs.existsSync(path.join(f.c.hold, "owner.json")), true);
  assert.equal(
    fs.readFileSync(path.join(f.c.hold, "unknown"), "utf8"),
    "unrelated",
  );
  f.assertPreserved();
});
test("EnvironmentFile is parsed literally and preserves TLS/database/hooks/roots without shell execution", () => {
  const env = upgrade.parseEnvironment(
    'PLUTON_SERVER_URL="https://example.internal"\nPLUTON_AGENT_ALLOWED_ROOTS="/srv/example-app,/srv/example-worker"\nPLUTON_AGENT_DATABASE_BIN_DIRS="/opt/example-clients"\nPLUTON_AGENT_HOOK_ROOT="/etc/example-hooks"\nPLUTON_AGENT_CLIENT_KEY_FILE="/etc/example.key"\n',
  );
  assert.equal(
    env.PLUTON_AGENT_ALLOWED_ROOTS,
    "/srv/example-app,/srv/example-worker",
  );
  assert.equal(env.PLUTON_AGENT_CLIENT_KEY_FILE, "/etc/example.key");
  assert.equal(
    upgrade.parseEnvironment('PLUTON_SERVER_URL="$(touch /tmp/never-executed)"')
      .PLUTON_SERVER_URL,
    "$(touch /tmp/never-executed)",
  );
  assert.throws(
    () => upgrade.parseEnvironment("NODE_OPTIONS=--require=bad"),
    /Custom service environment/,
  );
  assert.throws(
    () => upgrade.parseEnvironment("PLUTON_SERVER_URL=a\nPLUTON_SERVER_URL=b"),
    /repeated/,
  );
});
test("service preflight accepts only the installed unprivileged unit and exact executable/environment contract", (t) => {
  const f = fixture(t),
    c = f.c;
  const s = {
    LoadState: "loaded",
    Type: "simple",
    KillMode: "control-group",
    User: "pluton-agent",
    Group: "pluton-agent",
    FragmentPath: c.unit,
    NoNewPrivileges: "yes",
    CapabilityBoundingSet: "",
    DropInPaths: "",
    EnvironmentFiles: `${c.config} (ignore_errors=no)`,
    ActiveState: "active",
    ExecStart: `{ path=${c.node} ; argv[]=${c.node} ${c.app}/dist/index.js run ; ignore_errors=no ; }`,
  };
  upgrade.validateService(s, c);
  for (const [key, value] of [
    ["LoadState", "not-found"],
    ["Type", "forking"],
    ["User", "root"],
    ["Group", "root"],
    ["DropInPaths", "/etc/custom.conf"],
    ["EnvironmentFiles", "/tmp/unknown.env"],
    ["ExecStart", "/usr/bin/node arbitrary.js run"],
    ["FragmentPath", "/tmp/unknown.service"],
    ["ActiveState", "activating"],
    ["ExecStartPre", "/usr/bin/unknown"],
    ["ExecStop", "/usr/bin/unknown"],
    ["Environment", "NODE_OPTIONS=bad"],
    ["NoNewPrivileges", "no"],
    ["CapabilityBoundingSet", "cap_sys_admin"],
  ]) {
    assert.throws(
      () => upgrade.validateService({ ...s, [key]: value }, c),
      /Service contract differs/,
    );
  }
  assert(!f.calls.includes("stop"));
  f.assertPreserved();
});
test("capacity guard refuses missing, invalid or insufficient staging/backup headroom", () => {
  upgrade.validateDisk(3 * 1024 * 1024, 512);
  for (const available of [NaN, 0, -1, 2 * 1024 * 1024])
    assert.throws(
      () => upgrade.validateDisk(available, 512),
      /Insufficient free disk/,
    );
});

function captureFailure(operation) {
  try {
    operation();
  } catch (error) {
    return error;
  }
  assert.fail("Expected upgrade refusal");
}
function receiptFailure(f) {
  const [id] = f.retained();
  return JSON.parse(
    fs.readFileSync(path.join(f.c.backups, id, "receipt.json"), "utf8"),
  );
}
test("build diagnostics preserve category, keep service running and disclose no private error text", (t) => {
  const f = fixture(t);
  f.c.build = () => {
    throw new Error(
      "synthetic-private-build-marker /srv/private-app token=synthetic-private-value",
    );
  };
  const error = captureFailure(() => upgrade.upgrade(f.c));
  assert.deepEqual(diagnostics.safeRecord(error), {
    version: 1,
    failedStage: "BUILD",
    errorCode: "BUILD_FAILED",
    rollback: "NOT_NEEDED",
    previousAgentPreserved: "YES",
  });
  assert.deepEqual(receiptFailure(f).failure, diagnostics.safeRecord(error));
  assert(!diagnostics.formatFailure(error).includes("synthetic-private"));
  assert(!f.calls.includes("stop"));
  assert.equal(f.c.service.active(), true);
  f.assertPreserved();
});
for (const [target, code, stage] of [
  ["build", "BUILD_TIMEOUT", "BUILD"],
  ["start", "AGENT_START_FAILED", "SERVICE_START"],
  ["health", "AGENT_HEARTBEAT_FAILED", "HEALTH_CHECK"],
  ["health-timeout", "AGENT_HEALTH_TIMEOUT", "HEALTH_CHECK"],
]) {
  test(`structured ${target} failure survives successful cleanup/rollback without weakening checks`, (t) => {
    const f = fixture(t, { wasActive: false });
    const isTimeout = target.includes("timeout") || target === "build";
    const raw = Object.assign(
      new Error("synthetic-private-marker password=synthetic-private-value"),
      {
        code: isTimeout ? "ETIMEDOUT" : undefined,
        status: 1,
        stdout: "synthetic-private-marker",
        stderr: "synthetic-private-marker",
      },
    );
    const thrown = () => {
      throw diagnostics.commandFailure(raw, code, code);
    };
    if (target === "build") f.c.build = thrown;
    else if (target === "start") f.c.service.start = thrown;
    else f.c.service.health = thrown;
    const error = captureFailure(() => upgrade.upgrade(f.c));
    const d = diagnostics.safeRecord(error);
    assert.equal(d.failedStage, stage);
    assert.equal(d.errorCode, code);
    assert.equal(d.rollback, target === "build" ? "NOT_NEEDED" : "SUCCESS");
    assert.equal(d.previousAgentPreserved, "YES");
    assert.equal(f.app(), "old app");
    f.assertPreserved();
    assert.equal(fs.existsSync(f.c.hold), false);
    const receipt = receiptFailure(f);
    assert.equal(receipt.wasActive, target === "build" ? undefined : false);
    assert.equal(
      receipt.phase,
      target === "build" ? "building" : "rolled-back",
    );
    assert.deepEqual(receipt.failure, d);
    const text = diagnostics.formatFailure(error);
    assert(text.includes(`Failed stage: ${stage}`));
    assert(text.includes(`Error code: ${code}`));
    assert(!text.includes("synthetic-private-marker"));
    assert(!JSON.stringify(receipt).includes("synthetic-private-marker"));
  });
}
test("activation IO failure produces the same rolled-back receipt facts as health failure, but a distinct safe stage", (t) => {
  const f = fixture(t, { wasActive: false });
  const rename = fs.renameSync;
  let injected = false;
  try {
    fs.renameSync = (from, to) => {
      if (
        !injected &&
        path.basename(from).startsWith(".next-") &&
        to === f.c.app
      ) {
        injected = true;
        throw Object.assign(new Error("synthetic-private-activation-marker"), {
          code: "EIO",
        });
      }
      return rename(from, to);
    };
    const error = captureFailure(() => upgrade.upgrade(f.c));
    const d = diagnostics.safeRecord(error),
      receipt = receiptFailure(f);
    assert.equal(d.failedStage, "ACTIVATE_CANDIDATE");
    assert.equal(d.errorCode, "FILESYSTEM_IO_FAILED");
    assert.equal(d.rollback, "SUCCESS");
    assert.equal(receipt.phase, "rolled-back");
    assert.equal(receipt.wasActive, false);
    assert(receipt.previous && receipt.candidate);
    assert.equal(fs.existsSync(f.c.hold), false);
    assert.equal(f.app(), "old app");
    f.assertPreserved();
  } finally {
    fs.renameSync = rename;
  }
});
test("preservation mismatch retains both the primary failure and rollback refusal without overwriting changed state", (t) => {
  const f = fixture(t);
  f.c.service.health = () =>
    fs.appendFileSync(f.c.config, "# synthetic concurrent operator change\n");
  const error = captureFailure(() => upgrade.upgrade(f.c)),
    d = diagnostics.safeRecord(error);
  assert.equal(d.failedStage, "POST_HEALTH_PRESERVATION_CHECK");
  assert.equal(d.errorCode, "STATE_PRESERVATION_MISMATCH");
  assert.equal(d.rollback, "FAILED");
  assert.equal(d.previousAgentPreserved, "UNKNOWN");
  assert.deepEqual(d.rollbackFailure, {
    failedStage: "ROLLBACK_PRESERVATION_CHECK",
    errorCode: "STATE_PRESERVATION_MISMATCH",
  });
  assert.equal(f.app(), "new app");
  assert.equal(fs.existsSync(f.c.hold), true);
  assert(
    fs
      .readFileSync(f.c.config, "utf8")
      .includes("synthetic concurrent operator change"),
  );
  assert.deepEqual(receiptFailure(f).failure, d);
});
test("rollback health failure cannot replace the original upgrade error or report rollback success", (t) => {
  const f = fixture(t);
  f.c.service.health = () => {
    throw diagnostics.commandFailure({ status: 1 }, "AGENT_HEARTBEAT_FAILED");
  };
  const error = captureFailure(() => upgrade.upgrade(f.c)),
    d = diagnostics.safeRecord(error);
  assert.equal(d.failedStage, "HEALTH_CHECK");
  assert.equal(d.errorCode, "AGENT_HEARTBEAT_FAILED");
  assert.equal(d.rollback, "FAILED");
  assert.equal(d.rollbackFailure.failedStage, "ROLLBACK_HEALTH_CHECK");
  assert.equal(fs.existsSync(f.c.hold), true);
  assert.equal(f.app(), "old app");
  f.assertPreserved();
});
test("diagnostic receipt write failure cannot replace a successful rollback outcome or retry service actions", (t) => {
  const f = fixture(t, { wasActive: false }),
    sync = f.c.sync;
  f.c.service.health = () => {
    throw diagnostics.commandFailure({ status: 1 }, "AGENT_HEARTBEAT_FAILED");
  };
  f.c.sync = (directory) => {
    if (
      !fs.existsSync(f.c.hold) &&
      directory.startsWith(f.c.backups + path.sep)
    )
      throw new Error("synthetic-private-diagnostic-write-marker");
    sync(directory);
  };
  const error = captureFailure(() => upgrade.upgrade(f.c));
  assert.equal(diagnostics.safeRecord(error).rollback, "SUCCESS");
  assert.equal(
    diagnostics.safeRecord(error).errorCode,
    "AGENT_HEARTBEAT_FAILED",
  );
  assert(
    diagnostics
      .formatFailure(error)
      .includes("Diagnostic receipt: UNCONFIRMED"),
  );
  assert(!diagnostics.formatFailure(error).includes("synthetic-private"));
  assert.equal(f.app(), "old app");
  f.assertPreserved();
});
test("untrusted exception and spoofed diagnostic fields cannot leak through console/receipt formatting", () => {
  const marker = "synthetic-private-marker";
  const raw = Object.assign(new SyntaxError(marker), {
    stdout: marker,
    stderr: marker,
    path: marker,
    stage: marker,
    diagnostics: { errorCode: marker },
  });
  assert(!diagnostics.formatFailure(raw).includes(marker));
  assert(!JSON.stringify(diagnostics.safeRecord(raw)).includes(marker));
  const d = diagnostics.failureOf(raw, "HEALTH_CHECK");
  d.message = marker;
  d.stage = marker;
  d.code = marker;
  d.rollback = marker;
  d.previousAgentPreserved = marker;
  d.rollbackFailure = raw;
  assert(!diagnostics.formatFailure(d).includes(marker));
  assert(!JSON.stringify(diagnostics.safeRecord(d)).includes(marker));
  assert.equal(diagnostics.safeRecord(d).failedStage, "UNKNOWN");
});
test("a child nonzero exit is not inferred to be a timeout from output text", () => {
  const error = diagnostics.failureOf(
    diagnostics.commandFailure(
      { status: 1, stderr: "timeout password=synthetic-private-marker" },
      "AGENT_HEARTBEAT_FAILED",
    ),
    "HEALTH_CHECK",
  );
  assert.equal(
    diagnostics.safeRecord(error).errorCode,
    "AGENT_HEARTBEAT_FAILED",
  );
});
test("actual bounded subprocess exits/deadlines yield safe codes without retaining captured output", () => {
  for (const timedOut of [false, true]) {
    const raw = captureFailure(() =>
      execFileSync(
        process.execPath,
        [
          "-e",
          timedOut
            ? "process.stderr.write('synthetic-private-marker');setTimeout(()=>{},10000)"
            : "process.stderr.write('synthetic-private-marker');process.exit(9)",
        ],
        { timeout: timedOut ? 150 : 3000, stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
    if (timedOut) assert.equal(raw.code, "ETIMEDOUT");
    else assert.equal(raw.status, 9);
    const error = diagnostics.failureOf(
      diagnostics.commandFailure(
        raw,
        "AGENT_HEARTBEAT_FAILED",
        "AGENT_HEALTH_TIMEOUT",
      ),
      "HEALTH_CHECK",
    );
    assert.equal(
      diagnostics.safeRecord(error).errorCode,
      timedOut ? "AGENT_HEALTH_TIMEOUT" : "AGENT_HEARTBEAT_FAILED",
    );
    assert(
      !diagnostics.formatFailure(error).includes("synthetic-private-marker"),
    );
    assert(!JSON.stringify(error).includes("synthetic-private-marker"));
  }
});
test("full-tree provenance has a dedicated five-minute budget and closed error categories", () => {
  let invoked = false;
  const digest = "b".repeat(64);
  assert.equal(
    upgrade.verifiedInstallDigest(
      (file, args, options) => {
        invoked = true;
        assert.equal(file, "/usr/bin/bash");
        assert.deepEqual(args, [
          "-Eeuo",
          "pipefail",
          "-c",
          'source "$1/installers/install-agent.sh"; verified_tree_digest "$2"',
          "agent-integrity",
          "/synthetic/source",
          "/synthetic/install",
        ]);
        assert.deepEqual(options, {
          timeout: 300_000,
          failureCode: "PROVENANCE_FAILED",
          timeoutCode: "PROVENANCE_TIMEOUT",
        });
        return digest;
      },
      "/synthetic/source",
      "/synthetic/install",
    ),
    digest,
  );
  assert(invoked);
});

for (const wasActive of [false, true]) {
  for (const timedOut of [false, true]) {
    test(`real provenance command ${timedOut ? "deadline" : "failure"} rolls back with prior service active=${wasActive} and exact state preserved`, (t) => {
      const f = fixture(t, { wasActive }),
        previousProvenance = fs.readFileSync(f.c.provenance);
      f.c.writeProvenance = () =>
        upgrade.verifiedInstallDigest(
          (_file, _args, { timeout, failureCode, timeoutCode }) => {
            assert.equal(timeout, 300_000);
            // Exercise an actual child with a shorter test-only clock. There is
            // no environment/CLI override for the production provenance budget.
            try {
              return execFileSync(
                process.execPath,
                [
                  "-e",
                  timedOut
                    ? "process.stderr.write('synthetic-private-marker');setTimeout(()=>{},10000)"
                    : "process.stderr.write('synthetic-private-marker');process.exit(9)",
                ],
                {
                  timeout: timedOut ? 150 : 3000,
                  stdio: ["ignore", "pipe", "pipe"],
                },
              );
            } catch (raw) {
              assert.equal(
                timedOut ? raw.code : raw.status,
                timedOut ? "ETIMEDOUT" : 9,
              );
              throw diagnostics.commandFailure(raw, failureCode, timeoutCode);
            }
          },
          f.temporary,
          f.c.install,
        );
      const error = captureFailure(() => upgrade.upgrade(f.c)),
        record = diagnostics.safeRecord(error);
      assert.deepEqual(record, {
        version: 1,
        failedStage: "PROVENANCE",
        errorCode: timedOut ? "PROVENANCE_TIMEOUT" : "PROVENANCE_FAILED",
        rollback: "SUCCESS",
        previousAgentPreserved: "YES",
      });
      assert.equal(f.app(), "old app");
      f.assertPreserved();
      assert.deepEqual(fs.readFileSync(f.c.provenance), previousProvenance);
      assert.equal(f.c.service.active(), wasActive);
      assert.equal(
        f.calls.filter((call) => call === "start").length,
        wasActive ? 1 : 0,
      );
      assert.equal(receiptFailure(f).phase, "rolled-back");
      assert.deepEqual(receiptFailure(f).failure, record);
      assert.equal(fs.existsSync(f.c.hold), false);
      assert.equal(
        fs.existsSync(path.join(f.c.state, "source-access-activity.json")),
        false,
      );
      assert(
        !diagnostics.formatFailure(error).includes("synthetic-private-marker"),
      );
      assert(
        !JSON.stringify(receiptFailure(f)).includes("synthetic-private-marker"),
      );
    });
  }
}

test("CLI uses structured formatting and never prints untrusted invocation paths", () => {
  const error = captureFailure(() =>
    execFileSync(
      process.execPath,
      [
        path.join(__dirname, "../lib/upgrade-agent.cjs"),
        "synthetic-private-invocation-marker",
        "--unknown-option",
      ],
      { timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  assert.equal(error.status, 1);
  assert(error.stderr.includes("Failed stage: CONTEXT"));
  assert(error.stderr.includes("Error code: UPGRADE_CHECK_FAILED"));
  assert(!error.stderr.includes("synthetic-private-invocation-marker"));
  assert(!error.stderr.includes("at Object."));
});

function withBuildWorkspace(f) {
  const build = f.c.build,
    runtime = path.join(f.c.install, "runtime");
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, "runtime-marker"), "unchanged runtime");
  f.c.build = (id, next) => {
    build(id, next);
    const work = path.join(f.c.backups, id, "build"),
      stage = path.join(work, "stage");
    fs.mkdirSync(stage, { recursive: true });
    fs.symlinkSync(
      runtime,
      path.join(stage, "runtime"),
      linux ? "dir" : "junction",
    );
    fs.writeFileSync(path.join(work, "source.sha256"), "a".repeat(64));
    // Scratch caches can contain hardlinks; app/identity guards remain stricter.
    fs.linkSync(
      path.join(work, "source.sha256"),
      path.join(work, "cache-alias"),
    );
  };
  return runtime;
}
test("backup sync handles real build directory links without opening targets and preserves all 88 copied app files", (t) => {
  const f = fixture(t),
    runtime = withBuildWorkspace(f),
    open = fs.openSync,
    sync = f.c.sync,
    synced = [];
  for (let i = 0; i < 86; i++)
    fs.writeFileSync(path.join(f.c.app, "dist", `${i}.js`), `synthetic ${i}`);
  const previous = upgrade.treeDigest(f.c.app, f.c.owner, linux),
    runtimeDigest = upgrade.treeDigest(runtime, f.c.owner, linux),
    original = fs.statSync(path.join(f.c.app, "dist/index.js"));
  let openedLink = false;
  fs.openSync = (file, ...args) => {
    if (
      typeof file === "string" &&
      file.endsWith(path.join("build", "stage", "runtime"))
    )
      openedLink = true;
    return open(file, ...args);
  };
  f.c.sync = (directory) => {
    synced.push(directory);
    sync(directory);
  };
  let result;
  try {
    result = upgrade.upgrade(f.c);
  } finally {
    fs.openSync = open;
  }
  const transaction = path.join(f.c.backups, result.id),
    backup = path.join(transaction, "app");
  assert.equal(result.phase, "healthy");
  assert.equal(upgrade.treeDigest(backup, f.c.owner, linux), previous);
  assert.equal(fs.readdirSync(path.join(backup, "dist")).length + 1, 88);
  assert.equal(openedLink, false);
  assert(synced.includes(path.join(transaction, "build/stage")));
  assert(synced.includes(transaction));
  assert(
    fs
      .lstatSync(path.join(transaction, "build/stage/runtime"))
      .isSymbolicLink(),
  );
  assert.equal(upgrade.treeDigest(runtime, f.c.owner, linux), runtimeDigest);
  const prior = path.join(f.c.install, `.previous-${result.id}`);
  assert.equal(upgrade.treeDigest(prior, f.c.owner, linux), previous);
  assert.equal(
    fs.statSync(path.join(prior, "dist/index.js")).mtimeMs,
    original.mtimeMs,
  );
  f.assertPreserved();
});
test("copy success followed by app fsync EIO is distinguished and retains incomplete transaction evidence", (t) => {
  const f = fixture(t),
    open = fs.openSync,
    fsync = fs.fsyncSync,
    close = fs.closeSync,
    targets = new Set();
  let injected = false,
    closed = false;
  fs.openSync = (file, ...args) => {
    const fd = open(file, ...args);
    if (
      typeof file === "string" &&
      file.startsWith(f.c.backups + path.sep) &&
      file.endsWith(path.join("app", "dist", "index.js"))
    )
      targets.add(fd);
    return fd;
  };
  fs.fsyncSync = (fd) => {
    if (!injected && targets.has(fd)) {
      injected = true;
      throw Object.assign(new Error("synthetic-private-sync-marker"), {
        code: "EIO",
      });
    }
    return fsync(fd);
  };
  fs.closeSync = (fd) => {
    if (targets.delete(fd)) closed = true;
    return close(fd);
  };
  let error;
  try {
    error = captureFailure(() => upgrade.upgrade(f.c));
  } finally {
    fs.openSync = open;
    fs.fsyncSync = fsync;
    fs.closeSync = close;
  }
  const d = diagnostics.safeRecord(error),
    receipt = receiptFailure(f);
  assert(injected && closed);
  assert.equal(d.failedStage, "SYNC_APP");
  assert.equal(d.errorCode, "FILESYSTEM_IO_FAILED");
  assert.equal(d.rollback, "FAILED"); // Protected backups are not complete yet.
  assert.equal(receipt.phase, "drained");
  assert.equal(
    upgrade.treeDigest(
      path.join(f.c.backups, receipt.id, "app"),
      f.c.owner,
      linux,
    ),
    f.old,
  );
  assert.equal(fs.existsSync(f.c.hold), true);
  assert(!f.calls.includes("start"));
  assert.equal(f.app(), "old app");
  f.assertPreserved();
  assert(!diagnostics.formatFailure(error).includes("synthetic-private"));
});
test("late backup directory fsync failure propagates through successful startup rollback without losing the original app", (t) => {
  const f = fixture(t),
    sync = f.c.sync;
  withBuildWorkspace(f);
  let injected = false;
  f.c.sync = (directory) => {
    if (!injected && directory.endsWith(path.join("build", "stage"))) {
      injected = true;
      throw Object.assign(new Error("synthetic-private-directory-sync"), {
        code: "EIO",
      });
    }
    sync(directory);
  };
  const error = captureFailure(() => upgrade.upgrade(f.c)),
    d = diagnostics.safeRecord(error);
  assert(injected);
  assert.equal(d.failedStage, "SYNC_BACKUP");
  assert.equal(d.errorCode, "FILESYSTEM_IO_FAILED");
  assert.equal(d.rollback, "SUCCESS");
  assert.equal(d.previousAgentPreserved, "YES");
  assert.equal(receiptFailure(f).phase, "rolled-back");
  assert.equal(f.c.service.active(), true);
  assert.equal(f.calls.filter((call) => call === "start").length, 1);
  assert.equal(f.app(), "old app");
  f.assertPreserved();
  assert.equal(fs.existsSync(f.c.hold), false);
});
for (const kind of ["partial-app", "protected-permission"]) {
  test(`${kind} backup failure retains evidence and never activates an unprepared candidate`, (t) => {
    const f = fixture(t),
      cp = fs.cpSync,
      copy = fs.copyFileSync;
    fs.cpSync = (from, to, ...options) => {
      if (kind === "partial-app" && from === f.c.app) {
        fs.mkdirSync(to);
        fs.writeFileSync(
          path.join(to, "partial.js"),
          "synthetic partial backup",
        );
        throw Object.assign(new Error("synthetic-private-partial"), {
          code: "EIO",
        });
      }
      return cp(from, to, ...options);
    };
    fs.copyFileSync = (from, to, ...options) => {
      if (kind === "protected-permission" && from === f.c.unit)
        throw Object.assign(new Error("synthetic-private-permission"), {
          code: "EACCES",
        });
      return copy(from, to, ...options);
    };
    let error;
    try {
      error = captureFailure(() => upgrade.upgrade(f.c));
    } finally {
      fs.cpSync = cp;
      fs.copyFileSync = copy;
    }
    const d = diagnostics.safeRecord(error),
      receipt = receiptFailure(f);
    assert.equal(
      d.failedStage,
      kind === "partial-app" ? "COPY_APP" : "COPY_PROTECTED_FILES",
    );
    assert.equal(
      d.errorCode,
      kind === "partial-app"
        ? "FILESYSTEM_IO_FAILED"
        : "FILESYSTEM_PERMISSION_DENIED",
    );
    assert.equal(d.rollback, "FAILED");
    assert.equal(receipt.phase, "drained");
    assert.equal(fs.existsSync(f.c.hold), true);
    assert.equal(upgrade.treeDigest(f.c.app, f.c.owner, linux), f.old);
    assert.equal(
      fs.readFileSync(f.c.provenance, "utf8"),
      "old verified provenance",
    );
    assert(!f.calls.includes("start"));
    f.assertPreserved();
    assert(!JSON.stringify(receipt.failure).includes("synthetic-private"));
  });
}
test("sync rejects links outside build scratch and never opens their targets", (t) => {
  const f = fixture(t),
    outside = path.join(f.temporary, "outside"),
    tree = path.join(f.temporary, "tree");
  fs.mkdirSync(outside);
  fs.mkdirSync(tree);
  fs.symlinkSync(outside, path.join(tree, "link"), linux ? "dir" : "junction");
  const error = captureFailure(() =>
    upgrade.syncTree(tree, f.c.sync, path.join(tree, "build")),
  );
  assert.equal(diagnostics.safeRecord(error).errorCode, "SYNC_ENTRY_UNSAFE");
  assert.throws(
    () => upgrade.syncFile(path.join(tree, "link")),
    /regular file/,
  );
  assert.equal(fs.readdirSync(outside).length, 0);
});
test("sync refuses file replacement during open, closes the descriptor and never flushes the unrelated file", (t) => {
  const f = fixture(t),
    expected = path.join(f.temporary, "expected"),
    replacement = path.join(f.temporary, "replacement");
  fs.writeFileSync(expected, "synthetic expected");
  fs.writeFileSync(replacement, "synthetic unrelated");
  const open = fs.openSync,
    close = fs.closeSync,
    fsync = fs.fsyncSync;
  let opened,
    closed = false,
    flushed = false,
    error;
  fs.openSync = (file, ...args) => {
    const fd = open(file === expected ? replacement : file, ...args);
    if (file === expected) opened = fd;
    return fd;
  };
  fs.closeSync = (fd) => {
    if (fd === opened) closed = true;
    return close(fd);
  };
  fs.fsyncSync = (fd) => {
    if (fd === opened) flushed = true;
    return fsync(fd);
  };
  try {
    error = captureFailure(() => upgrade.syncFile(expected));
  } finally {
    fs.openSync = open;
    fs.closeSync = close;
    fs.fsyncSync = fsync;
  }
  assert.equal(diagnostics.safeRecord(error).errorCode, "SYNC_ENTRY_UNSAFE");
  assert(closed && !flushed);
  assert.equal(fs.readFileSync(replacement, "utf8"), "synthetic unrelated");
});
test(
  "Linux directory-link r+ reproduction and read-only fsync preserve bytes, modes, owner and timestamps",
  { skip: !linux },
  (t) => {
    const f = fixture(t),
      work = path.join(f.temporary, "transaction/build"),
      runtime = path.join(f.temporary, "runtime");
    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync(runtime);
    const link = path.join(work, "runtime"),
      file = path.join(work, "readonly.js");
    fs.symlinkSync(runtime, link);
    fs.writeFileSync(file, "synthetic readonly", { mode: 0o444 });
    fs.utimesSync(file, 1000, 1000);
    const before = fs.statSync(file);
    assert.throws(
      () => fs.openSync(link, "r+"),
      (error) => error.code === "EISDIR",
    );
    const open = fs.openSync,
      fsync = fs.fsyncSync;
    let sawReadonly = false,
      syncCount = 0;
    fs.openSync = (name, flags, ...rest) => {
      if (name === file) {
        sawReadonly = true;
        assert.equal(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR), 0);
        assert(flags & fs.constants.O_NOFOLLOW);
      }
      return open(name, flags, ...rest);
    };
    fs.fsyncSync = (fd) => {
      syncCount++;
      return fsync(fd);
    };
    try {
      upgrade.syncTree(path.dirname(work), upgrade.syncDirectory, work);
    } finally {
      fs.openSync = open;
      fs.fsyncSync = fsync;
    }
    assert(sawReadonly && syncCount >= 3); // File, build directory and parent directory.
    const after = fs.statSync(file);
    for (const field of ["mode", "uid", "gid", "size", "mtimeMs"])
      assert.equal(after[field], before[field]);
    assert.equal(fs.readFileSync(file, "utf8"), "synthetic readonly");
  },
);
test(
  "Linux real file permission refusal is fail-closed without chmod as recovery",
  { skip: !linux || process.getuid?.() === 0 },
  (t) => {
    const f = fixture(t),
      file = path.join(f.temporary, "unreadable");
    fs.writeFileSync(file, "synthetic unreadable", { mode: 0o000 });
    t.after(() => {
      if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
    });
    assert.throws(
      () => upgrade.syncFile(file),
      (error) => error.code === "EACCES",
    );
    assert.equal(fs.statSync(file).mode & 0o777, 0);
  },
);
test(
  "Linux directory fsync, backup 0700 and credential backup 0600 are real filesystem checks",
  { skip: !linux },
  (t) => {
    const f = fixture(t),
      { id } = upgrade.upgrade(f.c);
    assert.equal(fs.statSync(path.join(f.c.backups, id)).mode & 0o777, 0o700);
    assert.equal(
      fs.statSync(path.join(f.c.backups, id, "agent.env")).mode & 0o777,
      0o600,
    );
    upgrade.syncDirectory(f.c.install);
  },
);
test(
  "Linux atomic publication refuses symlinks and group-writable artifacts",
  { skip: !linux },
  (t) => {
    const f = fixture(t),
      original = path.join(f.c.app, "dist/index.js");
    fs.chmodSync(original, 0o666);
    assert.throws(() => upgrade.treeDigest(f.c.app, f.c.owner), /unsafe/);
    fs.chmodSync(original, 0o644);
    fs.symlinkSync(original, path.join(f.c.app, "link"));
    assert.throws(() => upgrade.treeDigest(f.c.app, f.c.owner), /unsafe/);
  },
);

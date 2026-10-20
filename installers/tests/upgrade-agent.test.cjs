"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const upgrade = require("../lib/upgrade-agent.cjs");
const root = path.resolve(__dirname, "../../tmp/agent-upgrade");
fs.mkdirSync(root, { recursive: true });
const linux = process.platform === "linux";

function fixture(t) {
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
  let active = true;
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
    assert.equal(active, true);
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
  assert.throws(() => upgrade.upgrade(f.c), /Unknown files/);
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

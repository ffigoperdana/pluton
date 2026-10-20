/* Local upgrade transaction for the community Agent. No enrollment, remote shell,
 * unit generation, policy mutation or restoration of historical identity state. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const {
  GuardFailure,
  commandFailure,
  failureOf,
  atStage,
  outcome,
  safeRecord,
  formatFailure,
} = require("./upgrade-diagnostics.cjs");

const ID = /^[0-9]{14}-[a-f0-9]{12}-[a-f0-9]{12}$/;
const ACTIVITY = "source-access-activity.json";
const HOLD = ".upgrade-lock";
const hash = (data) => crypto.createHash("sha256").update(data).digest("hex");
const exists = (file) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
};
function requireSafe(condition, message, code) {
  if (!condition) throw new GuardFailure(message, code);
}
function syncDirectory(directory) {
  const fd = fs.openSync(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function protectedPath(file, directory = false, uid = 0) {
  let current = file;
  for (;;) {
    const stat = fs.lstatSync(current);
    requireSafe(
      !stat.isSymbolicLink() &&
        stat.uid === uid &&
        !(stat.mode & 0o022) &&
        (current === file && !directory
          ? stat.isFile() && stat.nlink === 1
          : stat.isDirectory()),
      "Unprotected installation path.",
    );
    if (current === path.dirname(current)) break;
    current = path.dirname(current);
  }
}
function treeDigest(directory, owner = 0, enforceModes = true) {
  const entries = [];
  function walk(file, relative) {
    const stat = fs.lstatSync(file);
    requireSafe(
      !stat.isSymbolicLink() &&
        (stat.isDirectory() || stat.isFile()) &&
        (!stat.isFile() || stat.nlink === 1) &&
        stat.uid === owner &&
        (!enforceModes || !(stat.mode & 0o022)),
      "Application contains an unsafe file or ownership.",
    );
    entries.push([
      relative,
      stat.mode & 0o777,
      stat.isFile() ? hash(fs.readFileSync(file)) : "directory",
    ]);
    if (stat.isDirectory())
      for (const name of fs.readdirSync(file).sort())
        walk(path.join(file, name), `${relative}/${name}`);
  }
  walk(directory, ".");
  return hash(JSON.stringify(entries));
}
function durableWrite(file, data, sync = syncDirectory, mode = 0o600) {
  const temporary = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = fs.openSync(
    temporary,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    mode,
  );
  try {
    fs.writeFileSync(fd, data);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  sync(path.dirname(file));
}
function parseEnvironment(raw) {
  requireSafe(
    Buffer.byteLength(raw) <= 256 * 1024,
    "EnvironmentFile is oversized.",
  );
  const values = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const item = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    requireSafe(
      item && values[item[1]] === undefined,
      "Unsupported or repeated EnvironmentFile entry.",
    );
    const value = item[2];
    if (value.startsWith('"')) {
      requireSafe(
        /^"(?:[^"\\]|\\["\\])*"$/.test(value),
        "Unsupported EnvironmentFile quoting; no shell evaluation is allowed.",
      );
      values[item[1]] = value.slice(1, -1).replace(/\\(["\\])/g, "$1");
    } else {
      requireSafe(
        !/[\s'"\\]/.test(value),
        "Unsupported EnvironmentFile quoting.",
      );
      values[item[1]] = value;
    }
    requireSafe(
      item[1].startsWith("PLUTON_") || item[1] === "ALLOW_INSECURE_HTTP",
      "Custom service environment requires operator review.",
    );
  }
  return values;
}
function identityBinding(state) {
  const identity = JSON.parse(
    fs.readFileSync(path.join(state, "identity.json"), "utf8"),
  );
  requireSafe(
    typeof identity.agentId === "string" &&
      /^[A-Za-z0-9_-]{1,160}$/.test(identity.agentId) &&
      typeof identity.deviceId === "string" &&
      identity.deviceId &&
      typeof identity.secret === "string" &&
      identity.secret &&
      Number.isInteger(identity.pollIntervalSeconds) &&
      Array.isArray(identity.completedCommands),
    "Existing enrolled identity is required.",
  );
  return {
    agentId: identity.agentId,
    digest: hash(
      JSON.stringify([identity.agentId, identity.deviceId, identity.secret]),
    ),
  };
}
function preservedDigest(c) {
  const entries = [];
  const add = (file) => {
    const s = fs.lstatSync(file);
    requireSafe(
      s.isFile() && !s.isSymbolicLink() && s.nlink === 1,
      "Preserved state must be regular files.",
    );
    entries.push([
      file,
      s.uid,
      s.gid,
      s.mode & 0o777,
      hash(fs.readFileSync(file)),
    ]);
  };
  add(c.config);
  add(c.unit);
  for (const name of fs.readdirSync(c.state).sort()) {
    if (
      name === "identity.json" ||
      (name.startsWith("source-access-") && name !== ACTIVITY)
    )
      add(path.join(c.state, name));
  }
  if (exists(c.policy))
    entries.push(["hostPolicy", treeDigest(c.policy, c.owner, c.enforceModes)]);
  return hash(JSON.stringify(entries));
}
function assertLocallyDrained(c) {
  requireSafe(
    !exists(path.join(c.policy, ".source-access.lock")),
    "A local Source Access writer is pending; review its exact owner first.",
  );
  requireSafe(
    !exists(path.join(c.state, "source-access-pending.json")),
    "Pending Source Access publication requires exact operator recovery.",
  );
  const jobs = path.join(c.state, "jobs");
  requireSafe(
    !exists(jobs) ||
      (fs.lstatSync(jobs).isDirectory() &&
        !fs.lstatSync(jobs).isSymbolicLink() &&
        fs.readdirSync(jobs).length === 0),
    "Agent job workspace remains; drain/review it without blind cleanup.",
  );
  // A live setup receipt can still change authority. Never consume/cancel it here.
  const setup = path.join(c.state, "source-access-mode-setup.json");
  if (exists(setup)) {
    const receipt = JSON.parse(fs.readFileSync(setup, "utf8"));
    requireSafe(
      receipt.consumedRequestId ||
        (Number.isSafeInteger(receipt.command?.payload?.expiresAt) &&
          receipt.command.payload.expiresAt + 5 * 60_000 < Date.now()),
      "Pending host mode setup must finish or expire before upgrade.",
    );
  }
}
function acquireActivity(c, operationId) {
  const filename = path.join(c.state, ACTIVITY);
  const token = JSON.stringify({
    version: 1,
    agentId: identityBinding(c.state).agentId,
    pid: process.pid,
    operationId,
  });
  const fd = fs.openSync(
    filename,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (process.platform === "linux") fs.fchownSync(fd, c.agentUid, c.agentGid);
    fs.writeFileSync(fd, token);
    fs.fsyncSync(fd);
    c.sync(c.state);
  } finally {
    fs.closeSync(fd);
  }
  return token;
}
function releaseActivity(c, token) {
  const filename = path.join(c.state, ACTIVITY);
  requireSafe(
    fs.readFileSync(filename, "utf8") === token,
    "Activity fence ownership changed; no cleanup performed.",
  );
  fs.unlinkSync(filename);
  try {
    c.sync(c.state);
  } catch (error) {
    // The installation hold still blocks the new Agent. Restore the exact fence.
    durableWrite(filename, token, c.sync);
    if (process.platform === "linux")
      fs.chownSync(filename, c.agentUid, c.agentGid);
    throw error;
  }
}
function normalizeApp(directory) {
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name),
      stat = fs.lstatSync(file);
    requireSafe(
      !stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()),
      "Unsafe staged application.",
    );
    if (stat.isDirectory()) normalizeApp(file);
    fs.chmodSync(file, stat.isDirectory() ? 0o755 : 0o644);
  }
  fs.chmodSync(directory, 0o755);
}
function validateService(s, c) {
  requireSafe(
    s.LoadState === "loaded" &&
      s.Type === "simple" &&
      s.KillMode === "control-group" &&
      s.User === "pluton-agent" &&
      s.Group === "pluton-agent" &&
      s.FragmentPath === c.unit &&
      !s.DropInPaths &&
      !s.Environment &&
      !s.ExecStartPre &&
      !s.ExecStartPost &&
      !s.ExecStop &&
      !s.ExecStopPost &&
      !s.RootDirectory &&
      !s.RootImage &&
      s.NoNewPrivileges === "yes" &&
      !s.CapabilityBoundingSet &&
      s.EnvironmentFiles === `${c.config} (ignore_errors=no)` &&
      s.ExecStart.includes(
        `path=${c.node} ; argv[]=${c.node} ${c.app}/dist/index.js run ;`,
      ) &&
      ["active", "inactive"].includes(s.ActiveState),
    "Service contract differs from the supported installer unit. No unit changes were made.",
  );
}
function validateDisk(available, appKiB) {
  requireSafe(
    Number.isFinite(available) &&
      Number.isFinite(appKiB) &&
      appKiB > 0 &&
      available >= 2 * appKiB + 2 * 1024 * 1024,
    "Insufficient free disk: preserve at least 2 GiB plus two app copies on each staging/backup filesystem.",
  );
}
function syncFile(file) {
  const before = fs.lstatSync(file);
  requireSafe(
    before.isFile() && !before.isSymbolicLink(),
    "Synchronization requires a regular file.",
    "SYNC_ENTRY_UNSAFE",
  );
  const fd = fs.openSync(
    file,
    // Linux fsync accepts a read-only regular-file descriptor. Windows requires
    // a writable handle for FlushFileBuffers in the portable synthetic tests.
    (process.platform === "win32"
      ? fs.constants.O_RDWR
      : fs.constants.O_RDONLY) |
      fs.constants.O_NOFOLLOW |
      fs.constants.O_NONBLOCK,
  );
  try {
    const opened = fs.fstatSync(fd);
    requireSafe(
      opened.isFile() && opened.dev === before.dev && opened.ino === before.ino,
      "Synchronization entry changed during open.",
      "SYNC_ENTRY_UNSAFE",
    );
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function syncTree(directory, sync, buildRoot) {
  requireSafe(
    fs.lstatSync(directory).isDirectory(),
    "Synchronization requires a real directory.",
    "SYNC_ENTRY_UNSAFE",
  );
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name),
      stat = fs.lstatSync(file);
    if (stat.isSymbolicLink())
      // Build scratch deliberately links the private runtime. Persist the link
      // entry via its parent below; never open, traverse or sync its target.
      requireSafe(
        buildRoot && file.startsWith(buildRoot + path.sep),
        "Symlink outside build scratch refused during synchronization.",
        "SYNC_ENTRY_UNSAFE",
      );
    else if (stat.isDirectory()) syncTree(file, sync, buildRoot);
    else syncFile(file);
  }
  sync(directory);
}
function copyAppFiles(from, to, c) {
  treeDigest(from, c.owner, c.enforceModes);
  fs.cpSync(from, to, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
}
function copyApp(from, to, c) {
  copyAppFiles(from, to, c);
  syncTree(to, c.sync);
}
function save(c, receipt) {
  durableWrite(
    path.join(c.backups, receipt.id, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    c.sync,
  );
}

/** Injectable OS/build adapters allow disposable tests without a real service. */
function upgrade(c) {
  atStage("PREFLIGHT", () => {
    c.preflight();
    assertLocallyDrained(c);
    requireSafe(
      !exists(c.hold),
      "An upgrade is already active/interrupted. Review its exact receipt before rollback.",
    );
    requireSafe(
      !exists(path.join(c.state, ACTIVITY)),
      "Agent operation is active; nothing was stopped. Retry after drain.",
    );
  });
  const id =
    new Date().toISOString().replace(/\D/g, "").slice(0, 14) +
    "-" +
    c.commit.slice(0, 12) +
    "-" +
    crypto.randomBytes(6).toString("hex");
  const r = atStage("LOCK_SETUP", () => {
    fs.mkdirSync(c.hold, { mode: 0o700 });
    c.sync(c.install);
    durableWrite(
      path.join(c.hold, "owner.json"),
      JSON.stringify({ id, pid: process.pid }),
      c.sync,
    );
    durableWrite(
      path.join(c.hold, "node.sha256"),
      hash(fs.readFileSync(c.node)),
      c.sync,
    );
    fs.mkdirSync(c.backups, { recursive: true, mode: 0o700 });
    requireSafe(
      !c.enforceModes || (fs.statSync(c.backups).mode & 0o777) === 0o700,
      "Backup parent must already be private; no permissions were changed.",
    );
    fs.mkdirSync(path.join(c.backups, id), { mode: 0o700 });
    c.sync(c.backups);
    const receipt = {
      version: 1,
      id,
      commit: c.commit,
      phase: "building",
      binding: identityBinding(c.state).digest,
      previous: treeDigest(c.app, c.owner, c.enforceModes),
    };
    save(c, receipt);
    return receipt;
  });
  let fence,
    stopped = false,
    stopAttempted = false,
    unlocked = false;
  let stage = "ACTIVITY_FENCE";
  const previous = path.join(c.install, `.previous-${id}`);
  const next = path.join(c.install, `.next-${id}`);
  try {
    fence = acquireActivity(c, id);
    r.activity = fence;
    stage = "PRESERVATION_CHECK";
    r.preserved = preservedDigest(c);
    stage = "DRAIN_CHECK";
    c.service.assertIdle();
    stage = "RECEIPT_WRITE";
    save(c, r);
    stage = "BUILD";
    c.build(id, next);
    stage = "CANDIDATE_VERIFY";
    normalizeApp(next);
    requireSafe(
      exists(path.join(next, "dist/index.js")) &&
        exists(path.join(next, "package.json")),
      "Build did not produce a complete application.",
    );
    c.verifyCandidate(next);
    syncTree(next, c.sync);
    r.candidate = treeDigest(next, c.owner, c.enforceModes);
    requireSafe(
      r.previous === treeDigest(c.app, c.owner, c.enforceModes),
      "Installed application changed during build.",
    );
    // Check again after the potentially long dependency/build step.
    stage = "POST_BUILD_PREFLIGHT";
    c.preflight();
    assertLocallyDrained(c);
    requireSafe(
      fs.readFileSync(path.join(c.state, ACTIVITY), "utf8") === fence,
      "Activity fence changed during build.",
    );
    stage = "PRESERVATION_CHECK";
    requireSafe(
      preservedDigest(c) === r.preserved,
      "Protected state changed during build; no service was stopped.",
      "STATE_PRESERVATION_MISMATCH",
    );
    stage = "DRAIN_CHECK";
    c.service.assertIdle();
    r.wasActive = c.service.active();
    r.phase = "drained";
    stage = "RECEIPT_WRITE";
    save(c, r);
    stage = "SERVICE_STOP";
    stopAttempted = true;
    c.service.stop();
    stopped = true;
    requireSafe(!c.service.active(), "Service did not stop.");
    c.service.assertEmpty();
    stage = "PRESERVATION_CHECK";
    requireSafe(
      preservedDigest(c) === r.preserved,
      "State changed while stopping the drained service.",
      "STATE_PRESERVATION_MISMATCH",
    );
    stage = "COPY_APP";
    copyAppFiles(c.app, path.join(c.backups, id, "app"), c);
    stage = "SYNC_APP";
    syncTree(path.join(c.backups, id, "app"), c.sync);
    stage = "COPY_PROTECTED_FILES";
    for (const [from, name] of [
      [c.config, "agent.env"],
      [c.unit, "pluton-agent.service"],
      [c.provenance, "verified-install"],
    ]) {
      fs.copyFileSync(
        from,
        path.join(c.backups, id, name),
        fs.constants.COPYFILE_EXCL,
      );
      fs.chmodSync(path.join(c.backups, id, name), 0o600);
    }
    stage = "SYNC_BACKUP";
    syncTree(
      path.join(c.backups, id),
      c.sync,
      path.join(c.backups, id, "build"),
    );
    r.phase = "prepared";
    stage = "RECEIPT_WRITE";
    save(c, r);
    stage = "PREPARED_CHECKPOINT";
    c.checkpoint("prepared");
    stage = "ACTIVATE_PREVIOUS";
    fs.renameSync(c.app, previous);
    c.sync(c.install);
    r.phase = "old-moved";
    stage = "RECEIPT_WRITE";
    save(c, r);
    stage = "ACTIVATE_PREVIOUS";
    c.checkpoint("old-moved");
    stage = "ACTIVATE_CANDIDATE";
    fs.renameSync(next, c.app);
    c.sync(c.install);
    r.phase = "activated";
    stage = "RECEIPT_WRITE";
    save(c, r);
    stage = "PROVENANCE";
    c.writeProvenance(id);
    stage = "ACTIVATED_CHECKPOINT";
    c.checkpoint("activated");
    stage = "PRESERVATION_CHECK";
    requireSafe(
      preservedDigest(c) === r.preserved,
      "Preserved state changed during replacement.",
      "STATE_PRESERVATION_MISMATCH",
    );
    stage = "SERVICE_START";
    c.service.start();
    stage = "HEALTH_CHECK";
    c.service.health();
    stage = "POST_HEALTH_PRESERVATION_CHECK";
    requireSafe(
      preservedDigest(c) === r.preserved,
      "Health check changed protected state/artifacts.",
      "STATE_PRESERVATION_MISMATCH",
    );
    stage = "POST_HEALTH_ARTIFACT_CHECK";
    requireSafe(
      treeDigest(c.app, c.owner, c.enforceModes) === r.candidate,
      "Health check changed protected state/artifacts.",
      "ARTIFACT_INTEGRITY_MISMATCH",
    );
    stage = "RECEIPT_WRITE";
    r.phase = "healthy";
    save(c, r);
    stage = "FENCE_RELEASE";
    releaseActivity(c, fence);
    fence = undefined;
    // This is the commit point. Never stop/roll back an Agent after releasing its
    // work hold: it may have accepted a real command immediately afterwards.
    unlocked = true;
    stage = "HOLD_RELEASE";
    releaseHold(c, id);
    return { id, commit: c.commit, phase: "healthy" };
  } catch (error) {
    if (error.interrupted) throw error;
    const primary = failureOf(error, stage);
    if (unlocked || (stopAttempted && !stopped)) {
      const failure = outcome(
        primary,
        "NOT_ATTEMPTED",
        "UNKNOWN",
        primary.message,
      );
      recordFailure(c, r, failure);
      throw failure;
    }
    r.failure = safeRecord(outcome(primary, "INCOMPLETE", "UNKNOWN"));
    let rollbackStage = "ROLLBACK_DRAIN";
    const needsRollback = Boolean(stopped && r.preserved);
    try {
      requireSafe(
        fence || !exists(path.join(c.state, ACTIVITY)),
        "Uncertain/foreign activity fence retained for review.",
      );
      if (stopped && r.preserved) {
        rollbackStage = "ROLLBACK_PRESERVATION_CHECK";
        requireSafe(
          preservedDigest(c) === r.preserved,
          "Protected state changed; automatic rollback refused.",
          "STATE_PRESERVATION_MISMATCH",
        );
        rollbackStage = "ROLLBACK_DRAIN";
        c.service.assertIdle();
        c.service.stop();
        c.service.assertEmpty();
        rollbackStage = "ROLLBACK_RESTORE";
        restorePrevious(c, r);
        r.phase = "rolled-back";
        rollbackStage = "ROLLBACK_RECEIPT_WRITE";
        save(c, r);
        if (r.wasActive) {
          rollbackStage = "ROLLBACK_SERVICE_START";
          c.service.start();
          rollbackStage = "ROLLBACK_HEALTH_CHECK";
          c.service.health();
        }
      }
      rollbackStage = "ROLLBACK_FENCE_RELEASE";
      if (fence) releaseActivity(c, fence);
      rollbackStage = "ROLLBACK_HOLD_RELEASE";
      releaseHold(c, id);
    } catch (rollbackError) {
      const failure = outcome(
        primary,
        "FAILED",
        "UNKNOWN",
        `Upgrade failed; hold and artifacts retained for exact operator review. Upgrade ID: ${id}`,
        failureOf(rollbackError, rollbackStage),
      );
      recordFailure(c, r, failure);
      throw failure;
    }
    const failure = outcome(
      primary,
      needsRollback ? "SUCCESS" : "NOT_NEEDED",
      previousStatus(c, r),
      `Upgrade failed safely; prior app retained/restored. Upgrade ID: ${id}`,
    );
    recordFailure(c, r, failure);
    throw failure;
  }
}
function previousStatus(c, r) {
  try {
    return preservedDigest(c) === r.preserved &&
      treeDigest(c.app, c.owner, c.enforceModes) === r.previous
      ? "YES"
      : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}
function recordFailure(c, r, failure) {
  failure.upgradeId = r.id;
  r.failure = safeRecord(failure);
  // Diagnostic persistence cannot change rollback decisions, retry a service
  // action, erase state or replace the primary failure if storage is broken.
  try {
    save(c, r);
  } catch {
    failure.diagnosticReceiptUnavailable = true;
  }
}
function releaseHold(c, id) {
  requireSafe(
    JSON.parse(fs.readFileSync(path.join(c.hold, "owner.json"), "utf8")).id ===
      id,
    "Upgrade lock ownership mismatch.",
  );
  requireSafe(
    JSON.stringify(fs.readdirSync(c.hold).sort()) ===
      JSON.stringify(["node.sha256", "owner.json"]),
    "Unknown files in upgrade hold; no cleanup performed.",
  );
  // Remove only this process's known lock files. Unknown files prevent rmdir.
  fs.unlinkSync(path.join(c.hold, "node.sha256"));
  fs.unlinkSync(path.join(c.hold, "owner.json"));
  fs.rmdirSync(c.hold);
  try {
    c.sync(c.install);
  } catch (error) {
    fs.mkdirSync(c.hold, { mode: 0o700 });
    durableWrite(
      path.join(c.hold, "owner.json"),
      JSON.stringify({ id, durabilityUncertain: true }),
      c.sync,
    );
    durableWrite(
      path.join(c.hold, "node.sha256"),
      hash(fs.readFileSync(c.node)),
      c.sync,
    );
    throw error;
  }
}
function restorePrevious(c, r) {
  const previous = path.join(c.install, `.previous-${r.id}`);
  const backup = path.join(c.backups, r.id, "app");
  requireSafe(
    treeDigest(backup, c.owner, c.enforceModes) === r.previous,
    "Rollback backup integrity mismatch.",
  );
  if (exists(c.app)) {
    const digest = treeDigest(c.app, c.owner, c.enforceModes);
    if (digest === r.previous) {
      durableWrite(
        c.provenance,
        fs.readFileSync(path.join(c.backups, r.id, "verified-install")),
        c.sync,
        0o644,
      );
      return;
    }
    requireSafe(
      digest === r.candidate,
      "Unknown current application; rollback refused.",
    );
    const failed = path.join(c.install, `.failed-${r.id}`);
    requireSafe(!exists(failed), "Failed-artifact destination already exists.");
    fs.renameSync(c.app, failed);
    c.sync(c.install);
  }
  if (exists(previous)) {
    requireSafe(
      treeDigest(previous, c.owner, c.enforceModes) === r.previous,
      "Previous application integrity mismatch.",
    );
    fs.renameSync(previous, c.app);
    c.sync(c.install);
  } else copyApp(backup, c.app, c);
  durableWrite(
    c.provenance,
    fs.readFileSync(path.join(c.backups, r.id, "verified-install")),
    c.sync,
    0o644,
  );
}
function rollback(c, id) {
  requireSafe(ID.test(id), "Invalid upgrade ID.");
  const receiptFile = path.join(c.backups, id, "receipt.json");
  c.verifyReceipt(receiptFile);
  const r = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  requireSafe(
    r.version === 1 &&
      r.id === id &&
      /^[a-f0-9]{64}$/.test(r.previous || "") &&
      r.binding === identityBinding(c.state).digest,
    "Unknown or incomplete rollback receipt.",
  );
  if (r.phase !== "building")
    requireSafe(
      preservedDigest(c) === r.preserved,
      "Identity/receipts/policy/config changed since upgrade; automatic downgrade refused.",
    );
  assertLocallyDrained(c);
  const ownHold = exists(c.hold);
  if (ownHold) {
    const owner = JSON.parse(
      fs.readFileSync(path.join(c.hold, "owner.json"), "utf8"),
    );
    requireSafe(
      owner.id === id && !c.processAlive(owner.pid),
      "Upgrade owner is still alive or ownership differs.",
    );
  } else {
    fs.mkdirSync(c.hold, { mode: 0o700 });
    c.sync(c.install);
    durableWrite(
      path.join(c.hold, "owner.json"),
      JSON.stringify({ id, pid: process.pid }),
      c.sync,
    );
    durableWrite(
      path.join(c.hold, "node.sha256"),
      hash(fs.readFileSync(c.node)),
      c.sync,
    );
  }
  let token;
  const activity = path.join(c.state, ACTIVITY);
  if (exists(activity)) {
    token = fs.readFileSync(activity, "utf8");
    requireSafe(
      token === r.activity && !c.processAlive(JSON.parse(token).pid),
      "Unknown/live activity fence; rollback refused.",
    );
  } else token = acquireActivity(c, id);
  if (r.phase === "building" || r.phase === "drained") {
    requireSafe(
      treeDigest(c.app, c.owner, c.enforceModes) === r.previous,
      "Application changed before replacement; operator review required.",
    );
    c.service.assertIdle();
    if (r.phase === "drained" && r.wasActive && !c.service.active()) {
      c.service.start();
      c.service.health();
    }
    r.phase = "aborted-before-replacement";
    save(c, r);
    releaseActivity(c, token);
    releaseHold(c, id);
    return { id, phase: r.phase };
  }
  c.service.assertIdle();
  c.service.stop();
  c.service.assertEmpty();
  restorePrevious(c, r);
  r.phase = "rolled-back";
  save(c, r);
  if (r.wasActive) {
    c.service.start();
    c.service.health();
  }
  releaseActivity(c, token);
  releaseHold(c, id);
  return { id, phase: "rolled-back" };
}

function productionContext(repository) {
  requireSafe(
    process.platform === "linux" && process.getuid() === 0,
    "Linux root context is required.",
  );
  const cleanEnv = {
    PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
  function run(file, args, options = {}) {
    const { failureCode, timeoutCode, ...executionOptions } = options;
    try {
      return execFileSync(file, args, {
        env: cleanEnv,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        ...executionOptions,
      }).trim();
    } catch (error) {
      throw commandFailure(error, failureCode, timeoutCode);
    }
  }
  const c = {
    repository,
    install: "/opt/pluton-agent",
    state: "/var/lib/pluton-agent",
    config: "/etc/pluton-agent.env",
    unit: "/etc/systemd/system/pluton-agent.service",
    policy: "/etc/pluton-agent",
    backups: "/var/lib/pluton-agent-upgrades",
    node: "/opt/pluton-agent/runtime/bin/node",
    owner: 0,
    enforceModes: true,
    sync: syncDirectory,
    checkpoint: () => {},
    processAlive: (pid) => {
      if (!Number.isInteger(pid) || pid <= 1) return true;
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return e.code !== "ESRCH";
      }
    },
  };
  c.app = path.join(c.install, "app");
  c.hold = path.join(c.install, HOLD);
  c.provenance = path.join(c.install, ".verified-install");
  const git = (args) =>
    run("/usr/bin/git", [
      "-c",
      `safe.directory=${repository}`,
      "-c",
      "core.fsmonitor=false",
      "-C",
      repository,
      ...args,
    ]);
  c.commit = git(["rev-parse", "--verify", "HEAD^{commit}"]);
  requireSafe(
    /^[a-f0-9]{40}$/.test(c.commit),
    "A committed source checkout is required.",
  );
  const show = () =>
    Object.fromEntries(
      run("/usr/bin/systemctl", [
        "show",
        "pluton-agent.service",
        "--no-pager",
        "--property=LoadState,ActiveState,SubState,MainPID,User,Group,FragmentPath,DropInPaths,ExecStart,EnvironmentFiles,ControlGroup,Type,KillMode,Environment,ExecStartPre,ExecStartPost,ExecStop,ExecStopPost,RootDirectory,RootImage,NoNewPrivileges,CapabilityBoundingSet",
      ])
        .split("\n")
        .map((line) => {
          const i = line.indexOf("=");
          return [line.slice(0, i), line.slice(i + 1)];
        }),
    );
  let env;
  function processes() {
    const s = show();
    if (!s.ControlGroup) {
      requireSafe(
        s.ActiveState === "inactive" && s.MainPID === "0",
        "Unknown service cgroup.",
      );
      return [];
    }
    requireSafe(
      /^\/system\.slice\/pluton-agent\.service$/.test(s.ControlGroup),
      "Custom cgroup requires operator review.",
    );
    const directory = "/sys/fs/cgroup" + s.ControlGroup;
    const pids = [];
    function walk(dir) {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (item.name === "cgroup.procs")
          pids.push(
            ...fs
              .readFileSync(path.join(dir, item.name), "utf8")
              .trim()
              .split(/\s+/)
              .filter(Boolean),
          );
        else if (item.isDirectory()) walk(path.join(dir, item.name));
      }
    }
    if (exists(directory)) walk(directory);
    else
      requireSafe(
        s.ActiveState === "inactive",
        "Service cgroup is unavailable.",
      );
    return [...new Set(pids)];
  }
  c.service = {
    active: () => show().ActiveState === "active",
    assertIdle: () => {
      const s = show(),
        pids = processes();
      requireSafe(
        s.ActiveState === "active"
          ? pids.length === 1 && pids[0] === s.MainPID
          : s.ActiveState === "inactive" &&
              pids.length === 0 &&
              s.MainPID === "0",
        "Agent has active/unknown child operations; nothing was stopped.",
      );
    },
    assertEmpty: () =>
      requireSafe(
        processes().length === 0 && show().MainPID === "0",
        "Agent cgroup did not drain.",
      ),
    stop: () => {
      if (show().ActiveState !== "inactive")
        run("/usr/bin/systemctl", ["stop", "pluton-agent.service"]);
    },
    start: () =>
      run("/usr/bin/systemctl", ["start", "pluton-agent.service"], {
        failureCode: "AGENT_START_FAILED",
        timeoutCode: "AGENT_START_TIMEOUT",
      }),
    health: () => {
      const first = show();
      requireSafe(
        first.ActiveState === "active" && Number(first.MainPID) > 1,
        "Agent did not start.",
        "AGENT_NOT_RUNNING",
      );
      run(
        "/usr/sbin/runuser",
        [
          "-u",
          "pluton-agent",
          "--",
          c.node,
          path.join(c.app, "dist/index.js"),
          "check",
        ],
        {
          env: { ...cleanEnv, ...env },
          failureCode: "AGENT_HEARTBEAT_FAILED",
          timeoutCode: "AGENT_HEALTH_TIMEOUT",
        },
      );
      run("/usr/bin/sleep", ["3"]);
      const last = show();
      requireSafe(
        last.ActiveState === "active" &&
          last.MainPID === first.MainPID &&
          last.SubState === "running",
        "Agent did not remain healthy.",
        "AGENT_NOT_STABLE",
      );
    },
  };
  c.preflight = () => {
    requireSafe(
      !git(["status", "--porcelain", "--untracked-files=normal"]),
      "Checkout is dirty. Use a reviewed committed checkout, not local edits.",
    );
    requireSafe(
      git(["rev-parse", "HEAD"]) === c.commit,
      "Source commit changed during upgrade.",
    );
    for (const file of [c.config, c.unit, c.node, c.provenance])
      protectedPath(file);
    protectedPath(c.install, true);
    for (const directory of [c.backups, c.policy])
      if (exists(directory)) protectedPath(directory, true);
    requireSafe(
      !exists(c.backups) || (fs.statSync(c.backups).mode & 0o777) === 0o700,
      "Existing upgrade backup directory must be root-private (0700).",
    );
    const s = show();
    validateService(s, c);
    env = parseEnvironment(fs.readFileSync(c.config, "utf8"));
    requireSafe(
      (env.PLUTON_AGENT_DATA_DIR || c.state) === c.state &&
        (env.PLUTON_AGENT_BIN_DIR || `${c.install}/bin`) ===
          `${c.install}/bin` &&
        (!env.PLUTON_AGENT_SOURCE_POLICY_FILE ||
          env.PLUTON_AGENT_SOURCE_POLICY_FILE ===
            `${c.policy}/source-access.json`),
      "Custom state/tool/policy paths require a separately reviewed upgrade.",
    );
    c.agentUid = Number(run("/usr/bin/id", ["-u", "pluton-agent"]));
    c.agentGid = Number(run("/usr/bin/id", ["-g", "pluton-agent"]));
    requireSafe(
      c.agentUid > 0 && Number.isInteger(c.agentGid),
      "Existing unprivileged Agent account is required.",
    );
    const groups = run("/usr/bin/id", ["-nG", "pluton-agent"]).split(/\s+/);
    requireSafe(
      !groups.some((group) =>
        ["docker", "root", "sudo", "wheel"].includes(group),
      ),
      "Agent account has a privileged group; no account changes were made.",
    );
    const stateStat = fs.lstatSync(c.state),
      identityStat = fs.lstatSync(path.join(c.state, "identity.json"));
    requireSafe(
      fs.realpathSync(c.state) === c.state &&
        stateStat.isDirectory() &&
        !stateStat.isSymbolicLink() &&
        stateStat.uid === c.agentUid &&
        !(stateStat.mode & 0o077) &&
        identityStat.isFile() &&
        !identityStat.isSymbolicLink() &&
        identityStat.uid === c.agentUid &&
        !(identityStat.mode & 0o077),
      "Existing private identity/state protection is invalid.",
    );
    identityBinding(c.state);
    treeDigest(c.app);
    run("/usr/sbin/runuser", ["-u", "pluton-agent", "--", c.node, "-v"]);
    run("/usr/sbin/runuser", [
      "-u",
      "pluton-agent",
      "--",
      c.node,
      path.join(c.app, "dist/index.js"),
      "--help",
    ]);
    for (const executable of ["restic", "rclone"])
      run("/usr/sbin/runuser", [
        "-u",
        "pluton-agent",
        "--",
        `${c.install}/bin/${executable}`,
        "version",
      ]);
    for (const key of [
      "PLUTON_AGENT_CA_FILE",
      "PLUTON_AGENT_CLIENT_CERT_FILE",
      "PLUTON_AGENT_CLIENT_KEY_FILE",
    ]) {
      if (env[key])
        run("/usr/sbin/runuser", [
          "-u",
          "pluton-agent",
          "--",
          "/usr/bin/test",
          "-r",
          env[key],
        ]);
    }
    assertLocallyDrained(c);
    c.service.assertIdle();
    if (s.ActiveState === "active") {
      const pid = Number(s.MainPID);
      requireSafe(
        Number.isInteger(pid) &&
          pid > 1 &&
          fs.realpathSync(`/proc/${pid}/exe`) === c.node &&
          JSON.stringify(
            fs
              .readFileSync(`/proc/${pid}/cmdline`, "utf8")
              .split("\0")
              .filter(Boolean),
          ) === JSON.stringify([c.node, `${c.app}/dist/index.js`, "run"]),
        "Running service executable/arguments differ from the installed Agent.",
      );
      let info;
      try {
        info = run(c.node, [
          path.join(c.app, "dist/index.js"),
          "--upgrade-info",
        ]);
      } catch {
        throw new Error(
          "Running Agent lacks upgrade protocol v1; pause plans, drain and safely stop it before the first upgrade.",
        );
      }
      requireSafe(
        info ===
          JSON.stringify({
            version: 1,
            activityFile: ACTIVITY,
            holdDirectory: HOLD,
          }),
        "Running Agent lacks upgrade protocol v1; safely drain and stop it first.",
      );
    } else c.service.assertEmpty();
    const size = Number(run("/usr/bin/du", ["-sk", c.app]).split(/\s+/)[0]);
    for (const base of [
      c.install,
      exists(c.backups) ? c.backups : "/var/lib",
    ]) {
      const available = Number(
        run("/usr/bin/df", ["-Pk", base])
          .split("\n")
          .at(-1)
          .trim()
          .split(/\s+/)[3],
      );
      validateDisk(available, size);
    }
  };
  c.build = (id, next) => {
    const work = path.join(c.backups, id, "build");
    fs.mkdirSync(work, { mode: 0o700 });
    const archive = path.join(work, "source.tar"),
      snapshot = path.join(work, "source"),
      stage = path.join(work, "stage");
    git(["archive", "--format=tar", `--output=${archive}`, c.commit]);
    fs.mkdirSync(snapshot);
    fs.mkdirSync(stage);
    fs.mkdirSync(path.join(work, "tmp"));
    run("/usr/bin/tar", ["-xf", archive, "-C", snapshot]);
    fs.symlinkSync(
      path.join(c.install, "runtime"),
      path.join(stage, "runtime"),
    );
    const pkg = JSON.parse(
      fs.readFileSync(path.join(snapshot, "package.json"), "utf8"),
    );
    requireSafe(
      /^pnpm@\d+\.\d+\.\d+$/.test(pkg.packageManager),
      "Exact pinned pnpm is required.",
    );
    const buildScript =
      'source "$1/installers/install-agent.sh"; REPOSITORY_ROOT="$1"; STAGE_ROOT="$2"; export PATH="$2/runtime/bin:$PATH"; build_agent_app_from_source; source_fingerprint > "$3/source.sha256"';
    run(
      "/usr/bin/bash",
      [
        "-Eeuo",
        "pipefail",
        "-c",
        buildScript,
        "agent-upgrade-build",
        snapshot,
        stage,
        work,
      ],
      {
        env: { ...cleanEnv, TMPDIR: path.join(work, "tmp") },
        timeout: 15 * 60_000,
      },
    );
    requireSafe(!exists(next), "Staging path already exists.");
    // /var/lib and /opt may be different filesystems. Copy and fsync the new app
    // first; only final activation uses same-filesystem atomic renames.
    copyApp(path.join(stage, "app"), next, c);
    c.sync(c.install);
  };
  c.verifyCandidate = (app) => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(app, "package.json"), "utf8"),
    );
    requireSafe(
      pkg.name === "@plutonhq/pluton-agent" &&
        !Object.keys(pkg.dependencies || {}).length,
      "Unexpected Agent artifact/runtime dependency.",
    );
    requireSafe(
      run("/usr/sbin/runuser", [
        "-u",
        "pluton-agent",
        "--",
        c.node,
        path.join(app, "dist/index.js"),
        "--upgrade-info",
      ]) ===
        JSON.stringify({
          version: 1,
          activityFile: ACTIVITY,
          holdDirectory: HOLD,
        }),
      "Candidate lacks service-account access or the supported upgrade hold protocol.",
    );
  };
  c.writeProvenance = (id) => {
    const snapshot = path.join(c.backups, id, "build/source");
    const digest = run("/usr/bin/bash", [
      "-Eeuo",
      "pipefail",
      "-c",
      'source "$1/installers/install-agent.sh"; verified_tree_digest "$2"',
      "agent-integrity",
      snapshot,
      c.install,
    ]);
    const sourceHash = fs
      .readFileSync(path.join(c.backups, id, "build/source.sha256"), "utf8")
      .trim();
    requireSafe(
      /^[a-f0-9]{64}$/.test(digest) && /^[a-f0-9]{64}$/.test(sourceHash),
      "Artifact/source integrity could not be established.",
    );
    const metadata = fs.readFileSync(
      path.join(c.backups, id, "verified-install"),
      "utf8",
    );
    requireSafe(
      /^source=.+$/m.test(metadata) && /^tree=[a-f0-9]{64}$/m.test(metadata),
      "Malformed prior install provenance.",
    );
    durableWrite(
      c.provenance,
      metadata
        .replace(/^source=.+$/m, `source=${sourceHash}`)
        .replace(/^tree=.+$/m, `tree=${digest}`),
      c.sync,
      0o644,
    );
  };
  c.verifyReceipt = (file) => protectedPath(file);
  return c;
}

if (require.main === module) {
  try {
    const [repository, option, id] = process.argv.slice(2);
    atStage("CONTEXT", () =>
      requireSafe(
        process.argv.length >= 3 &&
          process.argv.length <= 5 &&
          ((!option && !id) ||
            (option === "--check" && !id) ||
            (option === "--rollback" && ID.test(id || ""))),
        "Unsupported upgrade invocation.",
      ),
    );
    const c = atStage("CONTEXT", () => productionContext(repository));
    if (option === "--check") {
      atStage("PREFLIGHT", () => {
        c.preflight();
        requireSafe(
          !exists(c.hold) && !exists(path.join(c.state, ACTIVITY)),
          "Operation/upgrade hold remains; preflight is not ready.",
        );
      });
      console.log(
        `Read-only local preflight PASS. Source commit: ${c.commit}. Server plans/queued requests require operator review. No heartbeat/build/restart performed.`,
      );
    } else {
      const result =
        option === "--rollback"
          ? atStage("MANUAL_ROLLBACK", () => rollback(c, id))
          : upgrade(c);
      console.log(
        `Agent app transaction ${result.phase}. Upgrade ID: ${result.id}. Source commit: ${c.commit}. Rollback artifacts retained privately.`,
      );
    }
  } catch (error) {
    // Deliberately omit subprocess output/configuration/credentials.
    console.error(formatFailure(error));
    process.exitCode = 1;
  }
}
module.exports = {
  upgrade,
  rollback,
  parseEnvironment,
  treeDigest,
  preservedDigest,
  identityBinding,
  assertLocallyDrained,
  acquireActivity,
  releaseActivity,
  durableWrite,
  syncDirectory,
  syncFile,
  syncTree,
  productionContext,
  validateService,
  validateDisk,
};

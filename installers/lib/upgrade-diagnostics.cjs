/* Closed diagnostics only. Never parse or print child output, messages, paths,
 * environment values, identity data, command arguments or exception stacks. */
"use strict";

const STAGES = new Set([
  "UNKNOWN",
  "CONTEXT",
  "PREFLIGHT",
  "LOCK_SETUP",
  "ACTIVITY_FENCE",
  "DRAIN_CHECK",
  "BUILD",
  "CANDIDATE_VERIFY",
  "POST_BUILD_PREFLIGHT",
  "PRESERVATION_CHECK",
  "SERVICE_STOP",
  "BACKUP",
  "PREPARED_CHECKPOINT",
  "ACTIVATE_PREVIOUS",
  "ACTIVATE_CANDIDATE",
  "PROVENANCE",
  "ACTIVATED_CHECKPOINT",
  "SERVICE_START",
  "HEALTH_CHECK",
  "POST_HEALTH_PRESERVATION_CHECK",
  "POST_HEALTH_ARTIFACT_CHECK",
  "RECEIPT_WRITE",
  "FENCE_RELEASE",
  "HOLD_RELEASE",
  "ROLLBACK_PRESERVATION_CHECK",
  "ROLLBACK_DRAIN",
  "ROLLBACK_RESTORE",
  "ROLLBACK_RECEIPT_WRITE",
  "ROLLBACK_SERVICE_START",
  "ROLLBACK_HEALTH_CHECK",
  "ROLLBACK_FENCE_RELEASE",
  "ROLLBACK_HOLD_RELEASE",
  "MANUAL_ROLLBACK",
]);
const FALLBACK = {
  PREFLIGHT: "PREFLIGHT_CHECK_FAILED",
  LOCK_SETUP: "UPGRADE_LOCK_SETUP_FAILED",
  ACTIVITY_FENCE: "ACTIVITY_FENCE_FAILED",
  DRAIN_CHECK: "AGENT_DRAIN_CHECK_FAILED",
  BUILD: "BUILD_FAILED",
  CANDIDATE_VERIFY: "CANDIDATE_VERIFICATION_FAILED",
  POST_BUILD_PREFLIGHT: "PREFLIGHT_CHECK_FAILED",
  PRESERVATION_CHECK: "PRESERVATION_CHECK_FAILED",
  SERVICE_STOP: "AGENT_STOP_FAILED",
  BACKUP: "BACKUP_FAILED",
  ACTIVATE_PREVIOUS: "ACTIVATION_FAILED",
  ACTIVATE_CANDIDATE: "ACTIVATION_FAILED",
  PROVENANCE: "PROVENANCE_FAILED",
  SERVICE_START: "AGENT_START_FAILED",
  HEALTH_CHECK: "AGENT_HEALTH_CHECK_FAILED",
  POST_HEALTH_PRESERVATION_CHECK: "PRESERVATION_CHECK_FAILED",
  POST_HEALTH_ARTIFACT_CHECK: "ARTIFACT_INTEGRITY_MISMATCH",
  RECEIPT_WRITE: "RECEIPT_WRITE_FAILED",
  FENCE_RELEASE: "ACTIVITY_FENCE_FAILED",
  HOLD_RELEASE: "UPGRADE_HOLD_RELEASE_FAILED",
};
const CODES = new Set([
  ...Object.values(FALLBACK),
  "UPGRADE_CHECK_FAILED",
  "UPGRADE_UNEXPECTED_FAILURE",
  "BUILD_TIMEOUT",
  "AGENT_START_TIMEOUT",
  "AGENT_HEALTH_TIMEOUT",
  "LOCAL_COMMAND_TIMEOUT",
  "LOCAL_COMMAND_FAILED",
  "LOCAL_COMMAND_UNAVAILABLE",
  "LOCAL_COMMAND_PERMISSION_DENIED",
  "COMMAND_OUTPUT_LIMIT",
  "FILESYSTEM_PERMISSION_DENIED",
  "FILESYSTEM_NO_SPACE",
  "FILESYSTEM_ENTRY_MISSING",
  "FILESYSTEM_IO_FAILED",
  "FILESYSTEM_ENTRY_EXISTS",
  "STATE_PRESERVATION_MISMATCH",
  "AGENT_NOT_RUNNING",
  "AGENT_NOT_STABLE",
  "AGENT_HEARTBEAT_FAILED",
  "ROLLBACK_FAILED",
]);
const OUTCOMES = new Set([
  "NOT_ATTEMPTED",
  "NOT_NEEDED",
  "INCOMPLETE",
  "SUCCESS",
  "FAILED",
]);
const PREVIOUS = new Set(["YES", "UNKNOWN"]);

// Only our literal guards may retain their existing human-readable message for
// internal callers/tests. Console/receipt formatters never use that message.
class GuardFailure extends Error {
  constructor(message, code) {
    super(message);
    this.safeCode = CODES.has(code) ? code : undefined;
  }
}
class CommandFailure extends Error {
  constructor(kind, code) {
    super("Local command failed; output withheld.");
    this.kind = kind;
    this.safeCode = CODES.has(code) ? code : undefined;
  }
}
class DiagnosticFailure extends Error {
  constructor(
    stage,
    code,
    message = "Upgrade check failed; see structured diagnostics.",
  ) {
    super(message);
    this.stage = STAGES.has(stage) ? stage : "UNKNOWN";
    this.code = CODES.has(code) ? code : "UPGRADE_UNEXPECTED_FAILURE";
    this.rollback = "NOT_ATTEMPTED";
    this.previousAgentPreserved = "UNKNOWN";
  }
}
function commandFailure(error, code, timeoutCode) {
  // Node's exec deadline is distinct from a child exiting nonzero. A child
  // reporting a network failure is not classified as a timeout from its text.
  if (error?.code === "ETIMEDOUT")
    return new CommandFailure("timeout", timeoutCode);
  if (error?.code === "ENOENT")
    return new CommandFailure("unavailable", "LOCAL_COMMAND_UNAVAILABLE");
  if (["EACCES", "EPERM"].includes(error?.code))
    return new CommandFailure("permission", "LOCAL_COMMAND_PERMISSION_DENIED");
  if (error?.code === "ENOBUFS")
    return new CommandFailure("output-limit", "COMMAND_OUTPUT_LIMIT");
  return new CommandFailure("exit", code);
}
function failureOf(error, stage = "UNKNOWN") {
  if (error instanceof DiagnosticFailure) return error;
  const fallback =
    FALLBACK[stage] ||
    (stage.startsWith("ROLLBACK_")
      ? "ROLLBACK_FAILED"
      : "UPGRADE_CHECK_FAILED");
  let code = fallback;
  if (error instanceof GuardFailure && error.safeCode) code = error.safeCode;
  else if (error instanceof CommandFailure) {
    code =
      error.safeCode ||
      (error.kind === "timeout"
        ? stage === "BUILD"
          ? "BUILD_TIMEOUT"
          : stage.endsWith("HEALTH_CHECK")
            ? "AGENT_HEALTH_TIMEOUT"
            : stage.endsWith("SERVICE_START")
              ? "AGENT_START_TIMEOUT"
              : "LOCAL_COMMAND_TIMEOUT"
        : fallback);
  } else {
    code =
      {
        EACCES: "FILESYSTEM_PERMISSION_DENIED",
        EPERM: "FILESYSTEM_PERMISSION_DENIED",
        ENOSPC: "FILESYSTEM_NO_SPACE",
        ENOENT: "FILESYSTEM_ENTRY_MISSING",
        EIO: "FILESYSTEM_IO_FAILED",
        EEXIST: "FILESYSTEM_ENTRY_EXISTS",
      }[error?.code] || code;
  }
  return new DiagnosticFailure(
    stage,
    code,
    error instanceof GuardFailure ? error.message : undefined,
  );
}
function atStage(stage, operation) {
  try {
    return operation();
  } catch (error) {
    throw failureOf(error, stage);
  }
}
function outcome(error, rollback, preserved, message, rollbackError) {
  const original = failureOf(error);
  const result = new DiagnosticFailure(original.stage, original.code, message);
  result.rollback = OUTCOMES.has(rollback) ? rollback : "NOT_ATTEMPTED";
  result.previousAgentPreserved = PREVIOUS.has(preserved)
    ? preserved
    : "UNKNOWN";
  if (rollbackError) result.rollbackFailure = failureOf(rollbackError);
  return result;
}
function safeRecord(error) {
  const d = failureOf(error);
  const record = {
    version: 1,
    failedStage: STAGES.has(d.stage) ? d.stage : "UNKNOWN",
    errorCode: CODES.has(d.code) ? d.code : "UPGRADE_UNEXPECTED_FAILURE",
    rollback: OUTCOMES.has(d.rollback) ? d.rollback : "NOT_ATTEMPTED",
    previousAgentPreserved: PREVIOUS.has(d.previousAgentPreserved)
      ? d.previousAgentPreserved
      : "UNKNOWN",
  };
  if (d.rollbackFailure instanceof DiagnosticFailure)
    record.rollbackFailure = {
      failedStage: STAGES.has(d.rollbackFailure.stage)
        ? d.rollbackFailure.stage
        : "UNKNOWN",
      errorCode: CODES.has(d.rollbackFailure.code)
        ? d.rollbackFailure.code
        : "ROLLBACK_FAILED",
    };
  return record;
}
function formatFailure(error) {
  const d = safeRecord(error);
  const lines = [
    "[pluton-agent-upgrade] Upgrade failed.",
    `Failed stage: ${d.failedStage}`,
    `Error code: ${d.errorCode}`,
    `Rollback: ${d.rollback}`,
    `Previous Agent preserved: ${d.previousAgentPreserved}`,
  ];
  if (d.rollbackFailure)
    lines.push(
      `Rollback failed stage: ${d.rollbackFailure.failedStage}`,
      `Rollback error code: ${d.rollbackFailure.errorCode}`,
    );
  if (
    error instanceof DiagnosticFailure &&
    error.diagnosticReceiptUnavailable === true
  )
    lines.push("Diagnostic receipt: UNCONFIRMED");
  if (
    error instanceof DiagnosticFailure &&
    typeof error.upgradeId === "string" &&
    /^[0-9]{14}-[a-f0-9]{12}-[a-f0-9]{12}$/.test(error.upgradeId)
  )
    lines.push(`Upgrade ID: ${error.upgradeId}`);
  return lines.join("\n");
}
module.exports = {
  GuardFailure,
  commandFailure,
  failureOf,
  atStage,
  outcome,
  safeRecord,
  formatFailure,
};

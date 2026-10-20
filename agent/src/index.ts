#!/usr/bin/env node
import {
  configFromEnvironment,
  createAgentConfig,
  parseBoolean,
} from "./config.js";
import { AgentClient } from "./client.js";
import { readEnrollmentToken } from "./enrollmentToken.js";
import { atAgentStage, formatAgentFailure } from "./errors.js";
import { saveIdentity } from "./identity.js";
import { collectInventory } from "./inventory.js";
import {
  preflightSource,
  resolveAllowedRoots,
  safeSourceDiagnosticPath,
  SourceAccessError,
} from "./filesystemPolicy.js";
import { checkConnection, run, runOnce } from "./runtime.js";
import { UPGRADE_PROTOCOL } from "./upgradeGuard.js";
import { lstat } from "node:fs/promises";
import { loadIdentity } from "./identity.js";
import {
  SourceAccessPolicy,
  readSourceAccessEnvironment,
} from "./sourceAccessPolicy.js";

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function configFromArgs(args: string[]) {
  const envConfig = process.env;
  const allowInsecureHttp =
    args.includes("--allow-insecure-http") ||
    parseBoolean(envConfig.PLUTON_AGENT_ALLOW_INSECURE_HTTP) ||
    parseBoolean(envConfig.ALLOW_INSECURE_HTTP);
  return createAgentConfig({
    serverUrl: readOption(args, "--server") || envConfig.PLUTON_SERVER_URL,
    dataDir: readOption(args, "--data-dir") || envConfig.PLUTON_AGENT_DATA_DIR,
    allowedRoots:
      readOption(args, "--allowed-roots") ||
      envConfig.PLUTON_AGENT_ALLOWED_ROOTS,
    binDir: readOption(args, "--bin-dir") || envConfig.PLUTON_AGENT_BIN_DIR,
    allowInsecureHttp,
    caFile: readOption(args, "--ca-file") || envConfig.PLUTON_AGENT_CA_FILE,
    clientCertFile: envConfig.PLUTON_AGENT_CLIENT_CERT_FILE,
    clientKeyFile: envConfig.PLUTON_AGENT_CLIENT_KEY_FILE,
    hookRoot: envConfig.PLUTON_AGENT_HOOK_ROOT,
    databaseBinDirs: envConfig.PLUTON_AGENT_DATABASE_BIN_DIRS,
    sourcePolicyFile: envConfig.PLUTON_AGENT_SOURCE_POLICY_FILE,
  });
}

function usage(): void {
  console.log(
    "Usage: pluton-agent enroll --server <url> (--token-stdin | --token <token>) [--data-dir <dir>]",
  );
  console.log(
    "       pluton-agent run [--once] [--server <url>] [--data-dir <dir>]",
  );
  console.log(
    "       pluton-agent check [--server <url>] [--data-dir <dir>] (heartbeat only; no command execution)",
  );
  console.log(
    "       pluton-agent preflight --source <absolute-path> --allowed-roots <comma-separated-paths> [--scan] (local, read-only; run as pluton-agent)",
  );
  console.log(
    "       pluton-agent source-access <approve|revoke|recover-selection|delegate|host-approved> --config-file /etc/pluton-agent.env --agent-id <id> --expected-host-policy-revision <sha256> [--root <canonical-directory> ... | --request-id <id>] [--confirm-drained] [--confirm-delegation] (explicit local host operator only)",
  );
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--upgrade-info" && !args.length) {
    console.log(JSON.stringify(UPGRADE_PROTOCOL));
    return;
  }
  if (!command || command === "--help" || command === "-h") {
    usage();
    return;
  }
  if (command === "source-access") {
    const [action, ...options] = args;
    if (
      ![
        "approve",
        "revoke",
        "recover-selection",
        "delegate",
        "host-approved",
      ].includes(action)
    )
      throw new Error("A narrow source-access operation is required.");
    const allowed = new Set([
      "--config-file",
      "--agent-id",
      "--expected-host-policy-revision",
      "--root",
      "--request-id",
      "--confirm-drained",
      "--confirm-delegation",
    ]);
    const booleanOptions = new Set([
      "--confirm-drained",
      "--confirm-delegation",
    ]);
    for (let index = 0; index < options.length; index++) {
      if (booleanOptions.has(options[index])) continue;
      if (
        !allowed.has(options[index]) ||
        !options[index + 1] ||
        options[index + 1].startsWith("--")
      )
        throw new Error("Invalid source-access options.");
      index++;
    }
    for (const name of [...allowed].filter((name) => name !== "--root"))
      if (options.filter((value) => value === name).length > 1)
        throw new Error("Repeated source-access option.");
    const configFile =
      readOption(options, "--config-file") || "/etc/pluton-agent.env";
    const localConfig = await readSourceAccessEnvironment(configFile);
    const identity = await loadIdentity(localConfig.dataDir);
    const agentId = readOption(options, "--agent-id") || "";
    const expectedRevision =
      readOption(options, "--expected-host-policy-revision") || "";
    if (
      agentId !== identity.agentId ||
      !/^[a-f0-9]{64}$/.test(expectedRevision)
    )
      throw new Error(
        "Agent identity and current source policy revision must match.",
      );
    const policy = new SourceAccessPolicy({
      // This operation is local only; it never connects to this placeholder origin.
      config: {
        ...localConfig,
        serverUrl: new URL("https://example.invalid"),
        allowInsecureHttp: false,
      },
      agentId,
      uid: (await lstat(localConfig.dataDir)).uid,
    });
    if (action === "delegate" || action === "host-approved") {
      const roots = options.flatMap((value, index) =>
        value === "--root" ? [options[index + 1]] : [],
      );
      const result = await policy.changeAuthorizationMode({
        agentId,
        expectedRevision,
        requestId: readOption(options, "--request-id") || "",
        authorizationMode:
          action === "delegate" ? "server-managed" : "host-approved",
        roots,
        secret: identity.secret,
        confirmDrained: options.includes("--confirm-drained"),
        confirmDelegation: options.includes("--confirm-delegation"),
      });
      console.log(
        JSON.stringify({
          ...result,
          selectionChanged: false,
          advice:
            "Host authority changed. Refresh Pluton and explicitly apply enabled directories. Delegation trusts Pluton administrators only within these prefixes; Linux permissions and private-directory exclusions remain enforced.",
        }),
      );
    } else if (action === "recover-selection") {
      if (options.includes("--root"))
        throw new Error("Recovery cannot change roots.");
      await policy.recoverSelection({
        agentId,
        expectedRevision,
        requestId: readOption(options, "--request-id") || "",
      });
      console.log(
        "Existing explicit source selection durability verified; no new selection was authorized.",
      );
    } else {
      if (options.includes("--request-id"))
        throw new Error("Host approval does not apply a server request.");
      const roots = options.flatMap((value, index) =>
        value === "--root" ? [options[index + 1]] : [],
      );
      const result = await policy.changeHostApproval({
        action: action as "approve" | "revoke",
        agentId,
        expectedRevision,
        roots,
      });
      console.log(
        JSON.stringify({
          ...result,
          selectionChanged: false,
          advice:
            "Refresh Source Access in Pluton, then explicitly enable the approved canonical roots. No identity or permissions were changed.",
        }),
      );
    }
    return;
  }
  if (command === "preflight") {
    const source = readOption(args, "--source") || "";
    const roots = (
      readOption(args, "--allowed-roots") ||
      process.env.PLUTON_AGENT_ALLOWED_ROOTS ||
      ""
    )
      .split(",")
      .filter(Boolean);
    try {
      const result = await preflightSource(source, roots, {
        scan: args.includes("--scan"),
      });
      console.log(
        JSON.stringify({
          ...result,
          requestedPath: safeSourceDiagnosticPath(result.requestedPath),
          resolvedPath: safeSourceDiagnosticPath(result.resolvedPath),
        }),
      );
    } catch (error) {
      if (!(error instanceof SourceAccessError))
        throw new Error("Source preflight could not complete.");
      console.error(
        JSON.stringify({
          code: error.code,
          requestedPath: safeSourceDiagnosticPath(error.requestedPath),
          resolvedPath: safeSourceDiagnosticPath(error.resolvedPath),
          blockedPath: safeSourceDiagnosticPath(error.blockedPath),
          advice:
            "Review read-only access and canonical allowed roots. No permissions were changed.",
        }),
      );
      process.exitCode = 1;
    }
    return;
  }
  const config = await atAgentStage("load-configuration", () =>
    args.length > 0 ? configFromArgs(args) : configFromEnvironment(),
  );
  if (command === "enroll") {
    const token = await atAgentStage("read-enrollment-token", () =>
      readEnrollmentToken(args),
    );
    const roots = await atAgentStage("resolve-allowed-roots", () =>
      resolveAllowedRoots(config.allowedRoots),
    );
    const client = new AgentClient(config);
    const result = await atAgentStage("enroll", () =>
      client.enroll(
        token,
        collectInventory({
          filesystemRootsConfigured: roots.length > 0,
          binDir: config.binDir,
          hookRoot: config.hookRoot,
          databaseBinDirs: config.databaseBinDirs,
        }),
      ),
    );
    await atAgentStage("save-identity", () =>
      saveIdentity(config.dataDir, { ...result, completedCommands: [] }),
    );
    console.log(`Agent enrolled successfully: ${result.agentId}`);
    return;
  }
  if (command === "run") {
    if (args.includes("--once")) await runOnce(config);
    else await run(config);
    return;
  }
  if (command === "check") {
    await checkConnection(config);
    console.log(
      "Agent authenticated heartbeat succeeded; no command was polled or executed.",
    );
    return;
  }
  usage();
  throw new Error("Unknown command.");
}

main().catch((error) => {
  console.error(`[pluton-agent] ${formatAgentFailure(error)}`);
  process.exitCode = 1;
});

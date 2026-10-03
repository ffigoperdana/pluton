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
import { resolveAllowedRoots } from "./filesystemPolicy.js";
import { run, runOnce } from "./runtime.js";

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
  });
}

function usage(): void {
  console.log(
    "Usage: pluton-agent enroll --server <url> (--token-stdin | --token <token>) [--data-dir <dir>]",
  );
  console.log(
    "       pluton-agent run [--once] [--server <url>] [--data-dir <dir>]",
  );
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    usage();
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
  usage();
  throw new Error("Unknown command.");
}

main().catch((error) => {
  console.error(`[pluton-agent] ${formatAgentFailure(error)}`);
  process.exitCode = 1;
});

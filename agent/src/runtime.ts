import { AgentClient } from "./client.js";
import {
  BackupCancelledError,
  BackupFilesystemError,
  executeFilesystemBackup,
} from "./backupFilesystem.js";
import {
  AgentOperationError,
  atAgentStage,
  formatAgentFailure,
} from "./errors.js";
import { resolveAllowedRoots } from "./filesystemPolicy.js";
import { loadIdentity, saveIdentity } from "./identity.js";
import { collectInventory } from "./inventory.js";
import type { AgentConfig, StoredAgentIdentity } from "./types.js";

const SAFE_COMMANDS = new Set([
  "PING",
  "INVENTORY_REFRESH",
  "BACKUP_FILESYSTEM",
]);

function rememberCompletion(
  identity: StoredAgentIdentity,
  completion: StoredAgentIdentity["completedCommands"][number],
): void {
  identity.completedCommands = [
    ...identity.completedCommands.filter(
      (item) => item.commandId !== completion.commandId,
    ),
    completion,
  ].slice(-100);
}

export async function runOnce(
  config: AgentConfig,
  signal?: AbortSignal,
): Promise<void> {
  const identity = await atAgentStage("load-identity", () =>
    loadIdentity(config.dataDir),
  );
  const roots = await atAgentStage("resolve-allowed-roots", () =>
    resolveAllowedRoots(config.allowedRoots),
  );
  const client = new AgentClient(config, identity);
  const inventory = collectInventory({
    filesystemRootsConfigured: roots.length > 0,
    binDir: config.binDir,
    hookRoot: config.hookRoot,
    databaseBinDirs: config.databaseBinDirs,
  });

  await atAgentStage("heartbeat", () => client.heartbeat(inventory));
  const command = await atAgentStage("poll", () => client.poll());
  if (!command) return;
  if (!SAFE_COMMANDS.has(command.type)) {
    throw new AgentOperationError(
      "validate-command",
      "server returned an unsupported command type",
    );
  }

  const prior = identity.completedCommands.find(
    (item) => item.commandId === command.id,
  );
  if (prior) {
    await atAgentStage("complete", () =>
      client.complete(command.id, command.leaseToken, prior),
    );
    return;
  }

  await atAgentStage("acknowledge", () =>
    client.acknowledge(command.id, command.leaseToken),
  );
  let sequence = 0;
  const recordEvent = async (
    event?: Record<string, unknown>,
  ): Promise<void> => {
    sequence += 1;
    await client.event(command.id, command.leaseToken, sequence, event);
  };
  await atAgentStage("record-event", () => recordEvent({ phase: "accepted" }));

  let completion: StoredAgentIdentity["completedCommands"][number];
  try {
    if (command.type === "BACKUP_FILESYSTEM") {
      const result = await executeFilesystemBackup({
        payload: command.payload,
        config,
        allowedRoots: roots,
        shouldCancel: async () =>
          signal?.aborted ||
          (await client.commandStatus(command.id, command.leaseToken))
            .cancelled,
        onEvent: recordEvent,
        onStage: ({ stage, message }) =>
          console.info(
            `[pluton-agent] BACKUP_FILESYSTEM ${message} stage=${stage}`,
          ),
      });
      completion = {
        commandId: command.id,
        sequence: sequence + 1,
        success: true,
        result: result as unknown as Record<string, unknown>,
      };
    } else {
      // PING and INVENTORY_REFRESH remain deliberate no-ops.
      completion = {
        commandId: command.id,
        sequence: sequence + 1,
        success: true,
      };
    }
  } catch (error) {
    const backupFailure =
      error instanceof BackupFilesystemError ? error : undefined;
    const cancelled =
      error instanceof BackupCancelledError ||
      backupFailure?.code === "cancelled";
    if (command.type === "BACKUP_FILESYSTEM" && backupFailure) {
      console.error(
        `[pluton-agent] BACKUP_FILESYSTEM failed stage=${backupFailure.stage} code=${backupFailure.code} reason=${backupFailure.message}`,
      );
    }
    completion = {
      commandId: command.id,
      sequence: sequence + 1,
      success: false,
      cancelled,
      // Process output and storage details never leave the machine through command errors.
      error: cancelled
        ? "Backup was cancelled."
        : "Remote filesystem backup failed.",
      ...(backupFailure
        ? {
            failureStage: backupFailure.stage,
            failureCode: backupFailure.code,
          }
        : {}),
    };
  }
  // Persist before acknowledging completion so a retry cannot execute a backup twice.
  rememberCompletion(identity, completion);
  await atAgentStage("save-identity", () =>
    saveIdentity(config.dataDir, identity),
  );
  await atAgentStage("complete", () =>
    client.complete(command.id, command.leaseToken, completion),
  );
}

export async function run(config: AgentConfig): Promise<void> {
  const identity = await atAgentStage("load-identity", () =>
    loadIdentity(config.dataDir),
  );
  let stopped = false;
  let running = false;
  const shutdown = new AbortController();
  const execute = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await runOnce(config, shutdown.signal);
    } catch (error) {
      console.error(`[pluton-agent] ${formatAgentFailure(error)}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(
    execute,
    Math.max(5, identity.pollIntervalSeconds) * 1_000,
  );
  const stop = () => {
    stopped = true;
    shutdown.abort();
    clearInterval(timer);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await execute();
  await new Promise<void>((resolve) => {
    const wait = () => (stopped ? resolve() : setTimeout(wait, 250));
    wait();
  });
}

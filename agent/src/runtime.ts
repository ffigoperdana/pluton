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
import { ProgressDelivery, backupProgressStage } from "./progressDelivery.js";
import { successfulSnapshotIds } from "./resticParent.js";
import { SourceAccessPolicy, SourcePolicyError } from "./sourceAccessPolicy.js";
import { upgradeHeld } from "./upgradeGuard.js";

/** Installer validation must not lease or execute queued work. Identity is only read. */
export async function checkConnection(config: AgentConfig): Promise<void> {
  const identity = await atAgentStage("load-identity", () =>
    loadIdentity(config.dataDir),
  );
  const sourceAccess =
    process.platform === "linux"
      ? await new SourceAccessPolicy({
          config,
          agentId: identity.agentId,
        }).report()
      : undefined;
  const roots =
    sourceAccess?.effectiveRoots ||
    (await atAgentStage("resolve-allowed-roots", () =>
      resolveAllowedRoots(config.allowedRoots),
    ));
  await atAgentStage("heartbeat", () =>
    new AgentClient(config, identity).heartbeat(
      collectInventory({
        filesystemRootsConfigured: roots.length > 0,
        binDir: config.binDir,
        hookRoot: config.hookRoot,
        databaseBinDirs: config.databaseBinDirs,
        sourceAccess,
      }),
    ),
  );
}

const SAFE_COMMANDS = new Set([
  "PING",
  "INVENTORY_REFRESH",
  "BACKUP_FILESYSTEM",
  "SOURCE_ACCESS_VALIDATE",
  "SOURCE_ACCESS_APPLY",
  "SOURCE_ACCESS_MODE_SETUP",
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
  if (process.platform !== "linux") return runOnceWork(config, signal);
  if (await upgradeHeld(config)) return;
  const identity = await loadIdentity(config.dataDir);
  return new SourceAccessPolicy({
    config,
    agentId: identity.agentId,
  }).withActivity(() => runOnceWork(config, signal));
}

async function runOnceWork(
  config: AgentConfig,
  signal?: AbortSignal,
): Promise<void> {
  const identity = await atAgentStage("load-identity", () =>
    loadIdentity(config.dataDir),
  );
  // Availability of a source is validated within the backup, so losing source
  // access does not silence heartbeat or prevent a safe actionable job failure.
  // Configuration roots are re-resolved/contained by preflightSource, never trusted as canonical here.
  const sourcePolicy =
    process.platform === "linux"
      ? new SourceAccessPolicy({ config, agentId: identity.agentId })
      : undefined;
  const sourceAccess = await sourcePolicy?.report();
  const roots = sourceAccess?.effectiveRoots || config.allowedRoots;
  const client = new AgentClient(config, identity);
  const inventory = collectInventory({
    filesystemRootsConfigured: roots.length > 0,
    binDir: config.binDir,
    hookRoot: config.hookRoot,
    databaseBinDirs: config.databaseBinDirs,
    sourceAccess,
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
  const progress = new ProgressDelivery(recordEvent, () =>
    console.warn(
      "[pluton-agent] progress delivery temporarily unavailable; backup execution continues.",
    ),
  );

  let completion: StoredAgentIdentity["completedCommands"][number];
  try {
    if (command.type === "BACKUP_FILESYSTEM") {
      // Re-read policy at execution, after leasing. A heartbeat cannot authorize
      // a source, and a pending/uncertain durable write cannot run a backup.
      const currentPolicy = await sourcePolicy?.report();
      if (currentPolicy?.policyError)
        throw new BackupFilesystemError(
          "source-validation",
          "source-policy-violation",
        );
      const result = await executeFilesystemBackup({
        payload: command.payload,
        config,
        allowedRoots: currentPolicy?.effectiveRoots || roots,
        serverManagedSource:
          currentPolicy?.authorizationMode === "server-managed",
        successfulSnapshotIds: successfulSnapshotIds(
          identity.completedCommands,
        ),
        shouldCancel: async () =>
          signal?.aborted ||
          (await client.commandStatus(command.id, command.leaseToken))
            .cancelled,
        onEvent: async (event) => progress.enqueue(event),
        onStage: ({ stage, message, database, diagnostic }) => {
          progress.enqueue({
            phase: "running",
            backupStage: backupProgressStage(stage),
            ...database,
          });
          console.info(
            `[pluton-agent] BACKUP_FILESYSTEM ${message} stage=${stage}` +
              (diagnostic ? ` reason=${diagnostic}` : "") +
              (database
                ? ` databaseId=${database.databaseId || "legacy"} engine=${database.engine} ordinal=${database.ordinal}/${database.count}`
                : ""),
          );
        },
      });
      completion = {
        commandId: command.id,
        sequence: sequence + 1,
        success: true,
        result: result as unknown as Record<string, unknown>,
      };
    } else if (command.type === "SOURCE_ACCESS_MODE_SETUP") {
      if (!sourcePolicy || process.getuid?.() === 0)
        throw new SourcePolicyError(
          "source-policy-linux-unprivileged-required",
        );
      completion = {
        commandId: command.id,
        sequence: sequence + 1,
        success: true,
        result: await sourcePolicy.prepareModeSetup(command, identity.secret),
      };
    } else if (
      command.type === "SOURCE_ACCESS_VALIDATE" ||
      command.type === "SOURCE_ACCESS_APPLY"
    ) {
      if (!sourcePolicy || process.getuid?.() === 0)
        throw new SourcePolicyError(
          "source-policy-linux-unprivileged-required",
        );
      const authorizationStillValid = () =>
        !signal?.aborted &&
        !!command.leaseExpiresAt &&
        Date.parse(command.leaseExpiresAt) > Date.now();
      if (!authorizationStillValid())
        throw new SourcePolicyError("source-command-lease-expired");
      if (command.type === "SOURCE_ACCESS_VALIDATE") {
        completion = {
          commandId: command.id,
          sequence: sequence + 1,
          success: true,
          result: await sourcePolicy.validate(command.payload),
        };
      } else {
        const { success, error, ...result } = await sourcePolicy.apply(
          command.payload,
          authorizationStillValid,
        );
        completion = {
          commandId: command.id,
          sequence: sequence + 1,
          success,
          result,
          ...(error ? { error: `Source access refused (${error}).` } : {}),
        };
      }
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
        `[pluton-agent] BACKUP_FILESYSTEM failed stage=${backupFailure.stage} code=${backupFailure.code} reason=${backupFailure.message}` +
          (backupFailure.databaseId
            ? ` databaseId=${backupFailure.databaseId} engine=${backupFailure.engine}`
            : ""),
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
        : command.type.startsWith("SOURCE_ACCESS_")
          ? `Source access refused (${error instanceof SourcePolicyError ? error.code : "source-policy-unavailable"}).`
          : "Remote filesystem backup failed.",
      ...(backupFailure
        ? {
            failureStage: backupFailure.stage,
            failureCode: backupFailure.code,
            ...(backupFailure.databaseId
              ? {
                  databaseId: backupFailure.databaseId,
                  engine: backupFailure.engine,
                }
              : {}),
          }
        : {}),
    };
  }
  await progress.flush();
  completion.sequence = sequence + 1;
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

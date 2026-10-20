import path from "node:path";
import { lstat } from "node:fs/promises";
import type { AgentConfig } from "./types.js";

/** Shared with the local upgrader; not a remotely writable configuration option. */
export const UPGRADE_PROTOCOL = {
  version: 1,
  activityFile: "source-access-activity.json",
  holdDirectory: ".upgrade-lock",
} as const;

export async function upgradeHeld(config: AgentConfig): Promise<boolean> {
  const directory = path.join(
    path.dirname(config.binDir || "/opt/pluton-agent/bin"),
    UPGRADE_PROTOCOL.holdDirectory,
  );
  try {
    // Any entry, including a corrupt or replaced lock, holds work closed.
    await lstat(directory);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentCapabilities, AgentInventory } from "./types.js";

export const AGENT_VERSION = "0.2.0";

const SAFE_COMMANDS: AgentCapabilities["commandTypes"] = [
  "PING",
  "INVENTORY_REFRESH",
];

export function privateBinaryPath(
  binDir: string | undefined,
  binary: "restic" | "rclone",
): string {
  return path.join(binDir || "/opt/pluton-agent/bin", binary);
}

function installedVersion(binary: string, args: string[]): string | undefined {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: 2_000,
    shell: false,
  });
  if (result.error || result.status !== 0) return undefined;
  const firstLine = result.stdout.split(/\r?\n/)[0]?.trim();
  return firstLine || undefined;
}

/**
 * Keep capability advertisement separate from host probing so it is easy to
 * audit: a filesystem-backup command is never advertised from an allowed root
 * alone, nor from a host-wide Restic/Rclone installation.
 */
export function commandTypesForInventory(input: {
  filesystemRootsConfigured: boolean;
  resticVersion?: string;
  rcloneVersion?: string;
}): AgentCapabilities["commandTypes"] {
  const commandTypes: AgentCapabilities["commandTypes"] = [...SAFE_COMMANDS];
  if (
    input.filesystemRootsConfigured &&
    input.resticVersion &&
    input.rcloneVersion
  ) {
    commandTypes.push("BACKUP_FILESYSTEM");
  }
  return commandTypes;
}

export function collectInventory(input: {
  filesystemRootsConfigured: boolean;
  binDir?: string;
}): AgentInventory {
  const resticVersion = installedVersion(
    privateBinaryPath(input.binDir, "restic"),
    ["version"],
  );
  const rcloneVersion = installedVersion(
    privateBinaryPath(input.binDir, "rclone"),
    ["version"],
  );
  return {
    hostname: os.hostname(),
    os: `${os.type()} ${os.release()}`,
    architecture: os.arch(),
    agentVersion: AGENT_VERSION,
    resticVersion,
    rcloneVersion,
    uptimeSeconds: Math.floor(os.uptime()),
    capabilities: {
      filesystemRootsConfigured: input.filesystemRootsConfigured,
      commandTypes: commandTypesForInventory({
        filesystemRootsConfigured: input.filesystemRootsConfigured,
        resticVersion,
        rcloneVersion,
      }),
    },
  };
}

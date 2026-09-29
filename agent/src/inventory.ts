import os from 'node:os';
import { spawnSync } from 'node:child_process';
import type { AgentCapabilities, AgentInventory } from './types.js';

export const AGENT_VERSION = '0.1.0';

function installedVersion(binary: string, args: string[]): string | undefined {
	const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 2_000, shell: false });
	if (result.error || result.status !== 0) return undefined;
	const firstLine = result.stdout.split(/\r?\n/)[0]?.trim();
	return firstLine || undefined;
}

export function collectInventory(capabilities: AgentCapabilities): AgentInventory {
	return {
		hostname: os.hostname(),
		os: `${os.type()} ${os.release()}`,
		architecture: os.arch(),
		agentVersion: AGENT_VERSION,
		resticVersion: installedVersion('restic', ['version']),
		rcloneVersion: installedVersion('rclone', ['version']),
		uptimeSeconds: Math.floor(os.uptime()),
		capabilities,
	};
}

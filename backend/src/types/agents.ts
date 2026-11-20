import type { Request } from 'express';
import type { AgentCommandType } from '../db/schema/agents';
import type { SourceAccessReport } from './agentSourceAccess';
import type { RestoreAccessReport } from '../utils/agentHostRestore';

export const AGENT_COMMAND_TYPES: readonly AgentCommandType[] = [
	'PING',
	'INVENTORY_REFRESH',
	'BACKUP_FILESYSTEM',
	'SOURCE_ACCESS_VALIDATE',
	'SOURCE_ACCESS_APPLY',
	'SOURCE_ACCESS_MODE_SETUP',
	'RESTORE_FILESYSTEM',
];
export const AGENT_REQUEST_SKEW_MS = 5 * 60 * 1000;
export const AGENT_COMMAND_LEASE_MS = 60 * 1000;
/**
 * Renewal of a BACKUP_FILESYSTEM or RESTORE_FILESYSTEM lease (status checks and progress events). The
 * Agent is a serial executor, so a backup holds its Agent anyway; a longer lease
 * lets an Agent 0.8.1 backup outlive a Pluton restart or a proxy reload, at the
 * cost of a slower requeue (at most this long) if the Agent itself dies. A first
 * lease, before the Agent renews it, stays AGENT_COMMAND_LEASE_MS.
 */
export const AGENT_BACKUP_LEASE_RENEWAL_MS = 10 * 60 * 1000;

export function agentCommandRenewalMs(type: AgentCommandType): number {
	return type === 'BACKUP_FILESYSTEM' || type === 'RESTORE_FILESYSTEM'
		? AGENT_BACKUP_LEASE_RENEWAL_MS
		: AGENT_COMMAND_LEASE_MS;
}

export type AgentInventory = {
	hostname: string;
	os: string;
	architecture: string;
	agentVersion: string;
	resticVersion?: string;
	rcloneVersion?: string;
	uptimeSeconds?: number;
	sourceAccess?: SourceAccessReport;
	/** Agent 0.9.0: host-approved restore roots (docs/AGENT_HOST_RESTORE.md section 5). */
	restoreAccess?: RestoreAccessReport;
	capabilities: {
		backupExclusionsVersion?: 1;
		filesystemRootsConfigured: boolean;
		commandTypes: AgentCommandType[];
		backupLifecycleVersion?: 1 | 2;
		databaseEngines?: ('mysql' | 'mariadb' | 'postgresql')[];
		hooksConfigured?: boolean;
		sourceAccessVersion?: 1;
		sourceAccessModesVersion?: 1;
		repositoryBackends?: ('sftp' | 's3')[];
		backupPayloadVersion?: 5;
		restoreFilesystemVersion?: 1;
	};
};

export type AuthenticatedAgent = {
	agentId: string;
	deviceId: string;
	secret: string;
};

export type AgentRequest = Request & {
	rawBody?: string;
	agent?: AuthenticatedAgent;
};

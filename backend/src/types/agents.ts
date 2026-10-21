import type { Request } from 'express';
import type { AgentCommandType } from '../db/schema/agents';
import type { SourceAccessReport } from './agentSourceAccess';

export const AGENT_COMMAND_TYPES: readonly AgentCommandType[] = [
	'PING',
	'INVENTORY_REFRESH',
	'BACKUP_FILESYSTEM',
	'SOURCE_ACCESS_VALIDATE',
	'SOURCE_ACCESS_APPLY',
	'SOURCE_ACCESS_MODE_SETUP',
];
export const AGENT_REQUEST_SKEW_MS = 5 * 60 * 1000;
export const AGENT_COMMAND_LEASE_MS = 60 * 1000;

export type AgentInventory = {
	hostname: string;
	os: string;
	architecture: string;
	agentVersion: string;
	resticVersion?: string;
	rcloneVersion?: string;
	uptimeSeconds?: number;
	sourceAccess?: SourceAccessReport;
	capabilities: {
		backupExclusionsVersion?: 1;
		filesystemRootsConfigured: boolean;
		commandTypes: AgentCommandType[];
		backupLifecycleVersion?: 1 | 2;
		databaseEngines?: ('mysql' | 'mariadb' | 'postgresql')[];
		hooksConfigured?: boolean;
		sourceAccessVersion?: 1;
		sourceAccessModesVersion?: 1;
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

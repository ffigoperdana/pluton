import { ResticRestoredFile, SnapShotFile } from '../types/restic';
import { Restore } from '../db/schema/restores';

export interface RestoreResItem {
	id: Restore['id'];
	status: Restore['status'];
	error: Restore['errorMsg'];
	stats: Restore['taskStats'];
	planId: Restore['planId'];
	sourceId: Restore['sourceId'];
	sourceType: Restore['sourceType'];
	endedAt: Restore['ended'];
	createdAt: Restore['createdAt'];
	planName: string;
	storage: {
		id: Restore['storageId'];
		path: string;
		name: string;
		type: string;
	};
	deviceName: string;
}

export interface RestoreConfig {
	target: string;
	overwrite: 'always' | 'if-changed' | 'if-newer' | 'never';
	includes: string[];
	excludes: string[];
	delete: boolean;
	storageId?: string;
	replicationId?: string;
	sources?: string[];
	fromStorage?: boolean; // Reads the selected files from the live storage for sync plans
	/** Set by the server only for Phase 4 internal staged recovery records. */
	stagingOnly?: boolean;
	snapshotId?: string;
	/** Set by the server only for a restore executed by the Agent on its own host. */
	agentHost?: AgentHostRestoreConfig;
}

/** docs/AGENT_HOST_RESTORE.md 8.1. Non-secret; secrets are sealed at poll time only. */
export interface AgentHostRestoreConfig {
	version: 1;
	agentId: string;
	root: string;
	name: string;
	commandId: string;
	databaseId?: string;
	artifact?: { path: string; bytes: number; sha256: string };
	/** Set at completion from the Agent's closed failure vocabulary. */
	failureStage?: string;
	failureCode?: string;
	verified?: boolean;
}

export interface RestoreStats {
	total_files: number;
	files_restored: number;
	total_bytes: number;
	bytes_restored: number;
}

export type RestoreTaskStats = RestoreStats;

export interface RestoreOptions extends RestoreConfig {
	planId: string;
	storagePath: string;
	storageName: string;
	encryption: boolean;
	sources?: string[];
	performanceSettings?: Record<string, any>;
}

export interface RestoreStatsFile {
	planId: string;
	backupId: string;
	restoreId: string;
	sources: string[];
	config: Record<string, any>;
	sourcePaths: SnapShotFile[];
	restoredPaths: ResticRestoredFile[];
	stats: RestoreStats;
}

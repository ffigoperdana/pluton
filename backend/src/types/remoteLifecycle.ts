/** Phase 5 remote managed plans only. Password is a write-only API input. */
export type RemoteDatabaseBackup = {
	engine: 'mysql' | 'mariadb';
	host: string;
	port: number;
	tls: 'verify-identity' | 'local';
	database: string;
	username: string;
	dumpFilename: string;
	timeoutSeconds: number;
	maxDumpBytes: number;
	includeRoutines: boolean;
	includeEvents: boolean;
	password?: string;
	passwordConfigured?: boolean;
};

export type RemoteLifecycleHook = {
	/** Relative identifier under the agent's administrator-owned hook root. */
	id: string;
	args: string[];
	timeoutSeconds: number;
};

export type RemoteBackupLifecycle = {
	version: 1;
	database?: RemoteDatabaseBackup;
	preHook?: RemoteLifecycleHook;
	postHook?: RemoteLifecycleHook;
};

export type LifecycleWarning = {
	stage: 'post-backup' | 'cleanup';
	code: 'hook-failed' | 'hook-timeout' | 'hook-output-limit' | 'hook-invalid' | 'cleanup-failed';
};

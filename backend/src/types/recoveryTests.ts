export type RecoveryEngine = 'mariadb' | 'mysql' | 'postgresql';
export type RecoveryStatus =
	| 'queued'
	| 'running'
	| 'passed'
	| 'failed'
	| 'cancelled'
	| 'passed_with_warning';
export type RecoveryStage =
	| 'snapshot-validation'
	| 'repository-access'
	| 'staged-restore'
	| 'filesystem-validation'
	| 'database-artifact-validation'
	| 'database-target-preflight'
	| 'database-import'
	| 'database-import-validation'
	| 'database-cleanup'
	| 'workspace-cleanup'
	| 'job';
export type RecoveryCode =
	| 'snapshot-not-found'
	| 'snapshot-binding-mismatch'
	| 'snapshot-metadata-invalid'
	| 'repository-auth-failed'
	| 'repository-access-failed'
	| 'restore-failed'
	| 'restore-timeout'
	| 'unsafe-workspace'
	| 'unsupported-snapshot-file'
	| 'restored-file-count-mismatch'
	| 'restored-file-size-mismatch'
	| 'source-tree-missing'
	| 'workspace-size-limit'
	| 'insufficient-space'
	| 'database-metadata-incomplete'
	| 'database-artifact-missing'
	| 'database-artifact-size-mismatch'
	| 'database-artifact-hash-mismatch'
	| 'recovery-target-not-configured'
	| 'recovery-target-unsafe'
	| 'database-client-missing'
	| 'database-client-incompatible'
	| 'database-authentication-failed'
	| 'database-target-unavailable'
	| 'database-tls-failed'
	| 'database-already-exists'
	| 'database-import-failed'
	| 'database-import-timeout'
	| 'database-output-limit'
	| 'database-import-validation-failed'
	| 'database-role-missing'
	| 'database-cleanup-failed'
	| 'workspace-cleanup-failed'
	| 'import-disabled'
	| 'cancelled'
	| 'interrupted'
	| 'unexpected';
export type RecoveryWarning = { stage: RecoveryStage; code: RecoveryCode };
export type RecoveryDatabaseResult = {
	databaseId?: string;
	engine?: RecoveryEngine;
	/** Logical names and artifact paths are metadata, never connection credentials. */
	database?: string;
	path: string;
	bytes: number;
	sha256: string;
	artifactValidation: 'pending' | 'passed' | 'failed';
	importValidation: 'pending' | 'passed' | 'failed' | 'disabled' | 'not_configured';
	failureCode?: RecoveryCode;
	tables?: number;
	views?: number;
};
export type RecoveryResult = {
	filesystem?: {
		files: number;
		bytes: number;
		sourceTrees: number;
		integrity: 'restic-restore-and-structure';
	};
	databases: RecoveryDatabaseResult[];
	cleanup: { workspace: boolean; databases: boolean };
};
export type RecoveryPolicy = {
	enabled: boolean;
	databaseImport: 'disabled' | 'required';
	enabledAt?: number;
};
export type RecoveryTargetConfig = {
	engine: RecoveryEngine;
	host: string;
	port: number;
	username: string;
	tls: 'local' | 'verify-identity';
	enabled: boolean;
	/** An explicit assertion, also checked by a database-side recovery-only marker. */
	dedicated: true;
};
export type RecoveryTarget = RecoveryTargetConfig & { password: string };
export type RecoveryTargetView = RecoveryTargetConfig & { passwordConfigured: boolean };

/**
 * Plain-language explanations for the closed failure categories carried by notification
 * payloads. Server-authored text only: never include provider output, paths, credentials or
 * database names (docs/PHASE7_WEBHOOK_NOTIFICATIONS.md, "Events and payloads").
 */
export type ProblemExplanation = {
	/** Short headline of the problem. */
	title: string;
	/** What happened and the usual cause. */
	detail: string;
	/** What an administrator should do, in order. */
	steps: string[];
	/** Same-origin documentation path (no query, no user data). */
	guide: string;
};

const guides = {
	overview: '/docs/troubleshooting',
	source: '/docs/troubleshooting/source#1-understand-the-error',
	database: '/docs/troubleshooting/database',
	databaseTls: '/docs/database-backup/connections#diagnostik',
	hooks: '/docs/database-backup/hooks',
	storage: '/docs/troubleshooting/sftp',
	recovery: '/docs/troubleshooting/recovery',
	replication: '/docs/replication/status-retry',
	agent: '/docs/remote-agent/troubleshooting#offline',
} as const;

const rerun = 'Run the job again from the plan page and confirm it completes.';
const checkAgent =
	'On the Agent host, check the service with `systemctl status pluton-agent.service` and its recent log.';

const explain = (
	title: string,
	detail: string,
	steps: string[],
	guide: keyof typeof guides
): ProblemExplanation => ({ title, detail, steps, guide: guides[guide] });

const sourceAccess = (title: string, detail: string, fix: string) =>
	explain(
		title,
		detail,
		[
			'Open the plan, then Source Access, and run the read-only source check to see which path is affected.',
			fix,
			rerun,
		],
		'source'
	);

const databaseLogin = explain(
	'The database rejected the backup login',
	'The database server refused the username or password saved for this backup, or its authentication method is not allowed for that user.',
	[
		'Check the database user and password in the plan under Advanced → Database & Hooks.',
		'Confirm on the database server that this user may log in from the Agent host.',
		rerun,
	],
	'database'
);
const databasePrivileges = explain(
	'The database user is missing permissions',
	'The login worked, but the user is not allowed to read everything a complete dump needs (tables, views, routines or events). The password is probably correct.',
	[
		'Grant the minimum read permissions for a dump to the backup user (see the guide); do not switch to an administrator account.',
		'Check whether routines or events are requested in the plan and whether the user may read them.',
		rerun,
	],
	'database'
);
const databaseUnreachable = explain(
	'The database could not be reached',
	'The Agent could not open a connection to the database server. The server may be stopped, the host or port may be wrong, or a firewall blocks the Agent host.',
	[
		'Check that the database server is running and accepts connections.',
		'Check the host and port in the plan under Advanced → Database & Hooks.',
		'Check that the firewall allows the Agent host to reach that port.',
		rerun,
	],
	'database'
);
const databaseTls = explain(
	'The secure connection to the database failed',
	'The database certificate could not be verified, for example because the CA is not trusted or the certificate name does not match the server address.',
	[
		'Check the CA certificate and the server name configured for this database.',
		'Renew or replace the database certificate if it expired.',
		'Do not turn off certificate verification to make the backup pass.',
	],
	'databaseTls'
);
const databaseClient = explain(
	'The database dump tool is missing on the Agent host',
	'The client program needed to dump this database (mysqldump/mariadb-dump or pg_dump) is not installed or cannot be started.',
	[
		'Install the dump client that matches the database engine on the Agent host.',
		'Run the backup again; nothing was saved for this database in this run.',
	],
	'database'
);
const databaseSettings = explain(
	'The database or hook settings of this plan are invalid',
	'The saved database or hook configuration does not pass validation, so the Agent refused to run it.',
	[
		'Open the plan, then Advanced → Database & Hooks, and correct the highlighted fields.',
		'Save the plan and run the backup again.',
	],
	'database'
);
const databaseDumpBroken = explain(
	'The database dump produced no usable output',
	'The dump tool finished, but its output was empty or not valid SQL, so it was not stored as a backup.',
	[
		'Check that the configured database exists and that the backup user can read its tables.',
		'Look at the database server log for errors at the time of the backup.',
		rerun,
	],
	'database'
);
const databaseTooLarge = explain(
	'The database output is larger than the configured limit',
	'The dump or import produced more data than the limit set for this plan, so it was stopped to protect disk space.',
	[
		'Check whether the database grew unexpectedly.',
		'If the size is expected, raise the output limit in the plan under Advanced → Database & Hooks.',
		rerun,
	],
	'database'
);
const storageLogin = explain(
	'The storage login failed',
	'The backup storage rejected the saved credentials (password, SSH key or access key).',
	[
		'Open Storages and check the credentials of this storage.',
		'Confirm the account is still active and allowed to use this folder or bucket.',
		rerun,
	],
	'storage'
);
const storageAccess = explain(
	'Access to the backup storage was denied',
	'The storage accepted the login but does not allow reading or writing the repository folder or bucket.',
	[
		'Check the permissions of the repository folder (SFTP) or the bucket policy (S3).',
		'Make sure the storage path in the plan is the dedicated repository path.',
		rerun,
	],
	'storage'
);
const storageConnection = explain(
	'The backup storage could not be reached',
	'The connection to the storage failed because of the network, DNS, a firewall or TLS.',
	[
		'Check that the storage server or endpoint is online.',
		'Check DNS and firewall rules between the backup host and the storage.',
		rerun,
	],
	'storage'
);
const storageCheck = explain(
	'The backup repository could not be checked',
	'The repository on the storage could not be opened or verified before the backup started.',
	[
		'Check that the storage is online and has free space.',
		'Check the storage credentials and the repository path.',
		rerun,
	],
	'storage'
);
const uploadFailed = explain(
	'The backup upload failed',
	'The backup stopped before the new snapshot was confirmed in the repository, usually because the storage became unreachable, ran out of space or returned an error.',
	[
		'Check free space and connectivity of the storage.',
		'Look at the backup details in the plan for the stage that failed.',
		rerun,
	],
	'storage'
);
const workspace = explain(
	'A temporary working folder could not be used',
	'The private temporary folder used during the job could not be created, was not safe to use, or ran out of space.',
	[
		'Check free disk space on the backup host or Agent host.',
		'Check that no other process changed the temporary folder.',
		rerun,
	],
	'overview'
);
const hookProblem = (title: string, detail: string) =>
	explain(
		title,
		detail,
		[
			'Open the plan, then Advanced → Database & Hooks, and review the hook.',
			'Run the hook manually on the Agent host to see its own output.',
			rerun,
		],
		'hooks'
	);
const cleanup = explain(
	'Temporary files were not fully removed',
	'The job finished, but some temporary files or databases created for it could not be removed.',
	[
		'Open the job details and check which cleanup step failed.',
		'Remove the leftover temporary data after confirming it belongs to this job.',
	],
	'overview'
);
const restoreProblem = (title: string, detail: string, guide: keyof typeof guides = 'recovery') =>
	explain(
		title,
		detail,
		[
			'Open the recovery test in the plan to see which stage failed.',
			'Check that the snapshot still exists and that the storage is reachable.',
			'Run the recovery test again after fixing the cause.',
		],
		guide
	);
const recoveryTarget = (title: string, detail: string) =>
	explain(
		title,
		detail,
		[
			'Open Settings and check the recovery test target for this database engine.',
			'Make sure the target is a dedicated test server, not production.',
			'Run the recovery test again.',
		],
		'recovery'
	);
const internalTarget = (title: string, detail: string, fix: string) =>
	explain(title, detail, [fix, 'Run the recovery test again.'], 'recovery');
const artifactMismatch = (title: string, detail: string) =>
	explain(
		title,
		detail,
		[
			'Treat this backup as unverified; do not rely on it for this database.',
			'Run a new backup and test that one.',
			'If it happens again, check the storage for corruption or interrupted uploads.',
		],
		'recovery'
	);

const backupAndRecovery: Record<string, ProblemExplanation> = {
	'source-parent-not-traversable': sourceAccess(
		'A folder above the source cannot be opened',
		'The Agent service account (pluton-agent) cannot pass through one of the folders above the backup source, so it could not reach the files. No new snapshot was created.',
		'Give pluton-agent traverse (execute) permission on each parent folder only, as shown in the guide. Do not grant write access.'
	),
	'source-root-not-readable': sourceAccess(
		'The source folder cannot be read',
		'The Agent service account (pluton-agent) is not allowed to read the selected source folder, usually because of its permissions or ACL.',
		'Grant pluton-agent read and traverse access to the source folder (for example with an ACL), as shown in the guide.'
	),
	'source-entry-inaccessible': sourceAccess(
		'Some files inside the source cannot be read',
		'At least one file or folder inside the source is not readable by pluton-agent. The backup stopped instead of saving an incomplete copy.',
		'Fix the permissions of the listed entries, or exclude them under Backup Exclusions if they are not needed.'
	),
	'source-missing': sourceAccess(
		'The source path no longer exists',
		'The configured source folder, or an entry inside it, was not found. It may have been moved, renamed, or its disk is not mounted.',
		'Check the path on the host. Remount the disk or update the plan source to the new path.'
	),
	'source-symlink-escape': sourceAccess(
		'A link points outside the allowed folders',
		'A symbolic link in the source leads to a location outside the folders this Agent may back up, or it changed during the check.',
		'Back up the real target folder instead, ask the host administrator to approve it, or exclude the link.'
	),
	'source-unsupported-type': sourceAccess(
		'The source contains an unsupported file type',
		'The source includes a special file (such as a socket or device file) that cannot be backed up.',
		'Exclude that entry under Backup Exclusions.'
	),
	'source-policy-violation': sourceAccess(
		'The source is outside the approved folders',
		'The selected path is not inside the folders the host administrator delegated to this Agent.',
		'Choose a path inside the approved folders, or ask the host administrator to approve the new folder.'
	),
	'source-validation-failed': sourceAccess(
		'The source could not be checked',
		'The Agent could not validate the source before the backup started.',
		'Review the result of the source check and fix the reported permission or path problem.'
	),
	'state-overlap': explain(
		'The source overlaps the Agent’s own data',
		'The source includes the Agent’s private folders (such as /var/lib/pluton-agent). Backing them up is refused for safety.',
		['Remove the Agent folders from the plan source or exclude them.', rerun],
		'source'
	),
	'database-auth-failed': databaseLogin,
	'database-authentication-failed': databaseLogin,
	'database-privileges-failed': databasePrivileges,
	'database-insufficient-privileges': databasePrivileges,
	'database-connection-failed': databaseUnreachable,
	'database-unavailable': databaseUnreachable,
	'database-target-unavailable': explain(
		'The recovery test database server could not be reached',
		'The test database server used to import the dump was not reachable or refused the connection.',
		[
			'Check that the recovery test database server is running.',
			'Check its address and credentials in Settings.',
			'Run the recovery test again.',
		],
		'recovery'
	),
	'database-tls-failed': databaseTls,
	'database-tls-verification-failed': databaseTls,
	'database-client-missing': databaseClient,
	'database-tool-unavailable': databaseClient,
	'database-client-incompatible': explain(
		'The database dump tool does not match the server version',
		'The installed dump client is older than, or incompatible with, the database server.',
		[
			'Install a dump client version that supports the database server version on the Agent host.',
			rerun,
		],
		'database'
	),
	'database-configuration-invalid': databaseSettings,
	'database-invalid-configuration': databaseSettings,
	'lifecycle-invalid': databaseSettings,
	'database-dump-failed': explain(
		'The database dump stopped with an error',
		'The dump tool exited with an error. A partial dump is never stored as a backup.',
		[
			'Look at the database server log at the time of the backup.',
			'Check free disk space on the Agent host.',
			rerun,
		],
		'database'
	),
	'database-dump-timeout': explain(
		'The database dump took too long',
		'The dump did not finish within the timeout set for this plan.',
		[
			'Check whether the database is under heavy load or much larger than before.',
			'Raise the dump timeout in the plan under Advanced → Database & Hooks if the duration is expected.',
			rerun,
		],
		'database'
	),
	'database-dump-invalid': databaseDumpBroken,
	'database-output-empty': databaseDumpBroken,
	'database-dump-output-limit': databaseTooLarge,
	'database-output-limit': databaseTooLarge,
	'invalid-payload': explain(
		'The Agent rejected the backup command',
		'The settings sent to the Agent did not pass its checks. This can happen after an upgrade when the Agent and server versions do not match.',
		[
			'Open the plan and save its settings again.',
			'Update the Agent if a newer version is available.',
			rerun,
		],
		'agent'
	),
	'state-validation-failed': explain(
		'The Agent’s private state is not valid',
		'The Agent could not validate its own private files, so it stopped safely.',
		[checkAgent, 'Check free disk space on the Agent host.', rerun],
		'agent'
	),
	'tool-unavailable': explain(
		'The Agent’s backup tools are unavailable',
		'The backup programs installed with the Agent could not be started.',
		['Reinstall or upgrade the Agent on that host.', checkAgent, rerun],
		'agent'
	),
	'sftp-password-obscure-failed': explain(
		'The Agent could not prepare the storage login',
		'The temporary storage configuration needed for this run could not be prepared on the Agent host.',
		['Check free disk space and the temporary folder on the Agent host.', checkAgent, rerun],
		'agent'
	),
	'temporary-config-failed': explain(
		'The Agent could not prepare its temporary configuration',
		'A private temporary file needed for this run could not be written on the Agent host.',
		['Check free disk space and the temporary folder on the Agent host.', checkAgent, rerun],
		'agent'
	),
	'repository-check-failed': storageCheck,
	'repository-target-check-failed': storageCheck,
	'repository-target-not-empty': explain(
		'The storage folder already contains other data',
		'A new repository can only be created in an empty, dedicated folder. The selected folder is not empty, so nothing was written.',
		[
			'Choose an empty, dedicated folder or prefix for this plan.',
			'Do not delete the existing data until you know what it is.',
		],
		'storage'
	),
	'target-check-access-failed': storageAccess,
	'repository-access-failed': storageAccess,
	'target-check-auth-failed': storageLogin,
	'repository-auth-failed': storageLogin,
	'target-check-transport-failed': storageConnection,
	'repository-initialization-failed': explain(
		'The backup repository could not be created',
		'The storage did not allow the new repository to be initialised, usually because of write permissions or free space.',
		['Check write permission and free space on the storage.', rerun],
		'storage'
	),
	'restic-backup-failed': uploadFailed,
	'restic-summary-missing': explain(
		'The backup ended without a confirmed snapshot',
		'The backup program finished without reporting the new snapshot, so the run is treated as failed.',
		['Look at the backup details in the plan for the last completed stage.', rerun],
		'overview'
	),
	'snapshot-confirmation-failed': explain(
		'The new snapshot could not be verified',
		'The snapshot or one of its required files (such as a database dump) could not be confirmed in the repository after upload.',
		['Check that the storage is reachable and not full.', rerun],
		'storage'
	),
	'workspace-failed': workspace,
	'unsafe-workspace': workspace,
	'workspace-size-limit': workspace,
	'insufficient-space': explain(
		'Not enough free disk space',
		'The job needs more free space for its temporary files than is available.',
		['Free up disk space on the backup host or Agent host.', 'Run the job again.'],
		'overview'
	),
	'hook-invalid': hookProblem(
		'A hook is not allowed',
		'A configured hook does not follow the hook rules (for example its location or arguments), so it was not run.'
	),
	'hook-failed': hookProblem(
		'A hook failed',
		'A configured hook exited with an error, so the job stopped.'
	),
	'hook-timeout': hookProblem(
		'A hook took too long',
		'A configured hook did not finish within its timeout.'
	),
	'hook-output-limit': hookProblem(
		'A hook printed too much output',
		'A configured hook produced more output than allowed, so it was stopped.'
	),
	'cleanup-failed': cleanup,
	'database-cleanup-failed': cleanup,
	'workspace-cleanup-failed': cleanup,
	'snapshot-not-found': restoreProblem(
		'The snapshot was not found',
		'The snapshot of this backup is no longer in the repository, for example because retention removed it.'
	),
	'snapshot-binding-mismatch': restoreProblem(
		'The snapshot does not match the backup record',
		'The snapshot found in the repository is not the one recorded for this backup, so it was not used.'
	),
	'snapshot-metadata-invalid': restoreProblem(
		'The snapshot information is incomplete',
		'The snapshot exists but its metadata could not be read or validated.'
	),
	'restore-failed': restoreProblem(
		'The test restore failed',
		'Files could not be restored from the snapshot into the private test area.'
	),
	'restore-timeout': restoreProblem(
		'The test restore took too long',
		'Restoring the snapshot did not finish within the allowed time.'
	),
	'unsupported-snapshot-file': restoreProblem(
		'The snapshot contains an unsupported file',
		'The snapshot contains a file type that the recovery test cannot restore safely.'
	),
	'source-tree-missing': restoreProblem(
		'The backed-up files are missing from the snapshot',
		'The expected source folder was not found inside the snapshot.'
	),
	'restored-file-count-mismatch': artifactMismatch(
		'The restored files do not match the backup',
		'Fewer or more files were restored than the backup recorded.'
	),
	'restored-file-size-mismatch': artifactMismatch(
		'Restored files have the wrong size',
		'At least one restored file does not have the size recorded at backup time.'
	),
	'restored-file-hash-mismatch': artifactMismatch(
		'Restored files have different content',
		'At least one restored file does not match the checksum recorded at backup time.'
	),
	'restored-link-target-mismatch': artifactMismatch(
		'A restored link points somewhere else',
		'A symbolic link was restored with a different target than at backup time.'
	),
	'database-artifact-missing': artifactMismatch(
		'The database dump is missing from the backup',
		'The backup record lists a database dump that is not present in the snapshot.'
	),
	'database-artifact-size-mismatch': artifactMismatch(
		'The database dump has the wrong size',
		'The dump in the snapshot does not have the size recorded at backup time.'
	),
	'database-artifact-hash-mismatch': artifactMismatch(
		'The database dump content changed',
		'The dump in the snapshot does not match the checksum recorded at backup time.'
	),
	'database-metadata-incomplete': artifactMismatch(
		'The database dump information is incomplete',
		'The backup does not contain all the information needed to verify its database dump.'
	),
	'recovery-target-not-configured': recoveryTarget(
		'No test database server is configured',
		'Importing the dump requires a recovery test database server for this engine, and none is set.'
	),
	'recovery-target-unsafe': recoveryTarget(
		'The test database server is not safe to use',
		'The configured recovery test server did not pass the safety checks, so nothing was imported.'
	),
	'database-already-exists': recoveryTarget(
		'The test database already exists',
		'A database with the same name already exists on the test server, so the import was refused to avoid overwriting it.'
	),
	'database-role-missing': recoveryTarget(
		'A database role is missing on the test server',
		'The dump refers to a role or user that does not exist on the recovery test server.'
	),
	'database-import-failed': explain(
		'Importing the dump into the test database failed',
		'The dump was restored, but loading it into the test database server returned an error.',
		[
			'Open the recovery test to see the import stage that failed.',
			'Check that the test server version and settings are compatible with the production database.',
			'Run the recovery test again.',
		],
		'recovery'
	),
	'database-import-validation-failed': artifactMismatch(
		'The imported database did not pass validation',
		'The dump was imported, but the checks on the imported database failed.'
	),
	'database-import-timeout': recoveryTarget(
		'Importing the dump took too long',
		'Loading the dump into the test database did not finish within the allowed time.'
	),
	'database-out-of-memory': recoveryTarget(
		'The test database ran out of memory',
		'The recovery test database server did not have enough memory to import the dump.'
	),
	'database-storage-full': recoveryTarget(
		'The test database ran out of disk space',
		'The recovery test database server ran out of disk space during the import.'
	),
	'import-disabled': recoveryTarget(
		'Database import testing is turned off',
		'The recovery test could not import the dump because database import testing is disabled.'
	),
	'internal-operator-unavailable': internalTarget(
		'The automatic recovery service is not available',
		'The host service that prepares the private test database did not respond.',
		'Check that the automatic recovery service is installed and running on the host.'
	),
	'internal-provisioning-timeout': internalTarget(
		'Preparing the test database took too long',
		'The private test database was not ready within the allowed time.',
		'Check host load and the automatic recovery service log.'
	),
	'internal-target-not-provisioned': internalTarget(
		'The test database was not prepared',
		'The private test database for this engine does not exist yet.',
		'Check the Internal recovery profile in Settings and the automatic recovery service on the host.'
	),
	'internal-target-unsafe': internalTarget(
		'The test database did not pass the safety checks',
		'The private test database did not match the expected isolated setup, so nothing was imported.',
		'Ask the host administrator to review the automatic recovery setup before running another test.'
	),
	'internal-resources-insufficient': internalTarget(
		'Not enough CPU or memory for the recovery test',
		'The host does not have enough free CPU or memory to run the private test database safely.',
		'Free up resources on the host or raise the container limits, then try again.'
	),
	'internal-cleanup-required': internalTarget(
		'A previous recovery test still needs cleanup',
		'Leftovers of an earlier test must be cleaned up before a new test can start.',
		'Open Database Restores or the recovery test list and finish the pending cleanup.'
	),
	'recovery-workload-busy': explain(
		'Another recovery test is running',
		'Only a limited number of recovery tests can run at the same time.',
		['Wait until the running test finishes.', 'Run this recovery test again.'],
		'recovery'
	),
	'unexpected': explain(
		'An unexpected error stopped the job',
		'The job stopped because of an error that does not belong to a known category. Notifications never include raw error text, so the details are only in the application.',
		[
			'Open the job details in the plan to read the recorded error.',
			'Check the server log, or the Agent log for remote backups, around the time shown below.',
			rerun,
			'If it happens again, report it with the Event ID shown below.',
		],
		'overview'
	),
	'interrupted': explain(
		'The job was interrupted',
		'The service stopped or restarted while the job was running, so it did not finish.',
		['Check why the service restarted (update, crash or host reboot).', rerun],
		'overview'
	),
	'cancelled': explain(
		'The job was cancelled',
		'Someone stopped this job before it finished. No result was recorded for this run.',
		['If it was not intended, run the job again from the plan page.'],
		'overview'
	),
};

const replication: Record<string, ProblemExplanation> = {
	'credentials-unavailable': explain(
		'The replica storage credentials could not be used',
		'The saved credentials for the replica storage could not be read on the server.',
		[
			'Open Storages and save the replica storage credentials again.',
			'Retry the copy from the backup mirror details.',
		],
		'replication'
	),
	'destination-unavailable': explain(
		'The replica storage could not be reached',
		'The server could not connect to the replica storage.',
		[
			'Check that the replica storage is online and reachable from the server.',
			'Retry the copy from the backup mirror details.',
		],
		'replication'
	),
	'destination-configuration-invalid': explain(
		'The replica storage settings are invalid',
		'The replica storage or its path in the plan is not configured correctly.',
		[
			'Check the replica storage and path in the plan replication settings.',
			'Retry the copy from the backup mirror details.',
		],
		'replication'
	),
	'destination-binding-changed': explain(
		'The replica repository changed',
		'The repository on the replica storage is not the one this plan used before, so the copy was stopped.',
		[
			'Check whether someone replaced or reset the replica folder.',
			'Point the plan to the correct replica path, or set up a new dedicated replica path.',
		],
		'replication'
	),
	'destination-unowned': explain(
		'The replica folder belongs to something else',
		'The replica path contains data that this plan did not create, so nothing was written.',
		['Choose an empty, dedicated replica path for this plan.'],
		'replication'
	),
	'source-binding-changed': explain(
		'The primary repository changed during the copy',
		'The primary repository no longer matched the backup that was being copied.',
		[
			'Check whether the primary repository was replaced or reset.',
			'Retry the copy from the backup mirror details.',
		],
		'replication'
	),
	'source-binding-mismatch': explain(
		'The backup does not match the primary repository',
		'The snapshot recorded for this backup could not be matched in the primary repository.',
		['Run a new backup; it will be copied to the replica automatically.'],
		'replication'
	),
	'artifact-binding-mismatch': explain(
		'Backup files did not match during the copy',
		'Files that belong to this backup did not match their recorded checksums.',
		[
			'Run a new backup and check that its copy completes.',
			'If it repeats, check the primary storage for corruption.',
		],
		'replication'
	),
	'backup-not-completed': explain(
		'The backup was not complete',
		'Only completed backups can be copied to a replica.',
		['Run a new backup; it will be copied after it completes.'],
		'replication'
	),
	'snapshot-id-incomplete': explain(
		'The backup has no complete snapshot ID',
		'The backup record does not contain the snapshot information needed for the copy.',
		['Run a new backup; it will be copied after it completes.'],
		'replication'
	),
	'timeout': explain(
		'The copy took too long',
		'Copying the backup to the replica did not finish within the allowed time.',
		[
			'Check the speed and free space of the replica storage.',
			'Retry the copy from the backup mirror details.',
		],
		'replication'
	),
	'claim-lost': explain(
		'The copy was interrupted',
		'The server lost track of the copy, for example because it restarted.',
		['Retry the copy from the backup mirror details.'],
		'replication'
	),
};

const families: [RegExp, ProblemExplanation][] = [
	[
		/^source-/,
		sourceAccess(
			'The backup source could not be read',
			'The Agent could not read the backup source.',
			'Fix the permission or path problem shown by the source check.'
		),
	],
	[
		/^database-/,
		explain(
			'A database step failed',
			'The database dump or import step did not complete.',
			[
				'Open the job details in the plan to see the failed stage.',
				'Check the database server and its log.',
				rerun,
			],
			'database'
		),
	],
	[/^(repository|target-check)-/, storageCheck],
	[/^hook-/, hookProblem('A hook failed', 'A configured hook did not complete.')],
	[/^workspace-/, workspace],
	[
		/^internal-/,
		internalTarget(
			'The private test database is not available',
			'The automatic recovery setup could not provide a test database.',
			'Check the Internal recovery profile in Settings and the automatic recovery service on the host.'
		),
	],
	[
		/^mysql-worker-/,
		recoveryTarget(
			'The MySQL test worker is not available',
			'The worker that imports MySQL/MariaDB dumps for recovery tests is not configured, busy or out of resources.'
		),
	],
];

const fallback = explain(
	'The job failed',
	'The job stopped with an error that has no more specific description.',
	['Open the plan and check the details of this job for the failed stage.', rerun],
	'overview'
);
const replicationFallback = explain(
	'The copy to the replica failed',
	'The backup could not be copied to the replica storage.',
	[
		'Open the backup mirror details in the plan for the failed step.',
		'Retry the copy after fixing the cause.',
	],
	'replication'
);

export function explainProblem(
	code: string | undefined,
	kind: 'job' | 'replication'
): ProblemExplanation {
	const value = code || '';
	if (kind === 'replication')
		return Object.hasOwn(replication, value)
			? replication[value]
			: Object.hasOwn(backupAndRecovery, value)
				? backupAndRecovery[value]
				: replicationFallback;
	if (Object.hasOwn(backupAndRecovery, value)) return backupAndRecovery[value];
	return families.find(([pattern]) => pattern.test(value))?.[1] || fallback;
}

/** Reader-facing description of a warning category: headline and what it means. */
export function warningLabel(code: string): string {
	return Object.hasOwn(backupAndRecovery, code)
		? `${backupAndRecovery[code].title}. ${backupAndRecovery[code].detail}`
		: 'A validation step reported a warning. Open the job details in the plan to review it.';
}

/**
 * Finds a closed category in a recorded error message such as
 * "... (restic-backup/restic-backup-failed)." and explains it. Undefined when the message
 * carries no known category (for example raw local Restic output).
 */
export function problemFromErrorText(error: string | undefined): ProblemExplanation | undefined {
	if (!error) return undefined;
	for (const match of error.matchAll(/\/([a-z][a-z0-9-]{2,63})(?=[;)])/g))
		if (Object.hasOwn(backupAndRecovery, match[1])) return backupAndRecovery[match[1]];
	return undefined;
}

export const agentGuide = guides.agent;

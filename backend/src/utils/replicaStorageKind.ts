import { providers } from './providers';

/**
 * Storage kinds a managed replica can use (docs/S3_PRIMARY_REPLICATION.md). Kept free of
 * credential and configuration imports so that store modules can use it without loading them.
 */
export type ReplicaStorageKind = 's3' | 'sftp';

export function replicaStorageKind(type: string | null | undefined): ReplicaStorageKind | undefined {
	if (type === 'sftp') return 'sftp';
	return type === 's3' || providers[type || '']?.type === 's3' ? 's3' : undefined;
}

/** The only replica kind a primary of this storage type may use. */
export function requiredReplicaKind(
	primaryType: string | null | undefined
): ReplicaStorageKind | undefined {
	const primary = replicaStorageKind(primaryType);
	return primary === 'sftp' ? 's3' : primary === 's3' ? 'sftp' : undefined;
}

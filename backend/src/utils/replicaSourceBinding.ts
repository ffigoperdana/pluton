import crypto from 'crypto';
import type { Backup } from '../db/schema/backups';

/** Exact immutable completion evidence used by replication and recovery. */
export function replicaSourceBinding(backup: Backup) {
	return crypto
		.createHash('sha256')
		.update(
			JSON.stringify({
				snapshotId: backup.completionStats?.snapshot_id,
				sourceId: backup.sourceId,
				sourceType: backup.sourceType,
				sourcePaths: backup.completionStats?.sourcePaths || backup.sourceConfig?.includes || [],
				lifecycle: backup.completionStats?.lifecycle,
			})
		)
		.digest('hex');
}

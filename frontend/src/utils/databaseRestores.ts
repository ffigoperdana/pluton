import type { RestorePreview, RestoreChoice, DatabaseRestoreView } from '../@types/databaseRestores';

export function restoreStatus(row: Pick<DatabaseRestoreView, 'status' | 'errorCode' | 'expired'>) {
   if (row.status === 'deleted') return row.errorCode ? 'Failed / cancelled — owned cleanup verified' : 'Deleted — owned cleanup verified';
   if (row.expired) return 'Expired — access revoked; cleanup may require operator action';
   return {
      provisioning_required: 'Provisioning Required',
      queued: 'Ready / Queued — not imported',
      importing: 'Importing',
      active: 'Active Restore',
      stopped: 'Stopped',
      expired: 'Expired',
      deleting: 'Deleting — verification pending',
      cleanup_required: 'Cleanup Required',
      failed: 'Failed',
      cancelled: 'Cancelled',
      deleted: 'Deleted',
   }[row.status];
}
export function needsRestoreRefresh(row: DatabaseRestoreView) {
   return row.status !== 'deleted';
}
export function initialRestoreChoice(preview: RestorePreview): RestoreChoice {
   return {
      databaseId: preview.databases.find((entry) => entry.databaseId)?.databaseId || '',
      mode: 'internal',
      targetId: '',
      ttlSeconds: 86400,
      resources: false,
      security: false,
   };
}
export function restoreRefusal(preview: RestorePreview, choice: RestoreChoice) {
   const artifact = preview.databases.find((entry) => entry.databaseId === choice.databaseId);
   if (!artifact?.databaseId || !artifact.engine || !artifact.database) return 'Trusted database identity is missing; no engine is guessed.';
   if (!preview.engines[artifact.engine].includes(choice.mode))
      return 'This engine/destination is not implemented. MySQL persistent restore is unavailable.';
   const target = preview.targets.find((entry) => entry.id === choice.targetId);
   if (choice.mode === 'custom' && (!target || target.engine !== artifact.engine || target.database !== artifact.database))
      return 'Select an approved dedicated target for this exact engine and database.';
   const policy = choice.mode === 'internal' ? preview.internalPolicy : target!;
   if (choice.ttlSeconds > policy.maxRetentionSeconds || choice.ttlSeconds < 3600) return 'Retention exceeds the operator-approved contract.';
   if (artifact.bytes > policy.maxSqlBytes) return 'SQL exceeds the operator-approved size budget.';
   const sample = preview.resources.sample;
   if (!sample || preview.resources.status !== 'measured')
      return 'Capacity unknown. Refresh or ask the operator; acknowledgement cannot override admission.';
   if (
      sample.total < 3800 * 1024 ** 2 ||
      sample.available < 2560 * 1024 ** 2 ||
      sample.swapUsed > 128 * 1024 ** 2 ||
      sample.pressure > 1 ||
      sample.cgroupSwap > 0 ||
      sample.limit < 768 * 1024 ** 2 ||
      sample.used > sample.limit * 0.85 ||
      sample.diskAvailable < artifact.bytes + 2 * 1024 ** 3
   )
      return 'Measured resources are insufficient. Server admission will check again.';
   if (preview.workloadBusy) return 'Another backup, restore or recovery workload is active. Refresh when it settles.';
   if (!choice.resources || !choice.security) return 'Review both resource and security acknowledgements.';
   return null;
}
export function restoreBody(preview: RestorePreview, choice: RestoreChoice) {
   if (restoreRefusal(preview, choice)) throw new Error('Restore confirmation is not valid.');
   return {
      planId: preview.planId,
      backupId: preview.backupId,
      snapshotId: preview.snapshotId,
      metadataToken: preview.metadataToken,
      databaseId: choice.databaseId,
      mode: choice.mode,
      ...(choice.mode === 'custom' ? { targetId: choice.targetId } : {}),
      ttlSeconds: choice.ttlSeconds,
      resourcesAcknowledged: true,
      securityAcknowledged: true,
   };
}

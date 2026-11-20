import type { RestorePreview, RestoreChoice, DatabaseRestoreView } from '../@types/databaseRestores';
import { internalResourceSafety } from './internalResourceSafety.ts';

export function restoreResourceSafety(preview: RestorePreview, choice: RestoreChoice, checking = false) {
   const artifact = preview.databases.find((entry) => entry.databaseId === choice.databaseId);
   if (choice.mode !== 'internal' || !artifact?.engine) return undefined;
   return internalResourceSafety({
      engine: artifact.engine,
      bytes: artifact.bytes,
      maxSqlBytes: preview.internalPolicy.maxSqlBytes,
      resources: preview.resources,
      automatic: !!preview.lifecycle,
      available: preview.engines[artifact.engine].includes('internal') && preview.lifecycle?.available !== false,
      workloadBusy: preview.workloadBusy,
      checking,
   });
}

export function restoreStage(stage: string) {
   return (
      (
         {
            'checking-resources': 'Checking Resources',
            'provisioning-container': 'Provisioning Container',
            'starting-database': 'Starting Database',
            'database-import': 'Importing Database',
            'database-import-validation': 'Validating Restore',
            ready: 'Ready — not imported',
            active: 'Ready — Active Restore',
            'cleaning-up': 'Cleaning Up',
            'cleanup-required': 'Cleanup Required',
            'host-ownership-unverified': 'Cleanup Required — host ownership unverified',
         } as Record<string, string>
      )[stage] || stage
   );
}
export function restoreStatus(row: Pick<DatabaseRestoreView, 'status' | 'errorCode' | 'expired'> & Partial<Pick<DatabaseRestoreView, 'lifecycle'>>) {
   if (row.status === 'deleted') return row.errorCode ? 'Failed / cancelled — owned cleanup verified' : 'Deleted — owned cleanup verified';
   if (row.expired)
      return row.lifecycle ? 'Expired — access revoked; owned cleanup pending' : 'Expired — access revoked; cleanup may require operator action';
   return {
      provisioning_required: row.lifecycle ? 'Awaiting automatic host lifecycle' : 'Provisioning Required',
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
export function restoreActionNotice(operation: string, automatic: boolean) {
   if (['provision', 'stop', 'resume'].includes(operation))
      return automatic
         ? 'Request saved for the automatic host reconciler. Await verified host status below.'
         : 'Request saved. Manual operator action is still required.';
   return operation === 'delete' ? 'Owned deletion requested. Await verified cleanup below.' : 'Metadata inspection updated.';
}
export function needsRestoreRefresh(row: DatabaseRestoreView) {
   return row.status !== 'deleted';
}
const MYSQL_INTERNAL_MAX_SQL_BYTES = 128 * 1024 ** 2;
/** The SQL size Internal accepts: the operator budget, and never more than 128 MiB for MySQL. */
export function internalSqlBudget(preview: RestorePreview, engine?: string | null) {
   return engine === 'mysql' ? Math.min(preview.internalPolicy.maxSqlBytes, MYSQL_INTERNAL_MAX_SQL_BYTES) : preview.internalPolicy.maxSqlBytes;
}
export function exceedsInternalBudget(preview: RestorePreview, artifact?: { bytes: number; engine?: string | null }) {
   return !!artifact && artifact.bytes > internalSqlBudget(preview, artifact.engine);
}
const restoreSize = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`);
export function initialRestoreChoice(preview: RestorePreview): RestoreChoice {
   const first = preview.databases.find((entry) => entry.databaseId);
   return {
      databaseId: first?.databaseId || '',
      // A dump larger than the Internal budget starts on Custom; Internal could only refuse it.
      mode: first?.engine && preview.engines[first.engine].includes('internal') && !exceedsInternalBudget(preview, first) ? 'internal' : 'custom',
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
      return artifact.engine === 'mysql'
         ? choice.mode === 'internal'
            ? 'MySQL Internal requires the approved automatic operator and Internal-enabled Oracle worker. No manual fallback is assumed.'
            : 'The Oracle MySQL persistent worker is not configured. Ordinary backups are unaffected.'
         : 'This engine/destination is not implemented.';
   if (choice.mode === 'internal' && exceedsInternalBudget(preview, artifact))
      return `This SQL dump (${restoreSize(artifact.bytes)}) is larger than the Internal budget (${restoreSize(internalSqlBudget(preview, artifact.engine))}). Choose a Custom approved target.`;
   const target = preview.targets.find((entry) => entry.id === choice.targetId);
   if (choice.mode === 'custom' && (!target || target.engine !== artifact.engine || target.database !== artifact.database))
      return 'Select an approved dedicated target for this exact engine and database.';
   const policy = choice.mode === 'internal' ? preview.internalPolicy : target!;
   if (choice.mode === 'internal' && preview.lifecycle && !preview.lifecycle.available)
      return 'Automatic host operator unavailable. Refresh or ask the operator; no manual fallback is assumed.';
   if (choice.ttlSeconds > policy.maxRetentionSeconds || choice.ttlSeconds < 3600) return 'Retention exceeds the operator-approved contract.';
   const mysqlInternal = artifact.engine === 'mysql' && choice.mode === 'internal';
   if (mysqlInternal && !preview.lifecycle?.available) return 'MySQL Internal requires a ready automatic host operator.';
   if (artifact.bytes > (mysqlInternal ? Math.min(policy.maxSqlBytes, 128 * 1024 ** 2) : policy.maxSqlBytes))
      return 'SQL exceeds the operator-approved size budget.';
   const safety = restoreResourceSafety(preview, choice);
   if (safety && !safety.allowed) return safety.message;
   const sample = preview.resources.sample;
   if (!sample || preview.resources.status !== 'measured')
      return 'Capacity unknown. Refresh or ask the operator; acknowledgement cannot override admission.';
   if (
      sample.total < 3800 * 1024 ** 2 ||
      sample.available < (mysqlInternal ? 2944 : 2560) * 1024 ** 2 ||
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

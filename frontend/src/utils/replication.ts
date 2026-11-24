import type { PlanReplicationSettings } from '../@types/plans';
import type { BackupMirror } from '../@types/backups';
import { AGENT_S3_STORAGE_TYPES, managedReplicaStorageTypes } from './agentRepository.ts';

export const MAX_REPLICATION_DESTINATIONS = 2;

/** UI validation supplements the server's storage identity and ownership checks. */
export function replicationSettingsError(
   settings: PlanReplicationSettings | undefined,
   primary: { storageId: string; storagePath: string; storageType?: string },
   managedAgent = false,
): string | undefined {
   if (!settings) return;
   if (settings.recoveryPolicy && !['primary-only', 'assisted', 'automatic'].includes(settings.recoveryPolicy)) return 'Invalid recovery source policy.';
   if (settings.recoveryPolicy === 'assisted' && (!managedAgent || !settings.enabled || !settings.storages.length))
      return 'Assisted Failover requires enabled compatible managed Agent replicas.';
   if (settings.backupFailover && !['off', 'automatic'].includes(settings.backupFailover)) return 'Invalid backup failover setting.';
   if (settings.backupFailover === 'automatic' && (!managedAgent || !settings.enabled || !settings.storages.length))
      return 'Backup failover requires enabled compatible managed Agent replicas.';
   if (settings.recoveryPolicy === 'automatic' && (!managedAgent || !settings.enabled || !settings.storages.length))
      return 'Automatic Failover requires enabled compatible managed Agent replicas.';
   if (settings.storages.length > MAX_REPLICATION_DESTINATIONS) return 'A backup plan supports at most two replication destinations.';
   if (!settings.enabled) return;
   if (!settings.storages.length) return 'Select at least one replication destination, or disable replication.';
   const seen = new Set<string>();
   for (const destination of settings.storages) {
      if (!destination.storageId) return 'Select a storage for each replication destination.';
      // An SFTP primary replicates to S3 and an S3 primary to SFTP; unknown primaries leave it to the server.
      const allowed = managedReplicaStorageTypes(primary.storageType);
      if (managedAgent && allowed.length && !allowed.includes(destination.storageType))
         return AGENT_S3_STORAGE_TYPES.includes(primary.storageType || '')
            ? 'An S3 primary replicates to SFTP storage.'
            : 'Managed Agent replication requires S3 or S3-compatible storage.';
      if (managedAgent && !destination.storagePath?.trim()) return 'A dedicated repository path is required for each replication destination.';
      const identity = JSON.stringify([destination.storageId, destination.storagePath]);
      if (seen.has(identity)) return 'Each replication destination must use a different repository path.';
      seen.add(identity);
      if (destination.storageId === primary.storageId && destination.storagePath === primary.storagePath)
         return 'A replication destination must be different from the primary repository.';
   }
}

export function mirrorSummary(mirrors: BackupMirror[], expectedDestinations = mirrors.length) {
   const total = Math.max(mirrors.length, expectedDestinations);
   const completed = mirrors.filter((mirror) => mirror.status === 'completed').length;
   const failed = mirrors.filter((mirror) => mirror.status === 'failed').length;
   const pending = Math.max(0, total - completed - failed);
   if (completed === total && total > 0) return { state: 'success' as const, label: `${completed}/${total} mirrors complete`, incomplete: false };
   if (failed > 0) return { state: 'failed' as const, label: `Redundancy incomplete: ${completed}/${total} mirrors complete`, incomplete: true };
   return { state: 'pending' as const, label: `Replication pending: ${pending}/${total} mirrors incomplete`, incomplete: true };
}

/** A failover backup (docs/BACKUP_FAILOVER.md): where it was written and whether it is back on the primary. */
export function failoverSummary(mirrors: BackupMirror[] | undefined) {
   const mirror = mirrors?.find((item) => item.failover);
   if (!mirror?.failover) return undefined;
   const { status, lastErrorCode } = mirror.failover;
   const name = mirror.storageName;
   const detail =
      status === 'queued'
         ? `Failover backup queued to ${name}.`
         : status === 'backup-failed'
           ? `The failover backup to ${name} failed.`
           : status === 'verify-pending' || status === 'verifying'
             ? `Written to ${name}; Pluton is verifying it there.`
             : status === 'verified'
               ? `Verified in ${name}; copy-back waits until the primary is reachable${lastErrorCode ? ` (${lastErrorCode})` : ''}.`
               : status === 'copying'
                 ? `Copying back from ${name} to the primary.`
                 : status === 'copied-back'
                   ? `Written to ${name} during a primary outage and copied back to the primary.`
                   : `Failover needs attention${lastErrorCode ? ` (${lastErrorCode})` : ''}. The snapshot stays in ${name}.`;
   const state: 'pending' | 'success' | 'failed' =
      status === 'copied-back' ? 'success' : status === 'failed' || status === 'backup-failed' ? 'failed' : 'pending';
   return { label: `Failover → ${name}`, detail, state, failedBackupId: mirror.failover.failedBackupId };
}

export function mirrorStatusLabel(status: BackupMirror['status']) {
   return status === 'completed' ? 'Completed' : status === 'failed' ? 'Failed' : status === 'started' ? 'In progress' : 'Pending';
}

export function hasPendingMirrors(backups: { mirrors?: BackupMirror[] }[]) {
   return backups.some((backup) => backup.mirrors?.some((mirror) => mirror.status === 'pending' || mirror.status === 'started'));
}

/**
 * Turning replication off on a saved plan that has replicas changes more than the toggle shows,
 * so it is confirmed first. A new plan, or one without replicas, toggles directly.
 */
export function needsReplicationOffConfirmation(
   settings: Pick<PlanReplicationSettings, 'enabled' | 'storages'> | undefined,
   nextEnabled: boolean,
   savedPlan: boolean,
): boolean {
   return savedPlan && !!settings?.enabled && !nextEnabled && settings.storages.length > 0;
}

/** What turning replication off does, in the order an operator needs it. */
export function replicationOffNotice(managedAgent: boolean): string[] {
   return [
      'New backups are no longer copied to the replica storages.',
      'Copies already in the replicas stay where they are. Nothing is deleted.',
      ...(managedAgent
         ? [
              'Recovery & Failover returns to Primary Only. Turning replication on again does not bring back Assisted or Automatic Failover; choose it again.',
              'Turning replication off and on does not retry failed copies. Use Retry in Mirror Details instead.',
              'Saving is refused while a copy is still pending or running.',
           ]
         : []),
   ];
}

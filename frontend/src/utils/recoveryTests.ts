import type { RecoveryTest } from '../@types/recoveryTests.ts';
export const recoveryStatusLabel = {
   queued: 'Queued',
   running: 'Running',
   passed: 'Passed',
   failed: 'Failed',
   cancelled: 'Cancelled',
   passed_with_warning: 'Passed with warning',
};
export function recoveryForBackup(tests: RecoveryTest[], backupId: string, snapshotId?: string): RecoveryTest | undefined {
   if (!snapshotId || !/^[a-f0-9]{64}$/.test(snapshotId)) return undefined;
   // Both identities must match; an older pass never validates a newer snapshot.
   return tests.find((test) => test.backupId === backupId && test.snapshotId === snapshotId);
}
export function recoveryActive(test?: RecoveryTest) {
   return !!test && ['queued', 'running'].includes(test.status);
}
export function canTestRecovery(backup: { status: string; inProgress?: boolean; completionStats?: { snapshot_id?: string } | null }) {
   return backup.status === 'completed' && !backup.inProgress && /^[a-f0-9]{64}$/.test(backup.completionStats?.snapshot_id || '');
}

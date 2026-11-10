export type AssistedRecoveryJob = {
   id: string;
   planId: string;
   planName?: string;
   backupId: string;
   status: 'checking' | 'awaiting-approval' | 'primary-ready' | 'running' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
   phase: string;
   createdAt: number;
   expiresAt: number;
   expired: boolean;
   sourceSnapshotId: string;
   primary?: { state: 'ready' | 'unavailable' | 'not-checked'; code?: string };
   candidates: {
      replicationId: string;
      position: number;
      state: 'passed' | 'failed';
      code?: string;
      destinationSnapshotId?: string;
      replicaVerified: boolean;
      recoveryPreflight: string;
      recoveryTested: boolean;
   }[];
   selected?: string;
   target: string;
   operation: string;
   includes: string[];
   excludes: string[];
   cleanupPending: boolean;
   failureCode?: string;
   stats?: { files: number; bytes: number };
   audit: { at: number; event: string; code?: string }[];
};
export const recoveryActive = (job: AssistedRecoveryJob) => ['checking', 'awaiting-approval', 'running'].includes(job.status);
/** Interrupted/cleanup-pending jobs are rediscovered, never replaced on mount. */
export const recoveryBlocking = (job: AssistedRecoveryJob) => recoveryActive(job) || job.cleanupPending || job.status === 'uncertain';
export const recoveryPolling = (jobs: AssistedRecoveryJob[]) =>
   jobs.some((job) => ['checking', 'running'].includes(job.status)) ? 3000 : jobs.some((job) => job.status === 'awaiting-approval') ? 15000 : false;
export const recoveryCanApprove = (job: AssistedRecoveryJob, replica: string, now = Date.now()) =>
   job.status === 'awaiting-approval' &&
   !job.expired &&
   job.expiresAt > now &&
   job.candidates.some((candidate) => candidate.replicationId === replica && candidate.state === 'passed');
/** Presentation tone for recoveryStatus(); cleanup that needs attention outranks any finished status. */
export type RecoveryTone = 'progress' | 'attention' | 'success' | 'error' | 'neutral';
export function recoveryTone(job: AssistedRecoveryJob): RecoveryTone {
   if (job.cleanupPending && !recoveryActive(job)) return 'attention';
   if (job.status === 'checking' || job.status === 'running') return 'progress';
   if (job.status === 'awaiting-approval') return 'attention';
   if (job.status === 'completed' || job.status === 'primary-ready') return 'success';
   if (job.status === 'failed' || job.status === 'uncertain') return 'error';
   return 'neutral';
}
export function recoveryStatus(job: AssistedRecoveryJob) {
   if (job.cleanupPending && !recoveryActive(job)) return 'Staging cleanup needs attention. No recovery is running.';
   if (job.status === 'awaiting-approval')
      return job.expired || job.expiresAt <= Date.now()
         ? 'Approval expired. Cancel this request and check again.'
         : 'Awaiting your approval. No restore has started.';
   if (job.status === 'checking') return 'Checking the exact snapshot and authorized repositories. No restore has started.';
   if (job.status === 'running')
      return 'Recovering from the approved replica into isolated staging. Closing this window does not cancel server work.';
   if (job.status === 'completed')
      return 'Staged recovery passed file integrity verification. No database was imported and no live target was overwritten.';
   if (job.status === 'uncertain')
      return 'Recovery was interrupted. It will not restart automatically. Review staging and cancel before creating a fresh request.';
   return job.status === 'primary-ready'
      ? 'Primary SFTP is available. Continue the normal restore flow.'
      : job.status === 'cancelled'
        ? 'Recovery cancelled.'
        : 'Recovery stopped safely. Review the diagnostic before retrying.';
}

/** UUID admission identity also works on supported LAN HTTP secure-random APIs. */
export function recoveryRequestId(source: Pick<Crypto, 'getRandomValues'> & Partial<Pick<Crypto, 'randomUUID'>> = globalThis.crypto): string {
   if (typeof source?.randomUUID === 'function') return source.randomUUID();
   if (typeof source?.getRandomValues !== 'function') throw new Error('Secure request identity is unavailable. Refresh in a supported browser.');
   const bytes = source.getRandomValues(new Uint8Array(16));
   bytes[6] = (bytes[6] & 15) | 64;
   bytes[8] = (bytes[8] & 63) | 128;
   const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
   return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

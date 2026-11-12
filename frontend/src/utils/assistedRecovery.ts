/** Closed server summary of Restic backend retries; it never carries provider text. */
export type AssistedRecoveryBackendRetries = {
   retryCount: number;
   gaveUpCount: number;
   recoveredCount: number;
   serverErrorCount: number;
   errorClasses: Partial<Record<string, number>>;
   loads: {
      objectType: string;
      packPrefix: string;
      length?: number;
      offset?: number;
      attempts: number;
      lastErrorClass: string;
      httpStatus?: number;
   }[];
   lastRetryAfterMs?: number;
   lastServedBytes?: number;
   lastExpectedBytes?: number;
   truncated?: boolean;
};
export type AssistedRecoveryDiagnostic = {
   phase: string;
   operation: string;
   timeoutCategory?: string;
   elapsedMs: number;
   failureCode: string;
   archive?: { backendRetries?: AssistedRecoveryBackendRetries };
};
export type AssistedRecoveryJob = {
   id: string;
   planId: string;
   planName?: string;
   backupId: string;
   status: 'checking' | 'awaiting-approval' | 'primary-ready' | 'running' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
   phase: string;
   createdAt: number;
   activeSince?: number;
   activity?:
      | 'awaiting-archive-output'
      | 'validating-archive-output'
      | 'archive-output-paused'
      | 'archive-backend-retrying'
      | 'archive-consumer-pending'
      | 'archive-exit-pending';
   diagnostic?: AssistedRecoveryDiagnostic;
   expiresAt: number;
   expired: boolean;
   sourceSnapshotId: string;
   primary?: { state: 'ready' | 'unavailable' | 'not-checked'; code?: string; diagnostic?: AssistedRecoveryDiagnostic };
   candidates: {
      replicationId: string;
      position: number;
      state: 'passed' | 'failed';
      code?: string;
      diagnostic?: AssistedRecoveryDiagnostic;
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
   /** Plan policy when the job was requested (older jobs report 'assisted'). */
   policy?: 'assisted' | 'automatic';
   /** How the recovery source was chosen; absent until a source is selected. */
   sourceSelection?: {
      mode: 'operator' | 'automatic';
      reason?: string;
      attempts: { replicationId: string; position: number; outcome: 'selected' | 'failed'; code?: string; at: number }[];
   };
};
/** Failures Pluton never answers by switching sources. */
const SECURITY_STOPS = new Set([
   'authentication-denied',
   'authorization-denied',
   'tls-invalid',
   'wrong-password',
   'configuration-invalid',
   'repository-unavailable',
   'source-binding-invalid',
   'approval-binding-changed',
   'repository-identity-mismatch',
]);
const replicaName = (job: AssistedRecoveryJob, replicationId?: string) => {
   const position = job.candidates.find((candidate) => candidate.replicationId === replicationId)?.position;
   return position ? `S3 Replica ${position}` : 'the selected replica';
};
export const recoveryActive = (job: AssistedRecoveryJob) => ['checking', 'awaiting-approval', 'running'].includes(job.status);
/** Interrupted/cleanup-pending jobs are rediscovered, never replaced on mount. */
export const recoveryBlocking = (job: AssistedRecoveryJob) => recoveryActive(job) || job.cleanupPending || job.status === 'uncertain';
export const recoveryInProgress = (job: AssistedRecoveryJob) => job.status === 'checking' || job.status === 'running';
export const recoveryPolling = (jobs: AssistedRecoveryJob[]) =>
   jobs.some(recoveryInProgress) ? 3000 : jobs.some((job) => job.status === 'awaiting-approval') ? 15000 : false;
export const recoveryCanApprove = (job: AssistedRecoveryJob, replica: string, now = Date.now()) =>
   job.status === 'awaiting-approval' &&
   !job.expired &&
   job.expiresAt > now &&
   job.candidates.some((candidate) => candidate.replicationId === replica && candidate.state === 'passed');
/** Readable words for backend phase/state/code values (`staging-preparation` -> `Staging preparation`); callers keep the exact value visible. */
export function recoveryLabel(value?: string) {
   const words = (value || '').replace(/[-_]+/g, ' ').trim();
   return words ? words[0].toUpperCase() + words.slice(1) : '';
}
/** Presentation tone for recoveryStatus(); cleanup that needs attention outranks any finished status. */
export type RecoveryTone = 'progress' | 'attention' | 'success' | 'error' | 'neutral';
export function recoveryTone(job: AssistedRecoveryJob): RecoveryTone {
   if (job.cleanupPending && !recoveryActive(job)) return 'attention';
   if (recoveryInProgress(job)) return 'progress';
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
   const automatic = job.sourceSelection?.mode === 'automatic';
   if (job.status === 'checking')
      return job.policy === 'automatic'
         ? 'Checking the primary repository first. Automatic Failover continues with a verified replica only if the primary is unreachable. No restore has started.'
         : 'Checking the exact snapshot and authorized repositories. No restore has started.';
   if (job.status === 'running')
      return automatic
         ? `Automatic failover in progress: recovering from ${replicaName(job, job.selected)} into isolated staging. Closing this window does not cancel server work.`
         : 'Recovering from the approved replica into isolated staging. Closing this window does not cancel server work.';
   if (job.status === 'completed')
      return automatic
         ? `Automatic failover succeeded. The staged recovery from ${replicaName(job, job.selected)} passed file integrity verification. No database was imported and no live target was overwritten.`
         : 'Staged recovery passed file integrity verification. No database was imported and no live target was overwritten.';
   if (job.status === 'failed' && job.failureCode === 'no-eligible-replica')
      return 'No eligible replica found. Recovery stopped safely and nothing was restored.';
   if (job.status === 'failed' && job.failureCode === 'automatic-failover-blocked')
      return 'Automatic failover did not start: another recovery holds the execution slot or the request expired. Nothing was restored.';
   if (job.status === 'failed' && job.failureCode && SECURITY_STOPS.has(job.failureCode))
      return 'Recovery stopped due to a security or identity restriction. Pluton does not switch sources for this kind of failure.';
   if (job.status === 'uncertain')
      return 'Recovery was interrupted. It will not restart automatically. Review staging and cancel before creating a fresh request.';
   if (job.status === 'failed' && job.diagnostic?.timeoutCategory === 'archive-backend-retrying')
      return 'Restic kept retrying a repository read. Recovery stopped after the inactivity limit.';
   if (job.status === 'failed' && job.diagnostic?.timeoutCategory === 'archive-output-idle')
      return 'Archive stream stalled. Recovery stopped after the inactivity limit.';
   return job.status === 'primary-ready'
      ? 'Primary SFTP is available. Continue the normal restore flow.'
      : job.status === 'cancelled'
        ? 'Recovery cancelled.'
        : 'Recovery stopped safely. Review the diagnostic before retrying.';
}

export function recoveryWorkDetail(job: AssistedRecoveryJob) {
   if (job.status !== 'running') return undefined;
   if (job.phase === 'filesystem-validation') return 'Verifying staged files against the archive.';
   if (job.phase === 'staging-cleanup') return 'Cleaning up temporary recovery resources.';
   switch (job.activity) {
      case 'awaiting-archive-output':
         return 'Waiting for the repository read to produce archive data.';
      case 'validating-archive-output':
         return 'Reading archive data and verifying snapshot entries.';
      case 'archive-output-paused':
         return 'No recent archive output. Pluton is still waiting for the repository read.';
      case 'archive-backend-retrying':
         return 'Restic is retrying a repository read. Pluton keeps waiting up to the inactivity limit.';
      case 'archive-consumer-pending':
         return 'Waiting for local archive validation to finish processing data.';
      case 'archive-exit-pending':
         return 'Archive output ended. Waiting for the native process to finish.';
   }
}

export function recoveryFailureAdvice(job: AssistedRecoveryJob) {
   if (job.cleanupPending) return 'Review staging cleanup and discard this request before starting another.';
   if (job.failureCode === 'tls-invalid' || job.failureCode === 'authentication-denied' || job.failureCode === 'wrong-password')
      return 'Ask an operator to verify repository trust and access before checking again.';
   const category = job.diagnostic?.timeoutCategory;
   if (category === 'archive-backend-retrying')
      return 'Review the retried repository object, its error class and the storage behavior with an operator before starting a new check.';
   if (category === 'archive-consumer-idle') return 'Review Pluton resource usage and local archive processing before starting a new check.';
   if (category === 'archive-exit-idle') return 'Review native process shutdown and Pluton resource usage before starting a new check.';
   if (job.failureCode === 'timeout' || job.failureCode === 'network-unavailable' || category)
      return 'Review the recorded phase and storage connectivity with an operator before starting a new check.';
   if (job.failureCode === 'no-eligible-replica') return 'Review the diagnostics for each replica before starting a new check.';
   return 'Review the recovery audit before starting a new check.';
}

/** Which source was used and why, from the server's recorded decision. */
export function recoveryDecision(job: AssistedRecoveryJob) {
   const selection = job.sourceSelection;
   if (!selection) return undefined;
   const used = selection.attempts.filter((attempt) => attempt.outcome === 'selected').at(-1);
   const failed = selection.attempts.filter((attempt) => attempt.outcome === 'failed');
   const parts = [
      selection.mode === 'automatic'
         ? `Recovery source: ${used ? `S3 Replica ${used.position}` : 'none'}, chosen automatically after the primary was ${recoveryLabel(selection.reason || 'unavailable').toLowerCase()}`
         : `Recovery source: ${used ? `S3 Replica ${used.position}` : 'none'}, approved by the operator`,
   ];
   for (const attempt of failed) parts.push(`S3 Replica ${attempt.position} failed: ${recoveryLabel(attempt.code || 'unknown').toLowerCase()}`);
   return parts.join(' · ') + '.';
}

export type RecoveryStep = { label: string; state: 'done' | 'active' | 'failed' | 'pending' };
const VERIFYING_PHASES = new Set(['filesystem-validation', 'final-verification']);
/** Automatic Failover progression derived only from server state; no inferred progress. */
export function recoverySteps(job: AssistedRecoveryJob): RecoveryStep[] {
   const steps: RecoveryStep[] = [];
   const primaryState = job.primary?.state;
   const checkingPrimary = job.status === 'checking' && job.phase === 'primary-check';
   steps.push({ label: 'Checking primary repository', state: checkingPrimary ? 'active' : primaryState ? 'done' : 'pending' });
   if (primaryState === 'ready') {
      steps.push({ label: 'Primary repository available', state: 'done' });
      return steps;
   }
   if (primaryState !== 'unavailable') return steps;
   steps.push({ label: `Primary repository unavailable (${recoveryLabel(job.primary?.code || 'unavailable').toLowerCase()})`, state: 'done' });
   steps.push({ label: 'Failover initiated', state: 'done' });
   for (const candidate of job.candidates)
      steps.push({
         label:
            candidate.state === 'passed'
               ? `S3 Replica ${candidate.position} verified`
               : `S3 Replica ${candidate.position} rejected (${recoveryLabel(candidate.code || 'unavailable').toLowerCase()})`,
         state: candidate.state === 'passed' ? 'done' : 'failed',
      });
   if (job.status === 'checking') {
      steps.push({ label: `Checking S3 Replica ${job.candidates.length + 1}`, state: 'active' });
      return steps;
   }
   if (job.failureCode === 'no-eligible-replica') {
      steps.push({ label: 'No eligible replica found', state: 'failed' });
      return steps;
   }
   for (const attempt of job.sourceSelection?.attempts || []) {
      const current = attempt.outcome === 'selected';
      const recovering = job.status === 'running' && current && !VERIFYING_PHASES.has(job.phase);
      steps.push({
         label: `Recovering from S3 Replica ${attempt.position}${attempt.outcome === 'failed' ? ` (${recoveryLabel(attempt.code || 'failed').toLowerCase()})` : ''}`,
         state: attempt.outcome === 'failed' ? 'failed' : recovering ? 'active' : job.status === 'completed' || VERIFYING_PHASES.has(job.phase) ? 'done' : job.status === 'running' ? 'active' : 'failed',
      });
   }
   if (!job.sourceSelection) return steps;
   const verifying = job.status === 'running' && VERIFYING_PHASES.has(job.phase);
   steps.push({ label: 'Verifying restored files', state: verifying ? 'active' : job.status === 'completed' ? 'done' : 'pending' });
   if (job.status === 'completed') steps.push({ label: 'Integrity verified', state: 'done' });
   else if (job.status === 'failed' || job.status === 'cancelled' || job.status === 'uncertain')
      steps.push({ label: job.status === 'cancelled' ? 'Recovery cancelled' : 'Recovery failed', state: 'failed' });
   return steps;
}

const RETRY_ERROR_WORDS: Record<string, string> = {
   'http-status': 'HTTP error',
   'partial-read': 'wrong-size response',
   'unexpected-eof': 'response ended early',
   'stream-reset': 'stream reset',
   timeout: 'timeout',
   'connection-reset': 'connection reset',
   'dns-not-found': 'host not found (DNS)',
   tls: 'TLS or certificate error',
   'not-found': 'object not found',
   other: 'other error',
};

/** One sentence from the closed retry summary, or undefined when Restic reported no retries. */
export function recoveryRetrySummary(diagnostic?: AssistedRecoveryDiagnostic) {
   const retries = diagnostic?.archive?.backendRetries;
   if (!retries || retries.retryCount + retries.gaveUpCount + retries.serverErrorCount === 0) return undefined;
   const parts = [`Restic retried a repository read ${retries.retryCount} ${retries.retryCount === 1 ? 'time' : 'times'}`];
   const load = retries.loads[retries.loads.length - 1];
   if (load) {
      const where =
         load.offset !== undefined && load.length !== undefined ? ` at byte ${load.offset.toLocaleString('en-US')} (${load.length.toLocaleString('en-US')} bytes)` : '';
      parts.push(`${load.objectType} pack ${load.packPrefix}${where}`);
      parts.push(`last error: ${RETRY_ERROR_WORDS[load.lastErrorClass] || recoveryLabel(load.lastErrorClass)}${load.httpStatus ? ` (HTTP ${load.httpStatus})` : ''}`);
   }
   if (retries.gaveUpCount) parts.push(`gave up ${retries.gaveUpCount} ${retries.gaveUpCount === 1 ? 'time' : 'times'}`);
   if (retries.lastServedBytes !== undefined && retries.lastExpectedBytes !== undefined)
      parts.push(`server sent ${retries.lastServedBytes.toLocaleString('en-US')} of ${retries.lastExpectedBytes.toLocaleString('en-US')} bytes`);
   return parts.join(' · ');
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

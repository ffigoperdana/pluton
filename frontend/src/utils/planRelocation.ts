import type { PlanRelocation, PlanRelocationOverview } from '../@types/planRelocations';

const ACTIVE = ['copying', 'verifying', 'ready'];

/** The relocation the dialog follows: an active one, else the most recent. */
export function currentRelocation(overview?: PlanRelocationOverview): PlanRelocation | undefined {
   const relocations = overview?.relocations || [];
   return relocations.find((relocation) => ACTIVE.includes(relocation.status)) || relocations[0];
}

/** Poll only while the server is working; settled states need no traffic. */
export function relocationPolling(overview?: PlanRelocationOverview): number | false {
   return (overview?.relocations || []).some(
      (relocation) => ['copying', 'verifying'].includes(relocation.status) || !!relocation.operation,
   )
      ? 3000
      : false;
}

/** The start form is shown when nothing is active and the latest result is settled. */
export function relocationShowsForm(overview?: PlanRelocationOverview): boolean {
   const latest = currentRelocation(overview);
   return !!overview?.canStart && (!latest || ['failed', 'cancelled', 'reverted', 'source-deleted'].includes(latest.status));
}

const STATUS: Record<string, string> = {
   copying: 'Copying',
   verifying: 'Verifying',
   ready: 'Verified, waiting for switch',
   switched: 'Moved',
   reverted: 'Moved back',
   failed: 'Failed',
   cancelled: 'Cancelled',
   'source-deleted': 'Moved, previous copy deleted',
};
export const relocationStatusLabel = (status: string) => STATUS[status] || status;

const PHASES: Record<string, string> = {
   'pausing-plan': 'Pausing the plan',
   'source-inventory': 'Listing the current repository',
   'destination-inventory': 'Checking the destination',
   copying: 'Copying repository files',
   'listing-verification': 'Comparing file lists',
   'hash-verification': 'Reading back every copied file (SHA-256)',
   'repository-verification': 'Comparing repository ID and snapshots',
   'restic-check': 'Running restic check on the copy',
};
export const relocationPhaseLabel = (phase: string) => PHASES[phase] || phase.replace(/-/g, ' ');

const OPERATIONS: Record<string, string> = {
   switching: 'Rechecking both copies and switching the plan',
   reverting: 'Rechecking the previous copy and moving back',
   'deleting-source': 'Deleting the previous copy',
};
export const relocationOperationLabel = (operation: string) => OPERATIONS[operation] || operation;

const FAILURES: Record<string, string> = {
   'unexpected-repository-file': 'A location contains files that are not part of a Restic repository. Nothing was deleted; review the folder.',
   'repository-incomplete': 'The repository is missing its config or key files.',
   'source-missing': 'The current repository folder was not found on its Storage.',
   'destination-not-empty': 'The destination folder is not empty. Choose an empty folder.',
   'destination-listing-mismatch': 'The copied file list does not match the original.',
   'destination-hash-mismatch': 'A copied file is damaged (SHA-256 mismatch). The plan was not moved.',
   'destination-conflict': 'The destination already has a different file with the same name.',
   'destination-full': 'The destination Storage is out of space or quota.',
   'source-changed': 'The repository changed after it was copied. Start again so the change is copied too.',
   'destination-changed': 'The copy changed after verification. Start again.',
   'repository-identity-mismatch': 'The copy is a different repository (repository ID differs).',
   'snapshot-set-mismatch': 'The copy does not list the same snapshots as the original.',
   'snapshot-missing': 'A snapshot recorded in backup history is missing from the repository.',
   'restic-check-failed': 'restic check reported a problem in the copy. The plan was not moved.',
   'network-unavailable': 'An SFTP server could not be reached from the Pluton server.',
   'authentication-denied': 'An SFTP server rejected the stored credentials.',
   'host-verification-failed': 'SFTP host verification failed.',
   'wrong-password': 'The repository password was rejected.',
   timeout: 'The operation stopped making progress and was stopped.',
   cancelled: 'The operation was cancelled.',
   'server-restarted': 'The Pluton server restarted during the copy. Start again; files already copied are reused.',
   'plan-busy': 'The plan became busy (backup, restore, replication or recovery). Try again when it is idle.',
   'source-delete-failed': 'Deleting the previous copy failed part-way. Try again; only repository files are removed.',
   'configuration-invalid': 'The Storage or path configuration is not valid for this operation.',
};
export const relocationFailureText = (code?: string) =>
   (code && FAILURES[code]) || 'The operation stopped safely. Nothing was changed on the plan.';

export function formatRelocationBytes(value?: number): string {
   if (value === undefined || !Number.isFinite(value) || value < 0) return 'unknown';
   const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
   let amount = value,
      unit = 0;
   while (amount >= 1024 && unit < units.length - 1) {
      amount /= 1024;
      unit++;
   }
   return `${unit === 0 ? amount : amount.toFixed(1)} ${units[unit]}`;
}

/** Real counters only. No percentage is invented when Rclone has not reported a total. */
export function relocationProgressText(relocation: PlanRelocation): string | undefined {
   const progress = relocation.progress || {};
   if (relocation.phase === 'copying' && progress.copyTotalBytes)
      return `${formatRelocationBytes(progress.copiedBytes)} of ${formatRelocationBytes(progress.copyTotalBytes)} transferred (${progress.copiedFiles || 0} of ${progress.copyTotalFiles || 0} files to copy; files already present are skipped)`;
   if (relocation.phase === 'hash-verification' && progress.totalFiles)
      return `${progress.verifiedFiles || 0} of ${progress.totalFiles} files read back`;
   if (progress.totalFiles && ['source-inventory', 'destination-inventory', 'copying'].includes(relocation.phase))
      return `Repository: ${progress.totalFiles} files, ${formatRelocationBytes(progress.totalBytes)}`;
   return undefined;
}

export const shortId = (value?: string) => (value ? value.slice(0, 12) : '');

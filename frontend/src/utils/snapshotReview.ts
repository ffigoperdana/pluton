import type { Backup } from '../@types/backups';
export type ChangeFilter = 'all' | 'added' | 'modified' | 'unchanged' | 'deleted';
export type SnapshotDetails = {
   backupId: string;
   planId: string;
   planName: string | null;
   status: Backup['status'];
   snapshotId: string | null;
   started: string | null;
   completed: string | null;
   durationSeconds: number | null;
   timeZone: string;
   storage: { id: string; name: string; type: string } | null;
   source: { id: string; type: string };
   statistics: Record<string, number | null>;
   databases: {
      reference: string | null;
      engine: string | null;
      database: string | null;
      path: string;
      bytes: number;
      sha256: string;
      status: string;
   }[];
   recovery: { id: string; status: string; createdAt: string } | null;
   replication: { id: string; storageName: string; status: string; snapshotId: string | null; verifiedAt: number | null }[];
   warnings: { stage: string; code: string }[];
   comparisonAvailable: boolean;
};
export type ComparisonStatus = {
   state: 'missing' | 'unavailable' | 'preparing' | 'ready' | 'failed' | 'cancelled';
   phase?: string;
   processedEntries?: number;
   totalEntries?: number;
   elapsedMs?: number;
   reason?: string;
   failureCode?: string;
   failureCategory?: string;
   failureDetail?: string;
   failureStage?: string;
   validationStage?: string;
   skippedCandidates?: number;
   compatibility?: { mode: 'exact-roots' | 'verified-database-roots'; currentDatabaseArtifacts: number; previousDatabaseArtifacts: number };
   retryAfterMs?: number;
   currentBackupId?: string;
   previousBackupId?: string;
   currentSnapshotId?: string;
   previousSnapshotId?: string;
   summary?: { added: number; modified: number; unchanged: number; deleted: number; addedLogicalBytes: number; removedLogicalBytes: number };
};
export async function snapshotRequest<T>(
   api: string,
   backupId: string,
   resource: string,
   signal?: AbortSignal,
   method = 'GET',
   body?: unknown,
): Promise<T> {
   const response = await fetch(`${api}/backups/${encodeURIComponent(backupId)}/${resource}`, {
      method,
      credentials: 'include',
      redirect: 'error',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
   });
   if (response.redirected || !/application\/json/i.test(response.headers.get('Content-Type') || '')) {
      await response.body?.cancel();
      throw new Error('Snapshot review is unavailable. Retry shortly.');
   }
   const reader = response.body?.getReader();
   let text = '',
      bytes = 0;
   try {
      if (!reader) throw new Error();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      for (;;) {
         const part = await reader.read();
         if (part.done) break;
         bytes += part.value.byteLength;
         if (bytes > 2 * 1024 ** 2) throw new Error();
         text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
   } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
   }
   const data = JSON.parse(text);
   if (!response.ok || data.success !== true) {
      const diagnostic = comparisonFailureMessage({ state: 'unavailable', failureDetail: data.failureDetail, failureCategory: data.failureCategory });
      throw new Error(
         response.status === 429
            ? 'Snapshot review is busy. Wait before retrying.'
            : data.failureDetail && diagnostic
              ? diagnostic
              : 'Snapshot review unavailable. Ordinary browsing remains available.',
      );
   }
   return data.result;
}
export function detailBackup(details: SnapshotDetails): Backup {
   return {
      id: details.backupId,
      status: details.status,
      snapshotId: details.snapshotId || '',
      started: details.started ? Date.parse(details.started) / 1000 : 0,
      ended: details.completed ? Date.parse(details.completed) / 1000 : 0,
      duration: details.durationSeconds || 0,
      totalFiles: details.statistics.totalFiles ?? 0,
      totalSize: details.statistics.logicalBytes ?? 0,
      inProgress: false,
      changes: { new: 0, modified: 0, removed: 0 },
   };
}
export const snapshotChangeLabel = (change?: string) =>
   ({ added: 'Added', modified: 'Modified', unchanged: 'Unchanged', deleted: 'Deleted' })[change || ''] || 'Not compared';

export function comparisonFailureMessage(value?: ComparisonStatus) {
   if (!value || !['failed', 'cancelled', 'unavailable'].includes(value.state)) return '';
   const details: Record<string, string> = {
      'repository-binding-changed': 'Repository binding changed or is unavailable. Review the managed plan/storage identity.',
      'historical-source-scope-mismatch': 'Recorded filesystem source scopes differ. Select a snapshot with a compatible historical scope.',
      'snapshot-root-path-incompatible':
         'Snapshot root paths cannot be proven compatible. Database workspace aliases require recorded artifact and exact index evidence.',
      'snapshot-ownership-mismatch': 'Snapshot ownership tags do not match the selected backup and plan.',
      'snapshot-identity-missing': 'An exact snapshot identity is missing or ambiguous. Historical metadata must be reviewed.',
      'previous-snapshot-unavailable':
         'No eligible previous snapshot is available. Review the selected previous backup; no replacement is silently used.',
      'historical-metadata-incomplete': 'Historical source or database artifact evidence is incomplete. No path alias or source scope is inferred.',
      'restic-diff-unavailable': 'The repository adapter cannot provide a verified Restic diff. Ordinary browsing remains available.',
      'snapshot-index-verification': 'Snapshot metadata index verification failed. Review the index failure category before an explicit retry.',
      'comparison-context-changed': 'The selected comparison evidence changed. Cached results cannot be reused; review the exact snapshot pair.',
      'diff-identity-mismatch': 'Restic diff did not confirm the selected snapshot identities. No comparison result is accepted.',
   };
   if (Object.prototype.hasOwnProperty.call(details, typeof value.failureDetail === 'string' ? value.failureDetail : '')) {
      const stages = [
         'pair-selection',
         'current-index',
         'previous-index',
         'snapshot-verification',
         'root-validation',
         'comparison-indexing',
         'restic-diff',
         'final-revalidation',
         'request',
      ];
      const stage = typeof value.failureStage === 'string' && stages.includes(value.failureStage) ? ' / ' + value.failureStage : '';
      return details[value.failureDetail!] + ' Diagnostic: ' + value.failureDetail + stage + '.';
   }
   if (value.state === 'unavailable' && !value.failureCategory) return '';
   const labels: Record<string, string> = {
      timeout: 'Comparison reached its bounded deadline. Review repository latency and recorded progress before an explicit retry.',
      cancelled: 'Comparison was cancelled. No completed comparison is available.',
      busy: 'Repository or metadata work is busy. Wait for other work to finish, then retry explicitly.',
      'resource-limit': 'Comparison metadata reached a cache, output, entry or disk-capacity limit. Review server resources.',
      'metadata-invalid':
         'Comparison evidence was incomplete, invalid or inconsistent. Ordinary browsing remains available; no unchanged result is assumed.',
      'binding-mismatch': 'Snapshot identity or source/repository binding changed. Review the exact snapshot pair.',
      'snapshot-unavailable': 'An exact snapshot in this comparison is unavailable.',
      'validation-conflict': 'Comparison validation refused a conflict. Review the specific safe diagnostic before retrying.',
      'repository-unavailable': 'Repository access failed. Check storage availability and the recorded server diagnostic category.',
   };
   const rawCode = typeof value.failureCode === 'string' ? value.failureCode : '';
   const code = /^(preparing|indexing|comparing|ready)-(?:[45][0-9]{2}|sqlite|unavailable)$/.test(rawCode) ? rawCode : 'unavailable';
   return (
      (Object.prototype.hasOwnProperty.call(labels, typeof value.failureCategory === 'string' ? value.failureCategory : '')
         ? labels[value.failureCategory!]
         : 'Comparison did not complete. Review server diagnostics before retrying.') +
      ' Diagnostic: ' +
      code +
      '.'
   );
}

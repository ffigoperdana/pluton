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
   if (!response.ok || data.success !== true)
      throw new Error(
         response.status === 429
            ? 'Snapshot review is busy. Wait before retrying.'
            : 'Snapshot review unavailable. Ordinary browsing remains available.',
      );
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
   if (value?.state !== 'failed' && value?.state !== 'cancelled') return '';
   const labels: Record<string, string> = {
      timeout: 'Comparison reached its bounded deadline. Review repository latency and recorded progress before an explicit retry.',
      cancelled: 'Comparison was cancelled. No completed comparison is available.',
      busy: 'Repository or metadata work is busy. Wait for other work to finish, then retry explicitly.',
      'resource-limit': 'Comparison metadata reached a cache, output, entry or disk-capacity limit. Review server resources.',
      'metadata-invalid':
         'Comparison evidence was incomplete, invalid or inconsistent. Ordinary browsing remains available; no unchanged result is assumed.',
      'binding-mismatch': 'Snapshot identity or source/repository binding changed. Review the exact snapshot pair.',
      'snapshot-unavailable': 'An exact snapshot in this comparison is unavailable.',
      'repository-unavailable': 'Repository access failed. Check storage availability and the recorded server diagnostic category.',
   };
   const code = /^(preparing|indexing|comparing|ready)-(?:[45][0-9]{2}|sqlite|unavailable)$/.test(value.failureCode || '')
      ? value.failureCode
      : 'unavailable';
   return (
      (labels[value.failureCategory || ''] || 'Comparison did not complete. Review server diagnostics before retrying.') +
      ' Diagnostic: ' +
      code +
      '.'
   );
}

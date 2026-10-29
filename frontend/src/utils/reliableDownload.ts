import type { DownloadMode, VerifiedExport } from './downloadPreparation';
export type ReliableJob = {
   id: string;
   state: 'queued' | 'validating' | 'exporting' | 'uploading' | 'verifying' | 'ready' | 'failed' | 'cancelled' | 'expired';
   mode: DownloadMode;
   snapshotId: string;
   createdAt: number;
   elapsedMs: number;
   processedBytes: number;
   uploadedBytes: number;
   totalBytes?: number;
   averageBytesPerSecond: number;
   expiresAt?: number;
   integrity: 'pending' | 'verified';
   summary?: VerifiedExport;
   failure?: string;
   cleanupPending: boolean;
};
export const reliableActive = (job: ReliableJob) => ['queued', 'validating', 'exporting', 'uploading', 'verifying'].includes(job.state);
const reasons: Record<string, string> = {
   'not-configured': 'Reliable Download needs a separate private export destination configured by the administrator.',
   'configuration-invalid': 'The export destination configuration needs administrator attention.',
   'destination-not-isolated': 'The export destination must be separate from backup repositories and replication.',
   'security-capability-missing': 'The storage provider did not pass the required privacy, encryption or resume checks.',
   'storage-unavailable': 'Temporary storage is unavailable.',
   'archive-refused': 'The snapshot archive could not be verified.',
   'object-mismatch': 'Object integrity or identity verification failed.',
   'quota-exceeded': 'Temporary export capacity is full. Cancel an unused export or wait for cleanup.',
   'queue-full': 'The export queue is full. Retry later.',
   cancelled: 'Export cancelled.',
   interrupted: 'The server restarted or the export deadline was reached. Retry creates a new verified export.',
   'cleanup-pending': 'Storage cleanup needs administrator attention.',
   expired: 'The export expired. Prepare a new export.',
   'binding-changed': 'The backup or destination binding changed. Prepare a new export.',
};
export const reliableFailure = (reason?: string) => reasons[reason || ''] || 'Reliable Download is unavailable. Retry to reconnect.';
async function json(response: Response, signal?: AbortSignal) {
   if (response.redirected || !/application\/json/i.test(response.headers.get('Content-Type') || '')) {
      await response.body?.cancel();
      throw new Error(`Download service unavailable (HTTP ${response.status}). Retry to reconnect.`);
   }
   const reader = response.body?.getReader();
   let value = '',
      bytes = 0;
   try {
      if (!reader) throw new Error();
      const decoder = new TextDecoder();
      for (;;) {
         const part = await reader.read();
         if (part.done) break;
         bytes += part.value.byteLength;
         if (bytes > 64 * 1024) throw new Error();
         value += decoder.decode(part.value, { stream: true });
      }
      value += decoder.decode();
      return JSON.parse(value);
   } catch {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      throw new Error('Download status was incomplete or invalid. Retry to reconnect.');
   } finally {
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
   }
}
export async function reliableRequest(
   api: string,
   backupId: string,
   mode: DownloadMode,
   id?: string,
   cancel = false,
   signal?: AbortSignal,
): Promise<ReliableJob> {
   const response = await fetch(`${api}/backups/${encodeURIComponent(backupId)}/exports${id ? `/${encodeURIComponent(id)}` : ''}`, {
      method: cancel ? 'DELETE' : id ? 'GET' : 'POST',
      credentials: 'include',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: id ? undefined : JSON.stringify({ mode }),
      signal,
   });
   const body = await json(response, signal);
   if (!response.ok || body.success !== true) throw new Error(reliableFailure(body.reason));
   const j = body.result;
   if (
      !j ||
      !/^[a-f0-9-]{36}$/.test(j.id) ||
      (id && id !== j.id) ||
      j.mode !== mode ||
      !/^[a-f0-9]{64}$/.test(j.snapshotId) ||
      !['queued', 'validating', 'exporting', 'uploading', 'verifying', 'ready', 'failed', 'cancelled', 'expired'].includes(j.state) ||
      !['createdAt', 'elapsedMs', 'processedBytes', 'uploadedBytes', 'averageBytesPerSecond'].every((k) => Number.isSafeInteger(j[k]) && j[k] >= 0) ||
      typeof j.cleanupPending !== 'boolean' ||
      (j.totalBytes !== undefined &&
         (!Number.isSafeInteger(j.totalBytes) ||
            j.totalBytes < 1024 ||
            j.totalBytes > 128 * 1024 ** 3 ||
            j.uploadedBytes > j.totalBytes ||
            j.processedBytes > j.totalBytes))
   )
      throw new Error('Export identity or progress was invalid.');
   if (j.state === 'ready') {
      const p = j.summary;
      const counts = (c: unknown, allowed: string[], total: number) =>
         !!c &&
         typeof c === 'object' &&
         !Array.isArray(c) &&
         Object.entries(c).every(([key, n]) => allowed.includes(key) && Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 500000) &&
         Object.values(c).reduce((n: number, v) => n + Number(v), 0) === total;
      if (
         j.integrity !== 'verified' ||
         !Number.isSafeInteger(j.expiresAt) ||
         !p ||
         p.version !== 1 ||
         p.mode !== mode ||
         p.binding?.backupId !== backupId ||
         p.binding?.snapshotId !== j.snapshotId ||
         typeof p.binding?.repositoryId !== 'string' ||
         p.binding.repositoryId.length > 128 ||
         p.archiveBytes !== j.totalBytes ||
         p.archiveBytes % 512 ||
         j.uploadedBytes !== p.archiveBytes ||
         !['archiveSha256', 'manifestSha256'].every((k) => /^[a-f0-9]{64}$/.test(p[k])) ||
         ![p.includedEntries, p.excludedEntries].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 500000) ||
         !counts(p.includedByType, mode === 'full' ? ['file', 'dir', 'symlink'] : ['file', 'dir'], p.includedEntries) ||
         !counts(p.excludedByType, mode === 'full' ? [] : ['symlink', 'dev', 'chardev', 'fifo', 'socket'], p.excludedEntries)
      )
         throw new Error('Export verification was invalid.');
   }
   return j;
}
export async function reliableAuthorization(api: string, backupId: string, id: string, sha256: string, bytes: number) {
   const response = await fetch(`${api}/backups/${encodeURIComponent(backupId)}/exports/${encodeURIComponent(id)}/authorization`, {
      method: 'POST',
      credentials: 'include',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
   });
   const body = await json(response);
   if (!response.ok || body.success !== true) throw new Error(reliableFailure(body.reason));
   const a = body.result;
   let url: URL;
   try {
      url = new URL(a.url);
   } catch {
      throw new Error('Download authorization was invalid.');
   }
   if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      a.sha256 !== sha256 ||
      a.bytes !== bytes ||
      !Number.isSafeInteger(a.expiresAt) ||
      a.expiresAt <= Date.now() ||
      a.expiresAt > Date.now() + 301000
   )
      throw new Error('Download authorization was invalid.');
   return { url: url.href, expiresAt: a.expiresAt as number };
}

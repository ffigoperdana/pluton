import type { DownloadMode, VerifiedExport } from './downloadPreparation';
import { responseFailure, DownloadFailure } from './downloadFailure.ts';
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
   performance?: {
      phase?: 'indexing' | 'archive-validation' | 'upload' | 'publication' | 'verification';
      indexedEntries?: number;
      lastProgressAgeMs?: number;
   };
   integrityMode?: 'versioned' | 'hcp-write-once' | 'application-encrypted-hcp';
   confidentiality?: 'application-encrypted' | 'provider-sse-s3';
   transport?: 'versioned-presigned-and-proxy' | 'authenticated-proxy';
};
export const reliableActive = (job: ReliableJob) => ['queued', 'validating', 'exporting', 'uploading', 'verifying'].includes(job.state);
const reasons: Record<string, string> = {'not-configured': 'Reliable Download needs a separate private export destination configured by the administrator.',
   'configuration-invalid': 'The export destination configuration needs administrator attention.',
   'encryption-key-unavailable': 'The export encryption keyring needs administrator attention. Existing backup data is unchanged.',
   'encryption-metadata-invalid': 'Export encryption metadata could not be verified. Administrator recovery is required.',
   'destination-not-isolated': 'The export destination must be separate from backup repositories and replication.',
   'security-capability-missing':
      'An administrator must complete a successful destination preflight for privacy, encryption, publication and resume before exporting.',
   'storage-unavailable': 'Temporary storage is unavailable.',
   'archive-refused': 'The snapshot archive could not be verified.',
   'object-mismatch': 'Object integrity or identity verification failed.',
   'quota-exceeded': 'Temporary export capacity is full. Cancel an unused export or wait for cleanup.',
   'queue-full': 'The export queue is full. Retry later.',
   cancelled: 'Export cancelled.',
   interrupted: 'The server restarted or the export deadline was reached. Retry creates a new verified export.',
   'cleanup-pending': 'Storage cleanup needs administrator attention.',
   expired: 'The export expired. Prepare a new export.',
   'binding-changed': 'The backup or destination binding changed. Prepare a new export.',};
export const reliableFailure = (reason?: string) =>
   reasons[reason || ''] || 'Reliable Download is unavailable. Review server readiness and diagnostics.';
export async function exportJson(response: Response, signal?: AbortSignal, maxBytes = 64 * 1024) {
   if (response.redirected || !/application\/json/i.test(response.headers.get('Content-Type') || '')) {
      await response.body?.cancel();
      throw responseFailure(response);
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
         if (bytes > maxBytes) throw new Error();
         value += decoder.decode(part.value, { stream: true });
      }
      value += decoder.decode();
      const body = JSON.parse(value);
      if (!body || typeof body !== 'object') throw new Error('Invalid response.');
      if (!response.ok || body.success !== true) {
         const reason = typeof body.reason === 'string' && Object.prototype.hasOwnProperty.call(reasons, body.reason) ? body.reason : undefined;
         throw responseFailure(response, reason, reason ? reliableFailure(reason) : undefined);
      }
      return body;
   } catch (error) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (error instanceof DownloadFailure) throw error;
      if (error instanceof TypeError && response.ok)
         throw new DownloadFailure('The status response connection was interrupted.', 'transport', true, response.status);
      throw responseFailure(response);
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
   const response = await fetch(`${api}/backups/${encodeURIComponent(backupId)}/exports${id ? `/${encodeURIComponent(id)}` : ''}`, {method: cancel ? 'DELETE' : id ? 'GET' : 'POST',
      credentials: 'include',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: id ? undefined : JSON.stringify({ mode }),
      signal,});
   const body = await exportJson(response, signal);
   return validateReliableJob(body.result, backupId, mode, id);
}
export function validateReliableJob(value: unknown, backupId: string, mode: DownloadMode, id?: string): ReliableJob {
   const j = value as ReliableJob;
   if (
      !j ||
      !/^[a-f0-9-]{36}$/.test(j.id) ||
      (id && id !== j.id) ||
      j.mode !== mode ||
      !/^[a-f0-9]{64}$/.test(j.snapshotId) ||
      !['queued', 'validating', 'exporting', 'uploading', 'verifying', 'ready', 'failed', 'cancelled', 'expired'].includes(j.state) ||
      !(['createdAt', 'elapsedMs', 'processedBytes', 'uploadedBytes', 'averageBytesPerSecond'] as const).every(
         (k) => Number.isSafeInteger(j[k]) && j[k] >= 0,
      ) ||
      typeof j.cleanupPending !== 'boolean' ||
      (j.integrityMode === 'application-encrypted-hcp' && (j.transport !== 'authenticated-proxy' || j.confidentiality !== 'application-encrypted')) ||
      (j.totalBytes !== undefined &&
         (!Number.isSafeInteger(j.totalBytes) ||
            j.totalBytes < 1024 ||
            j.totalBytes > 128 * 1024 ** 3 ||
            j.uploadedBytes > j.totalBytes ||
            j.processedBytes > j.totalBytes))
   )
      throw new DownloadFailure('Export identity or progress was invalid.', 'protocol', false);
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
         !(['archiveSha256', 'manifestSha256'] as const).every((k) => /^[a-f0-9]{64}$/.test(p[k])) ||
         ![p.includedEntries, p.excludedEntries].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 500000) ||
         !counts(p.includedByType, mode === 'full' ? ['file', 'dir', 'symlink'] : ['file', 'dir'], p.includedEntries) ||
         !counts(p.excludedByType, mode === 'full' ? [] : ['symlink', 'dev', 'chardev', 'fifo', 'socket'], p.excludedEntries)
      )
         throw new DownloadFailure('Export verification was invalid.', 'protocol', false);
   }
   // Optional diagnostics are never proof. Drop malformed/unknown fields independently.
   const telemetry = j.performance;
   j.performance =
      telemetry && typeof telemetry === 'object'
         ? {phase: ['indexing', 'archive-validation', 'upload', 'publication', 'verification'].includes(telemetry.phase || '')
                 ? telemetry.phase
                 : undefined,
              indexedEntries:
                 Number.isSafeInteger(telemetry.indexedEntries) && Number(telemetry.indexedEntries) >= 0 && Number(telemetry.indexedEntries) <= 500000
                    ? telemetry.indexedEntries
                    : undefined,
              lastProgressAgeMs:
                 Number.isSafeInteger(telemetry.lastProgressAgeMs) &&
                 Number(telemetry.lastProgressAgeMs) >= 0 &&
                 Number(telemetry.lastProgressAgeMs) <= 7 * 86400000
                    ? telemetry.lastProgressAgeMs
                    : undefined,}
         : undefined;
   return j;
}
export async function reliableAuthorization(api: string, backupId: string, id: string, sha256: string, bytes: number, signal?: AbortSignal) {
   const response = await fetch(`${api}/backups/${encodeURIComponent(backupId)}/exports/${encodeURIComponent(id)}/authorization`, {method: 'POST',
      signal,
      credentials: 'include',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',});
   const body = await exportJson(response, signal);
   const a = body.result;
   let url: URL;
   const proxy = a.transport === 'authenticated-proxy';
   try {
      url = proxy ? new URL(a.url, new URL(api, globalThis.location?.origin)) : new URL(a.url);
      if (proxy) {
         const expected = new URL(
            `${api}/backups/${encodeURIComponent(backupId)}/exports/${encodeURIComponent(id)}/content`,
            globalThis.location?.origin,
         );
         if (url.href !== expected.href) throw new Error();
      }
   } catch {
      throw new Error('Download authorization was invalid.');
   }
   if (
      (url.protocol !== 'https:' && !(proxy && url.protocol === 'http:')) ||
      url.username ||
      url.password ||
      a.sha256 !== sha256 ||
      a.bytes !== bytes ||
      !Number.isSafeInteger(a.expiresAt) ||
      a.expiresAt <= Date.now() ||
      a.expiresAt > Date.now() + 301000
   )
      throw new Error('Download authorization was invalid.');
   return { url: url.href, expiresAt: a.expiresAt as number, transport: proxy ? ('authenticated-proxy' as const) : ('versioned-presigned' as const) };
}

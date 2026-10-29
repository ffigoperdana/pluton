export type DownloadMode = 'full' | 'regular-files';
export type VerifiedExport = {
   version: 1;
   binding: { backupId: string; repositoryId: string; snapshotId: string };
   mode: DownloadMode;
   includedEntries: number;
   excludedEntries: number;
   includedByType: Record<string, number>;
   excludedByType: Record<string, number>;
   manifestSha256: string;
   archiveSha256: string;
   archiveBytes: number;
};
export type DownloadPreparation = {
   id: string;
   state: 'queued' | 'indexing' | 'validating' | 'ready' | 'failed' | 'cancelled' | 'expired';
   createdAt: number;
   elapsedMs: number;
   indexedEntries: number;
   validatedEntries: number;
   retryAfterMs: number;
   error?: string;
   exportMode?: DownloadMode;
   export?: VerifiedExport;
};
export const preparationActive = (job: DownloadPreparation) => ['queued', 'indexing', 'validating'].includes(job.state);
export async function preparationRequest(
   api: string,
   backupId: string,
   id?: string,
   cancel = false,
   signal?: AbortSignal,
   mode: DownloadMode = 'full',
): Promise<DownloadPreparation> {
   const url = `${api}/backups/${encodeURIComponent(backupId)}/${id ? `download-preparations/${encodeURIComponent(id)}` : 'action/download'}${mode === 'regular-files' ? '?exportMode=regular-files' : ''}`;
   const response = await fetch(url, { method: cancel ? 'DELETE' : id ? 'GET' : 'POST', credentials: 'include', redirect: 'error', signal });
   const retry = response.headers.get('Retry-After');
   const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : 0;
   const at = seconds ? Date.now() + seconds * 1000 : retry ? Date.parse(retry) : 0;
   const failure = (message: string) => Object.assign(new Error(message), { retryAt: Number.isFinite(at) ? at : 0 });
   if (!/application\/json/i.test(response.headers.get('Content-Type') || '') || response.redirected) {
      await response.body?.cancel();
      throw failure(`Preparation response unavailable (HTTP ${response.status}). Retry to reconnect to the same preparation.`);
   }
   const reader = response.body?.getReader();
   let text = '',
      bytes = 0;
   try {
      if (!reader) throw new Error();
      const decoder = new TextDecoder();
      for (;;) {
         const { done, value } = await reader.read();
         if (done) break;
         bytes += value.byteLength;
         if (bytes > 64 * 1024) throw new Error();
         text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
   } catch {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      throw failure('Preparation response was incomplete. Retry to reconnect.');
   } finally {
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
   }
   let data;
   try {
      data = JSON.parse(text);
   } catch {
      throw failure('Preparation response was invalid. Retry to reconnect.');
   }
   if (!response.ok || data.success !== true) {
      const message =
         typeof data.error === 'string' && data.error.length <= 500 && !/[<>]/.test(data.error)
            ? data.error
            : `Preparation request failed (HTTP ${response.status}).`;
      throw failure(message);
   }
   const job = id ? data.result : data.result?.preparation;
   if (
      !job ||
      !/^[a-f0-9-]{36}$/.test(job.id) ||
      (id && job.id !== id) ||
      !['queued', 'indexing', 'validating', 'ready', 'failed', 'cancelled', 'expired'].includes(job.state) ||
      !['createdAt', 'elapsedMs', 'indexedEntries', 'validatedEntries', 'retryAfterMs'].every(
         (key) => Number.isSafeInteger(job[key]) && job[key] >= 0,
      ) ||
      job.retryAfterMs > 60_000
   )
      throw failure('Preparation identity or status was invalid. Retry to reconnect.');
   if ((job.exportMode || 'full') !== mode) throw failure('Preparation export mode did not match the selected mode.');
   if (job.export) {
      const proof = job.export;
      const validCounts = (counts: unknown, allowed: string[], expected: number) =>
         !!counts &&
         typeof counts === 'object' &&
         !Array.isArray(counts) &&
         Object.entries(counts).every(([type, n]) => allowed.includes(type) && Number.isSafeInteger(n) && n >= 0 && n <= 500000) &&
         Object.values(counts).reduce((sum: number, n) => sum + Number(n), 0) === expected;
      if (
         proof.version !== 1 ||
         proof.mode !== mode ||
         proof.binding?.backupId !== backupId ||
         typeof proof.binding?.repositoryId !== 'string' ||
         proof.binding.repositoryId.length > 128 ||
         !/^[a-f0-9]{64}$/.test(proof.binding?.snapshotId) ||
         !Number.isSafeInteger(proof.includedEntries) ||
         !Number.isSafeInteger(proof.excludedEntries) ||
         proof.includedEntries < 0 ||
         proof.excludedEntries < 0 ||
         proof.includedEntries !== job.validatedEntries ||
         proof.includedEntries + proof.excludedEntries !== job.indexedEntries ||
         !validCounts(proof.includedByType, mode === 'full' ? ['file', 'dir', 'symlink'] : ['file', 'dir'], proof.includedEntries) ||
         !validCounts(proof.excludedByType, mode === 'full' ? [] : ['symlink', 'dev', 'chardev', 'fifo', 'socket'], proof.excludedEntries) ||
         !/^[a-f0-9]{64}$/.test(proof.manifestSha256) ||
         !/^[a-f0-9]{64}$/.test(proof.archiveSha256) ||
         !Number.isSafeInteger(proof.archiveBytes) ||
         proof.archiveBytes < 1024 ||
         proof.archiveBytes % 512
      )
         throw failure('Verified export counts or snapshot binding were invalid.');
   } else if (mode === 'regular-files' && job.state === 'ready') throw failure('Partial export verification was missing.');
   return { ...job, exportMode: mode };
}

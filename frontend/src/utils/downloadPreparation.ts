export type DownloadPreparation = {
   id: string;
   state: 'queued' | 'indexing' | 'validating' | 'ready' | 'failed' | 'cancelled' | 'expired';
   createdAt: number;
   elapsedMs: number;
   indexedEntries: number;
   validatedEntries: number;
   retryAfterMs: number;
   error?: string;
};
export const preparationActive = (job: DownloadPreparation) => ['queued', 'indexing', 'validating'].includes(job.state);
export async function preparationRequest(
   api: string,
   backupId: string,
   id?: string,
   cancel = false,
   signal?: AbortSignal,
): Promise<DownloadPreparation> {
   const url = `${api}/backups/${encodeURIComponent(backupId)}/${id ? `download-preparations/${encodeURIComponent(id)}` : 'action/download'}`;
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
   return job;
}

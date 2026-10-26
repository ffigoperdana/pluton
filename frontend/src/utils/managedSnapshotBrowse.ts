import type { FileItem } from '../@types/system';

export type ManagedSnapshotQuery = {
   path: string;
   search: string;
   offset: number;
   limit: number;
   sort: 'name' | 'size' | 'modifiedAt';
   order: 'asc' | 'desc';
   directoriesOnly?: boolean;
   retry?: boolean;
};
export type ManagedSnapshotPage =
   | { status: 'indexing'; retryAfterMs: number }
   | {
        status: 'ready';
        files: FileItem[];
        total: number;
        entries: number;
        offset: number;
        limit: number;
        nextOffset: number | null;
        snapshotId: string;
     };
export function managedSnapshotPageUrl(api: string, backupId: string, query: ManagedSnapshotQuery) {
   const params = new URLSearchParams();
   Object.entries(query).forEach(([key, value]) => params.set(key, String(value)));
   return `${api}/backups/${encodeURIComponent(backupId)}/files/page?${params}`;
}
export class ManagedSnapshotPageError extends Error {
   readonly reason?: string;
   readonly status?: number;
   readonly retryAt: number;
   constructor(message: string, reason?: string, status?: number, retryAt = 0) {
      super(message);
      this.reason = reason;
      this.status = status;
      this.retryAt = retryAt;
   }
}

function retryAt(response: Response, now: number) {
   const value = response.headers.get('Retry-After');
   if (!value) return 0;
   const at = /^\d+$/.test(value.trim()) ? now + Number(value) * 1000 : Date.parse(value);
   return Number.isFinite(at) && at > now ? at : 0;
}
const unavailable = 'Snapshot metadata is unavailable. Retry shortly.';
const proxyMessage = (status: number) =>
   status === 429
      ? 'Snapshot requests are rate limited. Wait before retrying.'
      : [502, 503, 504].includes(status)
        ? 'Snapshot service is temporarily unavailable. Retry shortly.'
        : unavailable;

async function boundedJson(response: Response) {
   // 500 rows with the server's bounded name/path/srcPath fields fit below 8 MiB.
   // Refuse a broken proxy/server's whole-manifest response before buffering it.
   const reader = response.body?.getReader();
   if (!reader) throw new Error('empty-response');
   const decoder = new TextDecoder('utf-8', { fatal: true });
   let bytes = 0,
      text = '';
   try {
      for (;;) {
         const chunk = await reader.read();
         if (chunk.done) break;
         bytes += chunk.value.byteLength;
         if (bytes > 8 * 1024 ** 2) throw new Error('response-limit');
         text += decoder.decode(chunk.value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
   } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
   }
}

async function readPage(response: Response, query: ManagedSnapshotQuery, now: number): Promise<ManagedSnapshotPage> {
   const at = retryAt(response, now);
   // Never consume/render proxy HTML or redirect/login pages as application errors.
   if (response.redirected || !/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(response.headers.get('Content-Type') || '')) {
      await response.body?.cancel().catch(() => undefined);
      throw new ManagedSnapshotPageError(proxyMessage(response.status), undefined, response.status, at);
   }
   let data;
   try {
      data = await boundedJson(response);
   } catch {
      throw new ManagedSnapshotPageError(proxyMessage(response.status), undefined, response.status, at);
   }
   if (!response.ok || data?.success !== true) {
      const message =
         typeof data?.error === 'string' &&
         data.error.length <= 500 &&
         !/[<>]/.test(data.error) &&
         ![...(data.error as string)].some((character) => character.charCodeAt(0) <= 0x1f)
            ? data.error
            : proxyMessage(response.status);
      const reason = typeof data?.reason === 'string' && /^[a-z-]{1,64}$/.test(data.reason) ? data.reason : undefined;
      throw new ManagedSnapshotPageError(message, reason, response.status, at);
   }
   const page = data.result;
   const integer = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
   if (page?.status === 'indexing' && integer(page.retryAfterMs) && page.retryAfterMs > 0 && page.retryAfterMs <= 60_000) return page;
   if (
      page?.status === 'ready' &&
      Array.isArray(page.files) &&
      page.files.length <= Math.min(query.limit, 500) &&
      integer(page.limit) &&
      page.limit > 0 &&
      page.limit <= 500 &&
      integer(page.total) &&
      integer(page.entries) &&
      page.entries <= 500_000 &&
      page.offset === query.offset &&
      page.limit === query.limit &&
      (page.nextOffset === null || (integer(page.nextOffset) && page.nextOffset > page.offset && page.nextOffset <= 500_000)) &&
      typeof page.snapshotId === 'string' &&
      /^[a-f0-9]{64}$/.test(page.snapshotId)
   )
      return page;
   throw new ManagedSnapshotPageError(unavailable, 'repository-output-invalid', response.status);
}

/** One indexing probe/cooldown per backup, shared by file and folder panels.
 * No metadata pages are retained here. Idle state is bounded to 64 backups.
 * Errors stop automatic polling; explicit retries still honor Retry-After.
 */
export function createManagedSnapshotTransport(fetcher: typeof fetch = (...args) => fetch(...args), now = Date.now) {
   type State = { indexing?: boolean; notBefore: number; error?: ManagedSnapshotPageError; probe?: Promise<ManagedSnapshotPage> };
   const states = new Map<string, State>();
   const wait = (promise: Promise<unknown>, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
         const abort = () => {
            cleanup();
            reject(new DOMException('Cancelled', 'AbortError'));
         };
         const cleanup = () => signal?.removeEventListener('abort', abort);
         signal?.addEventListener('abort', abort, { once: true });
         if (signal?.aborted) {
            abort();
            return;
         }
         promise.then(
            () => {
               cleanup();
               resolve();
            },
            (error) => {
               cleanup();
               reject(error);
            },
         );
      });
   return async (api: string, backupId: string, query: ManagedSnapshotQuery, signal?: AbortSignal): Promise<ManagedSnapshotPage> => {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const key = `${api}/backups/${encodeURIComponent(backupId)}`;
      let state = states.get(key);
      if (!state) {
         if (states.size >= 64) {
            const idle = [...states].find(([, value]) => !value.probe && value.notBefore <= now());
            if (!idle) throw new ManagedSnapshotPageError('Snapshot requests are busy. Retry shortly.');
            states.delete(idle[0]);
         }
         state = { notBefore: 0 };
         states.set(key, state);
      }
      if (state.error && state.notBefore > now()) throw state.error;
      while (state.indexing) {
         if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
         if (state.probe) {
            try {
               await wait(state.probe, signal);
            } catch (error) {
               if (signal?.aborted || error instanceof ManagedSnapshotPageError) throw error;
            }
            if (state.indexing) return { status: 'indexing', retryAfterMs: Math.max(1000, state.notBefore - now()) };
         } else if (state.notBefore > now()) {
            // Wait without retaining an abort listener or a timer after unmount.
            await new Promise<void>((resolve, reject) => {
               const abort = () => {
                  clearTimeout(timer);
                  signal?.removeEventListener('abort', abort);
                  reject(new DOMException('Cancelled', 'AbortError'));
               };
               const timer = setTimeout(() => {
                  signal?.removeEventListener('abort', abort);
                  resolve();
               }, state!.notBefore - now());
               signal?.addEventListener('abort', abort, { once: true });
               if (signal?.aborted) abort();
            });
         } else break;
      }
      if (state.error && state.notBefore > now()) throw state.error;
      const request = (async () => {
         try {
            const response = await fetcher(managedSnapshotPageUrl(api, backupId, query), { credentials: 'include', redirect: 'error', signal });
            if (signal?.aborted) {
               await response.body?.cancel().catch(() => undefined);
               throw new DOMException('Cancelled', 'AbortError');
            }
            const page = await readPage(response, query, now());
            if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
            state!.indexing = page.status === 'indexing';
            state!.notBefore = page.status === 'indexing' ? now() + page.retryAfterMs : 0;
            state!.error = undefined;
            return page;
         } catch (error) {
            if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
            const failure = error instanceof ManagedSnapshotPageError ? error : new ManagedSnapshotPageError(unavailable, undefined, 0);
            state!.error = failure;
            state!.notBefore = failure.retryAt;
            state!.indexing = false;
            throw failure;
         }
      })();
      if (state.indexing) state.probe = request;
      try {
         return await request;
      } finally {
         if (state.probe === request) state.probe = undefined;
      }
   };
}
export const fetchManagedSnapshotPage = createManagedSnapshotTransport();
export function snapshotParent(directory: string) {
   return directory.slice(0, directory.lastIndexOf('/'));
}

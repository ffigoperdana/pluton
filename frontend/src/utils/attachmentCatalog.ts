import { DownloadFailure, responseFailure } from './downloadFailure.ts';
import { startReliableTransfer } from './reliableDownload.ts';

export type AttachmentCatalogQuery = {
   search?: string;
   model?: string;
   status?: 'all' | 'present' | 'missing';
   sort?: 'name' | 'created' | 'size';
   order?: 'asc' | 'desc';
   offset: number;
   limit: number;
   retry?: boolean;
};

export type AttachmentCatalogPairing = {
   adapter: 'odoo';
   databasePlanId: string;
   databasePlanName: string | null;
   databaseBackupId: string;
   databaseBackupCompleted: string | null;
   database: string;
   filestoreRoot: string;
};

export type AttachmentCatalogItem = {
   id: number;
   name: string;
   mimetype: string | null;
   size: number | null;
   model: string | null;
   recordId: number | null;
   field: string | null;
   created: string | null;
   storedPath: string;
   present: boolean;
   snapshotSize: number | null;
};

export type AttachmentCatalogCounts = {
   attachments: number;
   present: number;
   missing: number;
   notInFilestore: number;
   invalid: number;
};

export type AttachmentCatalogPage =
   | {
        status: 'indexing';
        retryAfterMs: number;
        pairing: AttachmentCatalogPairing;
        progress: {
           phase: 'waiting' | 'database-dump' | 'filestore-index' | 'matching';
           dumpBytes: number;
           dumpTotal: number;
           attachments: number;
           matched: number;
           elapsedMs: number;
        };
     }
   | {
        status: 'ready';
        pairing: AttachmentCatalogPairing;
        counts: AttachmentCatalogCounts;
        models: { model: string; count: number }[];
        total: number;
        offset: number;
        limit: number;
        nextOffset: number | null;
        items: AttachmentCatalogItem[];
     };

export class AttachmentCatalogError extends Error {
   readonly status: number;
   constructor(message: string, status: number) {
      super(message);
      this.status = status;
   }
}

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const optionalText = (value: unknown, max: number) => value === null || (typeof value === 'string' && value.length <= max);
const optionalCount = (value: unknown) => value === null || count(value);

function validPairing(value: any): value is AttachmentCatalogPairing {
   return (
      !!value &&
      value.adapter === 'odoo' &&
      typeof value.databasePlanId === 'string' &&
      optionalText(value.databasePlanName, 512) &&
      typeof value.databaseBackupId === 'string' &&
      optionalText(value.databaseBackupCompleted, 64) &&
      typeof value.database === 'string' &&
      typeof value.filestoreRoot === 'string' &&
      value.filestoreRoot.startsWith('/')
   );
}

function validItem(value: any): value is AttachmentCatalogItem {
   return (
      !!value &&
      count(value.id) &&
      typeof value.name === 'string' &&
      value.name.length <= 255 &&
      optionalText(value.mimetype, 128) &&
      optionalCount(value.size) &&
      optionalText(value.model, 128) &&
      (value.recordId === null || Number.isSafeInteger(value.recordId)) &&
      optionalText(value.field, 128) &&
      optionalText(value.created, 40) &&
      typeof value.storedPath === 'string' &&
      typeof value.present === 'boolean' &&
      optionalCount(value.snapshotSize)
   );
}

/** Validates an untrusted catalog response; anything unexpected is refused, not shown. */
export function parseAttachmentCatalogPage(data: any, query: AttachmentCatalogQuery): AttachmentCatalogPage {
   const page = data?.result;
   const progress = page?.progress;
   if (
      page?.status === 'indexing' &&
      validPairing(page.pairing) &&
      count(page.retryAfterMs) &&
      page.retryAfterMs > 0 &&
      page.retryAfterMs <= 60_000 &&
      ['waiting', 'database-dump', 'filestore-index', 'matching'].includes(progress?.phase) &&
      ['dumpBytes', 'dumpTotal', 'attachments', 'matched', 'elapsedMs'].every((key) => count(progress[key]))
   )
      return page;
   if (
      page?.status === 'ready' &&
      validPairing(page.pairing) &&
      ['attachments', 'present', 'missing', 'notInFilestore', 'invalid'].every((key) => count(page.counts?.[key])) &&
      Array.isArray(page.models) &&
      page.models.length <= 50 &&
      page.models.every((entry: any) => typeof entry?.model === 'string' && count(entry.count)) &&
      count(page.total) &&
      page.offset === query.offset &&
      page.limit === query.limit &&
      (page.nextOffset === null || (count(page.nextOffset) && page.nextOffset > page.offset)) &&
      Array.isArray(page.items) &&
      page.items.length <= query.limit &&
      page.items.every(validItem)
   )
      return page;
   throw new AttachmentCatalogError('The attachment list could not be verified. Retry shortly.', 0);
}

export function attachmentCatalogUrl(api: string, backupId: string, query: AttachmentCatalogQuery) {
   const params = new URLSearchParams({ offset: String(query.offset), limit: String(query.limit) });
   if (query.search) params.set('search', query.search);
   if (query.model) params.set('model', query.model);
   if (query.status && query.status !== 'all') params.set('status', query.status);
   if (query.sort) params.set('sort', query.sort);
   if (query.order) params.set('order', query.order);
   if (query.retry) params.set('retry', 'true');
   return `${api}/backups/${encodeURIComponent(backupId)}/attachments?${params}`;
}

export async function fetchAttachmentCatalog(
   api: string,
   backupId: string,
   query: AttachmentCatalogQuery,
   signal?: AbortSignal,
): Promise<AttachmentCatalogPage> {
   const response = await fetch(attachmentCatalogUrl(api, backupId, query), {
      credentials: 'include',
      cache: 'no-store',
      signal,
   });
   const data = await response.json().catch(() => undefined);
   if (!response.ok) {
      const message = typeof data?.error === 'string' && data.error.length <= 500 ? data.error : 'The attachment list is unavailable.';
      throw new AttachmentCatalogError(message, response.status);
   }
   return parseAttachmentCatalogPage(data, query);
}

const DISPOSITION = /^attachment; filename="[A-Za-z0-9._ -]{1,200}"(?:; filename\*=UTF-8''[A-Za-z0-9%._~-]{1,2000})?$/;

/** Checks the download metadata first, then lets the browser stream the file. */
export async function downloadCatalogAttachment(api: string, backupId: string, item: AttachmentCatalogItem, signal: AbortSignal) {
   const url = `${api}/backups/${encodeURIComponent(backupId)}/attachments/${item.id}/download`;
   const head = await fetch(url, { method: 'HEAD', credentials: 'include', redirect: 'manual', cache: 'no-store', signal });
   if (head.type === 'opaqueredirect' || head.redirected || head.status !== 200) throw responseFailure(head);
   if (
      head.headers.get('Content-Type') !== 'application/octet-stream' ||
      !DISPOSITION.test(head.headers.get('Content-Disposition') || '') ||
      (item.snapshotSize !== null && head.headers.get('Content-Length') !== String(item.snapshotSize))
   )
      throw new DownloadFailure('Attachment download metadata could not be verified. Check access or gateway routing.', 'protocol', false);
   signal.throwIfAborted();
   startReliableTransfer(url);
}

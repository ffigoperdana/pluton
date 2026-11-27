import { DownloadFailure, responseFailure } from './downloadFailure.ts';
import { startReliableTransfer } from './reliableDownload.ts';

/** Why a version cannot be downloaded; `supported` versions can (docs/MINIO_OBJECT_BROWSE.md). */
export const MINIO_STATUSES = [
   'supported',
   'delete-marker',
   'directory',
   'legacy-version',
   'encrypted',
   'transitioned',
   'erasure-multi-drive',
   'unknown-layout',
   'unknown-compression',
   'etag-unverifiable',
   'metadata-invalid',
   'metadata-too-large',
   'legacy-format',
] as const;
export type MinioStatus = (typeof MINIO_STATUSES)[number];

export type MinioBucket = { name: string; objects: number; metadataBytes: number; legacyObjects: number };
export type MinioDataDirectory = {
   path: string;
   format: 'xl-single' | 'xl' | 'fs' | 'unknown';
   drives: number;
   supported: boolean;
   buckets: MinioBucket[];
   bucketsTruncated: boolean;
};
export type MinioDataDirectories =
   | { status: 'indexing'; retryAfterMs: number; entries: number; elapsedMs: number }
   | { status: 'ready'; dataDirs: MinioDataDirectory[] };

export type MinioObjectQuery = {
   dataDir: string;
   bucket: string;
   prefix?: string;
   search?: string;
   versions?: 'latest' | 'all';
   sort?: 'key' | 'size' | 'modified';
   order?: 'asc' | 'desc';
   offset: number;
   limit: number;
   retry?: boolean;
};

export type MinioObjectItem = {
   id: number;
   key: string;
   versionId: string | null;
   latest: boolean;
   deleteMarker: boolean;
   size: number | null;
   modified: string | null;
   etag: string | null;
   contentType: string | null;
   parts: number;
   inline: boolean;
   compressed: boolean;
   versions: number;
   status: MinioStatus;
   reason: string | null;
};

export type MinioProgress = {
   phase: 'snapshot-index' | 'waiting' | 'metadata-restore' | 'parsing';
   metadataFiles: number;
   metadataBytes: number;
   parsed: number;
   indexedEntries: number;
   elapsedMs: number;
};

export type MinioObjectPage =
   | { status: 'indexing'; retryAfterMs: number; progress: MinioProgress }
   | {
        status: 'ready';
        dataDir: string;
        bucket: string;
        prefix: string;
        counts: { objects: number; deleted: number; unsupported: number; versions: number; bytes: number };
        folders: { prefix: string; objects: number }[];
        foldersTruncated: boolean;
        total: number;
        offset: number;
        limit: number;
        nextOffset: number | null;
        items: MinioObjectItem[];
     };

export class MinioObjectError extends Error {
   readonly status: number;
   constructor(message: string, status: number) {
      super(message);
      this.status = status;
   }
}

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max;
const optional = (value: unknown, check: (value: unknown) => boolean) => value === null || check(value);
const snapshotPath = (value: unknown) => text(value, 1025) && (value as string).startsWith('/');
const retryAfter = (value: unknown) => count(value) && (value as number) > 0 && (value as number) <= 60_000;
const BUCKET = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/;

type Untrusted = { [key: string]: unknown };
const record = (value: unknown): Untrusted | undefined =>
   value && typeof value === 'object' && !Array.isArray(value) ? (value as Untrusted) : undefined;
const list = (value: unknown, max: number, valid: (entry: unknown) => boolean) => Array.isArray(value) && value.length <= max && value.every(valid);

function validBucket(entry: unknown): entry is MinioBucket {
   const value = record(entry);
   return (
      !!value &&
      typeof value.name === 'string' &&
      BUCKET.test(value.name) &&
      count(value.objects) &&
      count(value.metadataBytes) &&
      count(value.legacyObjects)
   );
}

function validDataDirectory(entry: unknown): entry is MinioDataDirectory {
   const value = record(entry);
   return (
      !!value &&
      snapshotPath(value.path) &&
      ['xl-single', 'xl', 'fs', 'unknown'].includes(value.format as string) &&
      count(value.drives) &&
      typeof value.supported === 'boolean' &&
      typeof value.bucketsTruncated === 'boolean' &&
      list(value.buckets, 1000, validBucket)
   );
}

/** Validates an untrusted data-folder response; anything unexpected is refused, not shown. */
export function parseMinioDataDirectories(data: unknown): MinioDataDirectories {
   const result = record(record(data)?.result);
   if (result?.status === 'indexing' && retryAfter(result.retryAfterMs) && count(result.entries) && count(result.elapsedMs))
      return result as MinioDataDirectories;
   if (result?.status === 'ready' && list(result.dataDirs, 8, validDataDirectory)) return result as MinioDataDirectories;
   throw new MinioObjectError('The MinIO data folders could not be verified. Retry shortly.', 0);
}

function validItem(entry: unknown): entry is MinioObjectItem {
   const value = record(entry);
   return (
      !!value &&
      count(value.id) &&
      text(value.key, 1024) &&
      optional(value.versionId, (id) => text(id, 64)) &&
      typeof value.latest === 'boolean' &&
      typeof value.deleteMarker === 'boolean' &&
      optional(value.size, count) &&
      optional(value.modified, (time) => text(time, 40)) &&
      optional(value.etag, (etag) => text(etag, 128)) &&
      optional(value.contentType, (type) => text(type, 255)) &&
      count(value.parts) &&
      typeof value.inline === 'boolean' &&
      typeof value.compressed === 'boolean' &&
      count(value.versions) &&
      MINIO_STATUSES.includes(value.status as MinioStatus) &&
      optional(value.reason, (reason) => text(reason, 500))
   );
}

const PHASES = ['snapshot-index', 'waiting', 'metadata-restore', 'parsing'];

/** Validates an untrusted object page against the request it answers. */
export function parseMinioObjectPage(data: unknown, query: MinioObjectQuery): MinioObjectPage {
   const page = record(record(data)?.result);
   const progress = record(page?.progress);
   if (
      page?.status === 'indexing' &&
      retryAfter(page.retryAfterMs) &&
      PHASES.includes(progress?.phase as string) &&
      ['metadataFiles', 'metadataBytes', 'parsed', 'indexedEntries', 'elapsedMs'].every((key) => count(progress?.[key]))
   )
      return page as MinioObjectPage;
   const prefix = query.prefix || '';
   const counts = record(page?.counts);
   const folder = (entry: unknown) => {
      const value = record(entry);
      return (
         !!value &&
         text(value.prefix, 1024) &&
         (value.prefix as string).startsWith(prefix) &&
         (value.prefix as string).endsWith('/') &&
         count(value.objects)
      );
   };
   if (
      page?.status === 'ready' &&
      page.dataDir === query.dataDir &&
      page.bucket === query.bucket &&
      page.prefix === prefix &&
      ['objects', 'deleted', 'unsupported', 'versions', 'bytes'].every((key) => count(counts?.[key])) &&
      list(page.folders, 1000, folder) &&
      typeof page.foldersTruncated === 'boolean' &&
      count(page.total) &&
      page.offset === query.offset &&
      page.limit === query.limit &&
      (page.nextOffset === null || (count(page.nextOffset) && (page.nextOffset as number) > query.offset)) &&
      list(page.items, query.limit, (item) => validItem(item) && item.key.startsWith(prefix))
   )
      return page as MinioObjectPage;
   throw new MinioObjectError('The MinIO object list could not be verified. Retry shortly.', 0);
}

const sourceParams = (query: Pick<MinioObjectQuery, 'dataDir' | 'bucket'>) => new URLSearchParams({ dataDir: query.dataDir, bucket: query.bucket });

export function minioDataDirectoriesUrl(api: string, backupId: string, retry = false) {
   return `${api}/backups/${encodeURIComponent(backupId)}/minio${retry ? '?retry=true' : ''}`;
}

export function minioObjectsUrl(api: string, backupId: string, query: MinioObjectQuery) {
   const params = sourceParams(query);
   params.set('offset', String(query.offset));
   params.set('limit', String(query.limit));
   if (query.prefix) params.set('prefix', query.prefix);
   if (query.search) params.set('search', query.search);
   if (query.versions === 'all') params.set('versions', 'all');
   if (query.sort) params.set('sort', query.sort);
   if (query.order) params.set('order', query.order);
   if (query.retry) params.set('retry', 'true');
   return `${api}/backups/${encodeURIComponent(backupId)}/minio/objects?${params}`;
}

export function minioObjectDownloadUrl(
   api: string,
   backupId: string,
   query: Pick<MinioObjectQuery, 'dataDir' | 'bucket'>,
   item: Pick<MinioObjectItem, 'id'>,
) {
   return `${api}/backups/${encodeURIComponent(backupId)}/minio/objects/${item.id}/download?${sourceParams(query)}`;
}

async function request<T>(url: string, parse: (data: unknown) => T, fallback: string, signal?: AbortSignal): Promise<T> {
   const response = await fetch(url, { credentials: 'include', cache: 'no-store', signal });
   const data: unknown = await response.json().catch(() => undefined);
   if (!response.ok) {
      const error = record(data)?.error;
      const message = typeof error === 'string' && error.length <= 500 ? error : fallback;
      throw new MinioObjectError(message, response.status);
   }
   return parse(data);
}

export function fetchMinioDataDirectories(api: string, backupId: string, retry = false, signal?: AbortSignal) {
   return request(minioDataDirectoriesUrl(api, backupId, retry), parseMinioDataDirectories, 'The MinIO data folders are unavailable.', signal);
}

export function fetchMinioObjects(api: string, backupId: string, query: MinioObjectQuery, signal?: AbortSignal) {
   return request(
      minioObjectsUrl(api, backupId, query),
      (data) => parseMinioObjectPage(data, query),
      'The MinIO object list is unavailable.',
      signal,
   );
}

const DISPOSITION = /^attachment; filename="[A-Za-z0-9._ -]{1,200}"(?:; filename\*=UTF-8''[A-Za-z0-9%._~-]{1,2000})?$/;

/** Checks the download metadata first, then lets the browser stream the verified object. */
export async function downloadMinioObject(
   api: string,
   backupId: string,
   query: Pick<MinioObjectQuery, 'dataDir' | 'bucket'>,
   item: MinioObjectItem,
   signal: AbortSignal,
) {
   if (item.status !== 'supported' || item.size === null)
      throw new DownloadFailure(item.reason || 'This object cannot be downloaded.', 'policy', false);
   const url = minioObjectDownloadUrl(api, backupId, query, item);
   const head = await fetch(url, { method: 'HEAD', credentials: 'include', redirect: 'manual', cache: 'no-store', signal });
   if (head.type === 'opaqueredirect' || head.redirected || head.status !== 200) {
      if (head.status === 409) throw new DownloadFailure('The object list has expired. Open the bucket again and retry.', 'policy', false, 409);
      throw responseFailure(head);
   }
   if (
      head.headers.get('Content-Type') !== 'application/octet-stream' ||
      !DISPOSITION.test(head.headers.get('Content-Disposition') || '') ||
      head.headers.get('Content-Length') !== String(item.size)
   )
      throw new DownloadFailure('Object download metadata could not be verified. Check access or gateway routing.', 'protocol', false);
   signal.throwIfAborted();
   startReliableTransfer(url);
}

/** Path segments of a prefix for a breadcrumb: [['docs/', 'docs'], ['docs/2026/', '2026']]. */
export function prefixCrumbs(prefix: string): [string, string][] {
   const parts = prefix.split('/').filter(Boolean);
   return parts.map((part, index) => [`${parts.slice(0, index + 1).join('/')}/`, part]);
}

/** The name of a key or folder below the current prefix. */
export function nameBelow(prefix: string, key: string) {
   return key.startsWith(prefix) ? key.slice(prefix.length) || key : key;
}

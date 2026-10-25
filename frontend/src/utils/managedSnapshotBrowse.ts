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
export async function fetchManagedSnapshotPage(
   api: string,
   backupId: string,
   query: ManagedSnapshotQuery,
   signal?: AbortSignal,
): Promise<ManagedSnapshotPage> {
   const response = await fetch(managedSnapshotPageUrl(api, backupId, query), { credentials: 'include', signal });
   const data = await response.json();
   if (!response.ok || !data.success)
      throw new ManagedSnapshotPageError(data.error || 'Snapshot metadata is unavailable. Retry indexing.', data.reason, response.status);
   return data.result;
}
export class ManagedSnapshotPageError extends Error {
   readonly reason?: string;
   readonly status?: number;
   constructor(message: string, reason?: string, status?: number) {
      super(message);
      this.reason = reason;
      this.status = status;
   }
}
export function snapshotParent(directory: string) {
   return directory.slice(0, directory.lastIndexOf('/'));
}

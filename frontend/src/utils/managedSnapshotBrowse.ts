import type { FileItem } from '../@types/system';

export type ManagedSnapshotQuery = {
   path: string;
   search: string;
   offset: number;
   limit: number;
   sort: 'name' | 'size' | 'modifiedAt';
   order: 'asc' | 'desc';
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
   if (!response.ok || !data.success) throw new Error(data.error || 'Snapshot metadata is unavailable. Retry indexing.');
   return data.result;
}
export function snapshotParent(directory: string) {
   return directory.slice(0, directory.lastIndexOf('/'));
}

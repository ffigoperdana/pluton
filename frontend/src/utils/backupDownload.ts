type BackupRow = { status: string; active?: boolean; inProgress?: boolean; success?: boolean };

/** Keep the existing menu; remote recovery adds Download. Remote Remove only clears a failed run's history row. */
export function backupRowActions(backup: BackupRow, isSync: boolean, isRemoteManaged: boolean) {
   const completed = backup.status === 'completed' && !!backup.active;
   return {
      download: !isSync && completed && (!isRemoteManaged || (!backup.inProgress && backup.success !== false)),
      browse: !isSync && completed,
      restore: completed,
      remove: !isRemoteManaged || (backup.status === 'failed' && !backup.inProgress),
   };
}

/** Mirrors the server bound (MANAGED_FULL_DOWNLOAD_MAX_BYTES) for whole managed snapshots. */
export const MAX_FULL_SNAPSHOT_DOWNLOAD_BYTES = 200 * 1024 ** 3;

/** Why a whole managed snapshot cannot be downloaded as one archive, or undefined when it can. */
export function fullDownloadBlockedReason(isRemoteManaged: boolean, logicalBytes: number | null | undefined) {
   if (!isRemoteManaged || typeof logicalBytes !== 'number' || logicalBytes <= MAX_FULL_SNAPSHOT_DOWNLOAD_BYTES) return undefined;
   return `This snapshot holds ${(logicalBytes / 1024 ** 3).toFixed(1)} GiB, more than the 200 GiB that can be downloaded as one archive. Download folders or files from Browse instead.`;
}

/** Browser-owned transfer avoids fetch().blob() buffering the complete archive. */
export function startNativeBackupDownload(apiUrl: string, backupId: string, preparationId?: string, mode: 'full' | 'regular-files' = 'full') {
   const link = document.createElement('a');
   const query = new URLSearchParams();
   if (preparationId) query.set('preparationId', preparationId);
   if (mode === 'regular-files') query.set('exportMode', mode);
   link.href = `${apiUrl}/backups/${encodeURIComponent(backupId)}/action/download${query.size ? `?${query}` : ''}`;
   link.download = '';
   document.body.appendChild(link);
   try {
      link.click();
   } finally {
      link.remove();
   }
}

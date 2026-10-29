type BackupRow = { status: string; active?: boolean; inProgress?: boolean; success?: boolean };

/** Keep the existing menu; remote recovery adds Download, never Remove. */
export function backupRowActions(backup: BackupRow, isSync: boolean, isRemoteManaged: boolean) {
   const completed = backup.status === 'completed' && !!backup.active;
   return {
      download: !isSync && completed && (!isRemoteManaged || (!backup.inProgress && backup.success !== false)),
      browse: !isSync && completed,
      restore: completed,
      remove: !isRemoteManaged,
   };
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

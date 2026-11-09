import { DownloadFailure, responseFailure } from './downloadFailure.ts';
import { startReliableTransfer } from './reliableDownload.ts';
export async function downloadSnapshotItem(api: string, backupId: string, path: string, directory: boolean, size: number, signal: AbortSignal) {
   const url = api + '/backups/' + encodeURIComponent(backupId) + '/files/download?' + new URLSearchParams({ path });
   const head = await fetch(url, { method: 'HEAD', credentials: 'include', redirect: 'manual', cache: 'no-store', signal });
   if (head.type === 'opaqueredirect' || head.redirected || head.status !== 200) throw responseFailure(head);
   if (
      head.headers.get('Content-Type') !== (directory ? 'application/x-tar' : 'application/octet-stream') ||
      !/^attachment; filename="[a-zA-Z0-9._-]+"$/.test(head.headers.get('Content-Disposition') || '') ||
      (!directory && head.headers.get('Content-Length') !== String(size))
   )
      throw new DownloadFailure('Snapshot download metadata could not be verified. Check access or gateway routing.', 'protocol', false);
   signal.throwIfAborted();
   startReliableTransfer(url);
}

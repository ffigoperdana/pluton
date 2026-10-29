import { useEffect, useRef, useState } from 'react';
import { API_URL } from '../../../utils/constants';
import type { DownloadMode } from '../../../utils/downloadPreparation';
import { reliableRequest, reliableAuthorization, reliableActive, reliableFailure, type ReliableJob } from '../../../utils/reliableDownload';
import classes from '../../common/ActionModal/ActionModal.module.scss';

const labels: Record<ReliableJob['state'], string> = {
   queued: 'Queued',
   validating: 'Indexing and validating the exact snapshot archive',
   exporting: 'Starting export',
   uploading: 'Uploading verified archive stream',
   verifying: 'Verifying complete temporary object',
   ready: 'Verified export ready',
   failed: 'Export failed',
   cancelled: 'Export cancelled',
   expired: 'Export expired',
};
const bytes = (n: number) => (n / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' MiB';
export default function ReliableDownload({ backupId, mode, close }: { backupId: string; mode: DownloadMode; close: () => void }) {
   const [job, setJob] = useState<ReliableJob>(),
      [error, setError] = useState(''),
      [retry, setRetry] = useState(0),
      [busy, setBusy] = useState(false),
      [authorization, setAuthorization] = useState<{ url: string; expiresAt: number; transport?: string }>();
   const current = useRef(job),
      controller = useRef<AbortController>();
   current.current = job;
   useEffect(() => {
      const stop = new AbortController();
      controller.current = stop;
      let timer: ReturnType<typeof setTimeout>;
      let id =
         current.current?.mode === mode &&
         current.current.state !== 'failed' &&
         current.current.state !== 'expired' &&
         current.current.state !== 'cancelled'
            ? current.current.id
            : undefined;
      setJob(undefined);
      setAuthorization(undefined);
      setError('');
      const poll = async () => {
         setBusy(true);
         try {
            const next = await reliableRequest(API_URL, backupId, mode, id, false, stop.signal);
            if (stop.signal.aborted) return;
            id = next.id;
            setJob(next);
            setError('');
            if (reliableActive(next) || next.state === 'ready') timer = setTimeout(poll, next.state === 'ready' ? 5000 : 2000);
         } catch (e) {
            if (!stop.signal.aborted) setError(e instanceof Error ? e.message : 'Export status unavailable.');
         } finally {
            if (!stop.signal.aborted) setBusy(false);
         }
      };
      void poll();
      return () => {
         stop.abort();
         clearTimeout(timer);
      };
   }, [backupId, mode, retry]);
   const visible = job?.mode === mode ? job : undefined;
   const cancel = async () => {
      if (!visible) return;
      controller.current?.abort();
      setBusy(true);
      setAuthorization(undefined);
      try {
         setJob(await reliableRequest(API_URL, backupId, mode, visible.id, true));
         setError('');
      } catch (e) {
         setError(e instanceof Error ? e.message : 'Cancellation was not confirmed.');
      } finally {
         setBusy(false);
      }
   };
   const authorize = async () => {
      if (!visible?.summary) return;
      setBusy(true);
      try {
         setAuthorization(await reliableAuthorization(API_URL, backupId, visible.id, visible.summary.archiveSha256, visible.summary.archiveBytes));
         setError('');
      } catch (e) {
         setError(e instanceof Error ? e.message : 'Authorization was not confirmed.');
      } finally {
         setBusy(false);
      }
   };
   const prefix = visible ? `${API_URL}/backups/${encodeURIComponent(backupId)}/exports/${encodeURIComponent(visible.id)}` : '';
   return (
      <div>
         <p>Creates a private temporary archive independently of backup replication. Closing this panel leaves the export running.</p>
         <div role="status" aria-live="polite">
            <p>{visible ? labels[visible.state] : 'Requesting reliable export…'}</p>
            {visible && (
               <p>
                  Processed: {bytes(visible.processedBytes)} · Uploaded: {bytes(visible.uploadedBytes)}
                  {visible.totalBytes ? ` / ${bytes(visible.totalBytes)} (${Math.floor((visible.uploadedBytes * 100) / visible.totalBytes)}%)` : ''}
                  <br />
                  Elapsed: {Math.floor(visible.elapsedMs / 1000)}s · Average upload: {bytes(visible.averageBytesPerSecond)}/s
               </p>
            )}
         </div>
         {visible?.failure && <p role="alert">{reliableFailure(visible.failure)}</p>}
         {visible?.cleanupPending && <p>Cleanup is pending. Its storage reservation remains counted until deletion is verified.</p>}
         {error && (
            <p role="alert" className={classes.error}>
               {error}
            </p>
         )}
         {visible?.state === 'ready' && visible.summary && !error && (
            <div>
               <p>
                  Integrity: complete object size and SHA-256 verified. Included: {visible.summary.includedEntries.toLocaleString()} · Excluded:{' '}
                  {visible.summary.excludedEntries.toLocaleString()}.
               </p>
               <p>Expires: {new Date(visible.expiresAt!).toLocaleString()}</p>
               <p>
                  SHA-256: <code style={{ overflowWrap: 'anywhere' }}>{visible.summary.archiveSha256}</code>
               </p>
               <a href={`${prefix}/link`} referrerPolicy="no-referrer">
                  {visible.transport === 'authenticated-proxy' ? 'Download verified TAR through Pluton' : 'Download TAR from temporary storage'}
               </a>
               <p>
                  <a href={`${prefix}/content`} download>
                     Download through Pluton
                  </a>
               </p>
               <p>
                  Your browser reports client transfer progress. Browser Resume depends on the browser and authorization expiry; it is not guaranteed.
                  A resume link can be renewed for the same immutable object until export expiry.
               </p>
               {visible.transport === 'authenticated-proxy' && <p>Resuming requires an authenticated Pluton session. The server checks object identity on every Range request. Verify the final file size and SHA-256 after download.</p>}
               <button type="button" disabled={busy} onClick={() => void authorize()}>
                  Get or renew resume link
               </button>
               {authorization && (
                  <div>
                     <p>
                        {authorization.transport === 'authenticated-proxy' ? 'This link requires your authenticated Pluton session; it is not a public storage link.' : `Private bearer link expires: ${new Date(authorization.expiresAt).toLocaleString()}. Keep it out of logs and shared messages.`}
                     </p>
                     <input aria-label="Private resume link" readOnly value={authorization.url} onFocus={(event) => event.currentTarget.select()} />
                     <p>
                        Use a resume-capable client with this link, then compare the completed archive SHA-256 above. A renewed link identifies the
                        same object.
                     </p>
                  </div>
               )}
            </div>
         )}
         <div className={classes.actions}>
            <button type="button" onClick={close}>
               Close
            </button>
            {visible && (reliableActive(visible) || visible.state === 'ready' || visible.cleanupPending) && (
               <button type="button" disabled={busy} onClick={() => void cancel()}>
                  Cancel export and delete temporary data
               </button>
            )}
            {(error || !visible || ['failed', 'expired', 'cancelled'].includes(visible.state)) && (
               <button type="button" disabled={busy} onClick={() => setRetry((n) => n + 1)}>
                  Retry reliable export
               </button>
            )}
         </div>
      </div>
   );
}

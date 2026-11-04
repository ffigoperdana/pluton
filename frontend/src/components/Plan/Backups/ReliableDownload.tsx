import { useCallback, useEffect, useState } from 'react';
import { API_URL } from '../../../utils/constants';
import type { DownloadMode } from '../../../utils/downloadPreparation';
import { reliableRequest, reliableAuthorization, reliableActive, reliableFailure, type ReliableJob } from '../../../utils/reliableDownload';
import { downloadBytes, downloadDuration, downloadStep, uploadPercent } from '../../../utils/downloadProgress';
import { useDownloadJob } from '../../../hooks/useDownloadJob';
import ActionModal from '../../common/ActionModal/ActionModal';
import classes from '../../common/ActionModal/ActionModal.module.scss';
import styles from './DownloadPreparation.module.scss';

const interval = (job: ReliableJob) => (job.cleanupPending || job.state === 'ready' ? 5000 : reliableActive(job) ? 2000 : false);
const steps = [
   'Validating / indexing snapshot',
   'Preparing archive',
   'Encrypting / uploading to temporary storage',
   'Integrity verification',
   'Ready to download',
];
export default function ReliableDownload({backupId,
   mode,
   close,
   initialId,
   onStatus,}: {
   backupId: string;
   mode: DownloadMode;
   close: () => void;
   initialId?: string;
   onStatus?: (id: string | undefined, locked: boolean) => void;
}) {
   const request = useCallback(
      (id: string | undefined, cancel: boolean, signal: AbortSignal) => reliableRequest(API_URL, backupId, mode, id, cancel, signal),
      [backupId, mode],
   );
   const { job, error, actionError, busy, observedAt, refresh, cancel, restart, perform } = useDownloadJob(request, interval, true, initialId);
   const [confirm, setConfirm] = useState(false);
   const [clock, setClock] = useState(() => Date.now());
   const [authorization, setAuthorization] = useState<{ url: string; expiresAt: number; transport?: string }>();
   const active = !!job && reliableActive(job);
   const jobId = job?.id;
   const optionsLocked = busy || (!job && !error) || active || !!job?.cleanupPending;
   useEffect(() => {
      onStatus?.(jobId, optionsLocked);
   }, [onStatus, jobId, optionsLocked]);
   useEffect(() => {
      if (!active) return;
      const timer = setInterval(() => setClock(Date.now()), 1000);
      return () => clearInterval(timer);
   }, [active]);
   const percent = uploadPercent(job);
   const step = downloadStep(job);
   const elapsed = (job?.elapsedMs || 0) + (active ? Math.max(0, clock - observedAt) : 0);
   const stalled = job?.state === 'uploading' && step === 2 && !error && (job.performance?.lastProgressAgeMs || 0) >= 30000;
   const status = job?.cleanupPending
      ? 'Cleanup pending'
      : error
        ? 'Waiting for connection — reconnecting'
        : stalled
          ? 'Upload stalled — no recent progress reported'
          : job?.state === 'failed'
            ? 'Export failed'
            : job?.state === 'cancelled'
              ? 'Export cancelled'
              : job?.state === 'expired'
                ? 'Export expired'
                : job?.state === 'ready'
                  ? 'Completed — integrity verified'
                  : step === 3
                    ? 'Verifying complete archive'
                    : job?.state === 'queued'
                      ? 'Queued — waiting for server'
                      : job
                        ? 'Working normally'
                        : 'Requesting reliable export…';
   const prefix = job ? API_URL + '/backups/' + encodeURIComponent(backupId) + '/exports/' + encodeURIComponent(job.id) : '';
   const authorize = async () => {
      if (!job?.summary) return;
      const value = await perform((signal) =>
         reliableAuthorization(API_URL, backupId, job.id, job.summary!.archiveSha256, job.summary!.archiveBytes, signal),
      );
      if (value) setAuthorization(value);
   };
   return (
      <section aria-label="Reliable Download progress" className={styles.progressPanel}>
         <p>
            {job?.confidentiality === 'provider-sse-s3'
               ? 'Reliable Download prepares a private temporary archive with storage encryption. The file becomes available after upload and integrity verification.'
               : 'Reliable Download prepares an encrypted temporary archive in HCP. This may take additional time. The file becomes available after upload and integrity verification.'}
         </p>
         <ol className={styles.steps} aria-label="Export stages">
            {steps.map((label, index) => (
               <li key={label} aria-current={step === index ? 'step' : undefined} data-complete={index < step}>
                  {index === 2 && job?.confidentiality === 'provider-sse-s3' ? 'Uploading to encrypted temporary storage' : label}
               </li>
            ))}
         </ol>
         <p role="status" aria-live="polite" className={styles.connection}>
            {status}
         </p>
         <div className={styles.progressDetails}>
            <progress aria-label="Archive uploaded; integrity verification follows" max={100} value={percent} />
            <p>
               {percent === undefined ? 'Preparing — total archive size is not yet available.' : 'Upload: ' + percent + '%'}
               {job?.state === 'verifying' && ' — upload received; final verification is still running.'}
            </p>
            <p>
               Processed: {downloadBytes(job?.processedBytes || 0)} · Uploaded: {downloadBytes(job?.uploadedBytes || 0)}
               {job?.totalBytes ? ' / ' + downloadBytes(job.totalBytes) : ''}
            </p>
            <p>
               Elapsed: {downloadDuration(elapsed)} · Average upload:{' '}
               {job?.averageBytesPerSecond ? downloadBytes(job.averageBytesPerSecond) + '/s' : 'Waiting for data'}
            </p>
            <p>
               {job?.performance?.indexedEntries !== undefined
                  ? 'Indexed entries: ' + job.performance.indexedEntries.toLocaleString()
                  : 'Indexing and validation use an indeterminate indicator.'}
            </p>
         </div>
         {active && (
            <p>
               Your export is running on the server. You may close this window and return later. Do not select Cancel unless you want to stop and
               clean up this export.
            </p>
         )}
         {job?.failure && <p role="alert">{reliableFailure(job.failure)}</p>}
         {job?.cleanupPending && (
            <p>Cleanup is pending. Its storage reservation remains counted until deletion is verified. Status checks continue automatically.</p>
         )}
         {job?.confidentiality === 'application-encrypted' && (
            <p>Temporary storage holds an encrypted archive. Downloading through Pluton returns the original TAR.</p>
         )}
         <div className={styles.connection}>
            {actionError && !confirm && <p role="alert">{actionError}</p>}
            {error && (
               <>
                  <span>{error} Last confirmed progress is retained.</span>{' '}
                  <button type="button" disabled={busy} onClick={refresh}>
                     Reconnect now
                  </button>
               </>
            )}
         </div>
         {job?.state === 'ready' && job.summary && (
            <div className={styles.ready}>
               <a className={styles.primaryDownload} href={prefix + '/link'} referrerPolicy="no-referrer">
                  Download Verified TAR
               </a>
               <p>Size: {downloadBytes(job.summary.archiveBytes)} · Integrity: complete object size and SHA-256 verified.</p>
               <p>
                  Included: {job.summary.includedEntries.toLocaleString()} · Excluded: {job.summary.excludedEntries.toLocaleString()}.
               </p>
               <p>Expires: {new Date(job.expiresAt!).toLocaleString()}</p>
               <p>
                  SHA-256: <code style={{ overflowWrap: 'anywhere' }}>{job.summary.archiveSha256}</code>
               </p>
               <p>
                  Your browser reports transfer progress. Browser Resume depends on browser support and authorization expiry. Renewing a resume link
                  identifies the same immutable object until export expiry.
               </p>
               {job.transport === 'authenticated-proxy' && (
                  <p>
                     Resuming requires an authenticated Pluton session. The server checks object identity on every Range request. Verify the final
                     file size and SHA-256 after download.
                  </p>
               )}
               <button type="button" disabled={busy} onClick={() => void authorize()}>
                  Get or renew resume link
               </button>
               {authorization && (
                  <div>
                     <p>
                        {authorization.transport === 'authenticated-proxy'
                           ? 'This link requires your authenticated Pluton session.'
                           : 'Private bearer link expires: ' +
                             new Date(authorization.expiresAt).toLocaleString() +
                             '. Keep it out of logs and shared messages.'}
                     </p>
                     <input aria-label="Private resume link" readOnly value={authorization.url} onFocus={(event) => event.currentTarget.select()} />
                     <p>Use a resume-capable client, then compare the completed archive SHA-256 above.</p>
                  </div>
               )}
            </div>
         )}
         <div className={classes.actions}>
            <button type="button" onClick={close}>
               Close
            </button>
            {job && (active || job.state === 'ready' || job.cleanupPending) && (
               <button type="button" className={classes.dangerBtn} disabled={busy} onClick={() => setConfirm(true)}>
                  {job.cleanupPending ? 'Retry cleanup…' : 'Cancel export…'}
               </button>
            )}
            {job && !active && !job.cleanupPending && job.state !== 'ready' && (
               <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                     setAuthorization(undefined);
                     restart();
                  }}
               >
                  Prepare new export
               </button>
            )}
         </div>
         {confirm && (
            <ActionModal
               title={job?.cleanupPending ? 'Retry temporary export cleanup?' : 'Cancel this export?'}
               closeModal={() => setConfirm(false)}
               errorMessage={actionError}
               message="This stops this export and requests deletion of its temporary data. Cleanup may remain pending until ownership and deletion are verified. Existing backups remain unchanged."
               primaryAction={{type: 'danger',
                  title: 'Confirm cancellation and cleanup',
                  isPending: busy,
                  action: async () => {
                     setAuthorization(undefined);
                     if (await cancel()) setConfirm(false);
                  },}}
               secondaryAction={{ title: 'Keep export', action: () => setConfirm(false) }}
            />
         )}
      </section>
   );
}

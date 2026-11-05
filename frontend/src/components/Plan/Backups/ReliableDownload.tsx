import { useEffect, useRef, useState } from 'react';
import { API_URL } from '../../../utils/constants';
import type { DownloadMode } from '../../../utils/downloadPreparation';
import { reliableAuthorization, reliableActive, reliableFailure } from '../../../utils/reliableDownload';
import { downloadBytes, downloadDuration, downloadStep, uploadPercent } from '../../../utils/downloadProgress';
import { useExportActivity } from '../../../hooks/useExportActivity';
import { activityKey, readinessMessages } from '../../../utils/exportActivity';
import { downloadFailure } from '../../../utils/downloadFailure';
import ActionModal from '../../common/ActionModal/ActionModal';
import classes from '../../common/ActionModal/ActionModal.module.scss';
import styles from './DownloadPreparation.module.scss';

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
   const activity = useExportActivity();
   const { manager, readiness, loaded } = activity;
   const key = activityKey(backupId, mode);
   const [selectedId, setSelectedId] = useState(initialId);
   const job = manager.find(backupId, mode, selectedId);
   const error = activity.error;
   const [authorizationError, setAuthorizationError] = useState('');
   const actionError = activity.denials[key]?.message || authorizationError;
   const [authorizing, setAuthorizing] = useState(false);
   const authorizationController = useRef<AbortController>();
   useEffect(
      () => () => {
         authorizationController.current?.abort();
      },
      [],
   );
   const busy = activity.pending.includes(key) || authorizing;
   const refresh = () => {
      void manager.refresh();
   };
   const restart = async () => {
      await manager.admit(backupId, mode);
      const admitted = manager.find(backupId, mode);
      if (admitted && (reliableActive(admitted) || admitted.state === 'ready')) setSelectedId(admitted.id);
   };
   const cancel = async () => {
      if (!job) return false;
      await manager.cancel(backupId, mode, job.id);
      return !manager.snapshot().denials[key];
   };
   const [confirm, setConfirm] = useState(false);
   const [clock, setClock] = useState(() => Date.now());
   const [authorization, setAuthorization] = useState<{ url: string; expiresAt: number; transport?: string }>();
   const active = !!job && reliableActive(job);
   const jobId = job?.id;
   const optionsLocked = busy || (!loaded && !error) || active || !!job?.cleanupPending;
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
   const elapsed = (job?.elapsedMs || 0) + (active ? Math.max(0, clock - activity.observedAt) : 0);
   const waitingForStorage = job?.state === 'uploading' && step === 2 && !error && (job.performance?.lastProgressAgeMs || 0) >= 30000;
   const status = job?.cleanupPending
      ? 'Cleanup pending'
      : error
        ? error.transient
           ? 'Waiting for connection — reconnecting'
           : 'Status check needs attention'
        : waitingForStorage
          ? 'Waiting for storage response — no recent progress reported'
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
      if (!job?.summary || authorizationController.current) return;
      const stop = new AbortController();
      authorizationController.current = stop;
      setAuthorizing(true);
      setAuthorizationError('');
      try {
         const value = await reliableAuthorization(API_URL, backupId, job.id, job.summary.archiveSha256, job.summary.archiveBytes, stop.signal);
         if (!stop.signal.aborted) setAuthorization(value);
      } catch (failure) {
         if (!stop.signal.aborted) setAuthorizationError(downloadFailure(failure).message);
      } finally {
         if (!stop.signal.aborted) {
            authorizationController.current = undefined;
            setAuthorizing(false);
         }
      }
   };
   if (!job)
      return (
         <section aria-label="Reliable Download readiness">
            <p>
               Reliable Download prepares an encrypted temporary archive in HCP. The file becomes available after upload and integrity verification.
            </p>
            <p role="status">
               {!loaded && !error
                  ? 'Checking admitted exports and readiness…'
                  : 'No admitted export is selected. No export is running in this panel.'}
            </p>
            {readiness && (
               <>
                  <p>
                     Static configuration: {readiness.configured ? 'configured' : 'not verified'} · Capability preflight: {readiness.preflight}
                  </p>
                  <p>{readinessMessages[readiness.reason]}</p>
                  {readiness.cleanupPending && (
                     <p>Historical preflight cleanup remains pending. Use the ownership-safe diagnostic procedure before another probe.</p>
                  )}
                  <p>
                     Operator recovery: review read-only readiness and recorded preflight diagnostics first. Inventory and disposable capability
                     preflight require an explicit operator action. Opening or refreshing this panel runs neither.
                  </p>
                  {readiness.latest && (
                     <div>
                        <p>
                           Recorded preflight: <code>{readiness.latest.id}</code> · {readiness.latest.state}
                        </p>
                        {(['preflightFailure', 'cleanupFailure'] as const).map((key) => {
                           const detail = readiness.latest?.[key];
                           return (
                              detail && (
                                 <p key={key}>
                                    {key === 'preflightFailure' ? 'Preflight failure' : 'Cleanup failure'}: {detail.operation} · {detail.category} ·{' '}
                                    {detail.providerCategory} · HTTP {detail.httpStatus ?? 'unavailable'}
                                 </p>
                              )
                           );
                        })}
                     </div>
                  )}
               </>
            )}
            {(error || actionError) && <p role="alert">{actionError || error?.message}</p>}
            <div className={classes.actions}>
               <button type="button" onClick={close}>
                  Close
               </button>
               <button type="button" disabled={busy || activity.checking} onClick={refresh}>
                  Check readiness and existing jobs
               </button>
               {loaded && readiness?.admissionAllowed && !error && (
                  <button type="button" disabled={busy} onClick={restart}>
                     Prepare Reliable Download
                  </button>
               )}
            </div>
         </section>
      );
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
         {job?.verificationFailure && (
            <div role="note">
               <p>
                  Export verification failed: {job.verificationFailure.phase} · {job.verificationFailure.operation} ·{' '}
                  {job.verificationFailure.outcome}.
               </p>
               <p>
                  Category: {job.verificationFailure.providerCategory} · Code: {job.verificationFailure.providerCode || 'unavailable'} · HTTP{' '}
                  {job.verificationFailure.httpStatus ?? 'unavailable'} · Attempts: {job.verificationFailure.attempts ?? 'unavailable'}.
               </p>
               <p>
                  Response: {job.verificationFailure.responseKind} · Verification time: {downloadDuration(job.verificationFailure.elapsedMs || 0)} ·
                  Read back: {downloadBytes(job.verificationFailure.plaintextBytesRead || 0)}.
               </p>
            </div>
         )}
         {(job?.cleanupFailure || job?.lastCleanupFailure) && (
            <details>
               <summary>Historical cleanup diagnostics</summary>
               <p>
                  {job.cleanupPending
                     ? 'Cleanup is currently pending.'
                     : 'Cleanup is not currently pending. Recorded failures below describe earlier attempts.'}
               </p>
               {(['cleanupFailure', 'lastCleanupFailure'] as const).map((key) => {
                  const d = job[key];
                  return (
                     d && (
                        <p key={key}>
                           {key === 'cleanupFailure' ? 'First recorded failure' : 'Last recorded failure'}: {d.operation} · {d.providerCategory} ·
                           HTTP {d.httpStatus ?? 'unavailable'}.
                        </p>
                     )
                  );
               })}
            </details>
         )}
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
                  <span>{error.message} Last confirmed progress is retained.</span>{' '}
                  <button type="button" disabled={busy} onClick={refresh}>
                     {error.transient ? 'Reconnect now' : 'Check access again'}
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
                  disabled={busy || !readiness?.admissionAllowed || !!error}
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

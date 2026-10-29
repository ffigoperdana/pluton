import { useEffect, useRef, useState } from 'react';
import Modal from '../../common/Modal/Modal';
import classes from '../../common/ActionModal/ActionModal.module.scss';
import styles from './DownloadPreparation.module.scss';
import { API_URL } from '../../../utils/constants';
import { startNativeBackupDownload } from '../../../utils/backupDownload';
import { preparationActive, preparationRequest, type DownloadPreparation as Job, type DownloadMode } from '../../../utils/downloadPreparation';
import ReliableDownload from './ReliableDownload';

const labels: Record<Job['state'], string> = {
   queued: 'Queued',
   indexing: 'Indexing snapshot metadata',
   validating: 'Validating snapshot and repository',
   ready: 'Ready to download',
   failed: 'Preparation failed',
   cancelled: 'Preparation cancelled',
   expired: 'Preparation expired',
};
const entryLabels: Record<string, string> = {
   file: 'Regular files',
   dir: 'Directories',
   symlink: 'Symbolic links',
   dev: 'Block devices',
   chardev: 'Character devices',
   fifo: 'FIFOs',
   socket: 'Sockets',
};
export default function DownloadPreparation({ backupId, close }: { backupId: string; close: () => void }) {
   const [job, setJob] = useState<Job>();
   const [mode, setMode] = useState<DownloadMode>('full');
   const [delivery, setDelivery] = useState<'standard' | 'reliable'>('standard');
   const [error, setError] = useState('');
   const [retryAt, setRetryAt] = useState(0);
   const [retry, setRetry] = useState(0);
   const [busy, setBusy] = useState(false);
   const [clock, setClock] = useState(Date.now());
   const [observedAt, setObservedAt] = useState(Date.now());
   const [started, setStarted] = useState(false);
   const jobRef = useRef(job);
   jobRef.current = job;
   useEffect(() => {
      const timer = setInterval(() => setClock(Date.now()), 1000);
      return () => clearInterval(timer);
   }, []);
   useEffect(() => {
      if (delivery !== 'standard') return;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      let currentId = (jobRef.current?.exportMode || 'full') === mode ? jobRef.current?.id : undefined;
      const poll = async () => {
         setBusy(true);
         try {
            const next = await preparationRequest(API_URL, backupId, currentId, false, controller.signal, mode);
            if (controller.signal.aborted) return;
            currentId = next.id;
            setJob(next);
            setObservedAt(Date.now());
            setError('');
            setRetryAt(0);
            if (preparationActive(next) || next.state === 'ready')
               timer = setTimeout(poll, next.state === 'ready' ? 5000 : Math.max(1000, next.retryAfterMs));
         } catch (failure) {
            if (!controller.signal.aborted) {
               setError(failure instanceof Error ? failure.message : 'Preparation status unavailable.');
               setRetryAt((failure as { retryAt?: number }).retryAt || 0);
            }
         } finally {
            if (!controller.signal.aborted) setBusy(false);
         }
      };
      void poll();
      return () => {
         controller.abort();
         clearTimeout(timer);
      };
   }, [backupId, retry, mode, delivery]);
   const cancel = async () => {
      if (!job || busy) return;
      setBusy(true);
      try {
         setJob(await preparationRequest(API_URL, backupId, job.id, true, undefined, mode));
         setRetry((value) => value + 1);
      } catch (failure) {
         setError(failure instanceof Error ? failure.message : 'Cancellation was not confirmed.');
      } finally {
         setBusy(false);
      }
   };
   const chooseMode = async (next: DownloadMode) => {
      if (busy || mode === next) return;
      setBusy(true);
      try {
         if (job && preparationActive(job)) await preparationRequest(API_URL, backupId, job.id, true, undefined, mode);
         setJob(undefined);
         setStarted(false);
         setError('');
         setRetryAt(0);
         setMode(next);
      } catch (failure) {
         setError(failure instanceof Error ? failure.message : 'Cancellation was not confirmed.');
      } finally {
         setBusy(false);
      }
   };
   const restart = () => {
      if (busy || clock < retryAt) return;
      if (job && !preparationActive(job) && job.state !== 'ready') setJob(undefined);
      setRetry((value) => value + 1);
   };
   const elapsed = Math.floor(((job?.elapsedMs || 0) + (job && preparationActive(job) ? Math.max(0, clock - observedAt) : 0)) / 1000);
   return (
      <Modal title="Preparing Snapshot" closeModal={close} width="520px" stableLayout>
         <fieldset className={styles.modes} disabled={busy}>
            <legend>Delivery method</legend>
            <label>
               <input
                  type="radio"
                  name="delivery-method"
                  checked={delivery === 'standard'}
                  onChange={() => {
                     setBusy(false);
                     setDelivery('standard');
                  }}
               />{' '}
               Standard Download
            </label>
            <p>Stream directly from the snapshot. An interrupted download starts again.</p>
            <label>
               <input
                  type="radio"
                  name="delivery-method"
                  checked={delivery === 'reliable'}
                  onChange={() =>
                     void (async () => {
                        if (job && preparationActive(job)) await preparationRequest(API_URL, backupId, job.id, true, undefined, mode);
                        setJob(undefined);
                        setBusy(false);
                        setDelivery('reliable');
                     })().catch(() => setError('Cancellation was not confirmed.'))
                  }
               />{' '}
               Reliable Download
            </label>
            <p>Prepare a private temporary object for verified resume. Requires separate export storage.</p>
         </fieldset>
         <fieldset disabled={delivery === 'standard' && busy} className={styles.modes}>
            <legend>Download mode</legend>
            <label>
               <input type="radio" name="export-mode" checked={mode === 'full'} onChange={() => void chooseMode('full')} /> Full Download
               (Recommended)
            </label>
            <p>Complete snapshot archive. May preserve symbolic links. Requires successful security validation.</p>
            <label>
               <input type="radio" name="export-mode" checked={mode === 'regular-files'} onChange={() => void chooseMode('regular-files')} /> Download
               Regular Files Only
            </label>
            <p>Partial archive excluding symbolic links and special filesystem entries.</p>
         </fieldset>
         <p>Selected mode: {mode === 'full' ? 'Full Download' : 'Download Regular Files Only'}</p>
         {mode === 'regular-files' && (
            <p role="note" className={styles.partialWarning}>
               This is a partial export. Symbolic links and special filesystem entries are excluded. It may not be sufficient to restore the
               application completely.
            </p>
         )}
         {delivery === 'reliable' ? (
            <ReliableDownload backupId={backupId} mode={mode} close={close} />
         ) : (
            <>
               <div role="status" aria-live="polite">
                  <p>{error ? 'Preparation status unavailable' : job ? labels[job.state] : 'Requesting preparation…'}</p>
                  {job && (
                     <p>
                        Elapsed: {elapsed}s · Indexed entries: {job.indexedEntries.toLocaleString()}
                        {job.state === 'ready' ? ` · Validated entries: ${job.validatedEntries.toLocaleString()}` : ''}
                     </p>
                  )}
               </div>
               {job?.state === 'ready' && job.export && (
                  <div>
                     <p>
                        Included entries: {job.export.includedEntries.toLocaleString()} · Excluded entries:{' '}
                        {job.export.excludedEntries.toLocaleString()}
                     </p>
                     <p>
                        Included:{' '}
                        {Object.entries(job.export.includedByType)
                           .map(([type, n]) => `${entryLabels[type]}: ${n.toLocaleString()}`)
                           .join(' · ') || 'None'}
                        <br />
                        Excluded:{' '}
                        {Object.entries(job.export.excludedByType)
                           .map(([type, n]) => `${entryLabels[type]}: ${n.toLocaleString()}`)
                           .join(' · ') || 'None'}
                     </p>
                     <a
                        href={`${API_URL}/backups/${encodeURIComponent(backupId)}/download-preparations/${encodeURIComponent(job.id)}/manifest${mode === 'regular-files' ? '?exportMode=regular-files' : ''}`}
                        download
                     >
                        Download export manifest
                     </a>
                  </div>
               )}
               {job?.error && (
                  <p role="alert" className={classes.error}>
                     {job.error}
                  </p>
               )}
               {error && (
                  <p role="alert" className={classes.error}>
                     {error}
                  </p>
               )}
               <p>
                  Preparation verifies the selected snapshot archive. Your browser download manager reports transfer progress and completion. Closing
                  this panel leaves preparation running until it finishes or expires.
               </p>
               {started && <p>Download requested. Check your browser downloads for its result.</p>}
               <div className={classes.actions}>
                  <button type="button" onClick={close}>
                     Close
                  </button>
                  {job && preparationActive(job) && (
                     <button type="button" disabled={busy} onClick={() => void cancel()}>
                        Cancel preparation
                     </button>
                  )}
                  {(error || !job || (job.state !== 'ready' && !preparationActive(job))) && (
                     <button type="button" disabled={busy || clock < retryAt} onClick={restart}>
                        {clock < retryAt ? `Retry in ${Math.ceil((retryAt - clock) / 1000)}s` : 'Retry preparation'}
                     </button>
                  )}
                  {job?.state === 'ready' && !error && (
                     <button
                        type="button"
                        onClick={() => {
                           startNativeBackupDownload(API_URL, backupId, job.id, mode);
                           setStarted(true);
                        }}
                     >
                        Download TAR
                     </button>
                  )}
               </div>
            </>
         )}
      </Modal>
   );
}

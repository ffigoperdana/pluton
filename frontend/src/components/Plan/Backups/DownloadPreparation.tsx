import { useEffect, useRef, useState } from 'react';
import Modal from '../../common/Modal/Modal';
import classes from '../../common/ActionModal/ActionModal.module.scss';
import { API_URL } from '../../../utils/constants';
import { startNativeBackupDownload } from '../../../utils/backupDownload';
import { preparationActive, preparationRequest, type DownloadPreparation as Job } from '../../../utils/downloadPreparation';

const labels: Record<Job['state'], string> = {queued: 'Queued',
   indexing: 'Indexing snapshot metadata',
   validating: 'Validating snapshot and repository',
   ready: 'Ready to download',
   failed: 'Preparation failed',
   cancelled: 'Preparation cancelled',
   expired: 'Preparation expired',};
export default function DownloadPreparation({ backupId, close }: { backupId: string; close: () => void }) {
   const [job, setJob] = useState<Job>();
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
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout>;
      let currentId = jobRef.current?.id;
      const poll = async () => {
         setBusy(true);
         try {
            const next = await preparationRequest(API_URL, backupId, currentId, false, controller.signal);
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
   }, [backupId, retry]);
   const cancel = async () => {
      if (!job || busy) return;
      setBusy(true);
      try {
         setJob(await preparationRequest(API_URL, backupId, job.id, true));
         setRetry((value) => value + 1);
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
         <div role="status" aria-live="polite">
            <p>{error ? 'Preparation status unavailable' : job ? labels[job.state] : 'Requesting preparation…'}</p>
            {job && (
               <p>
                  Elapsed: {elapsed}s · Indexed entries: {job.indexedEntries.toLocaleString()}
                  {job.state === 'ready' ? ` · Validated entries: ${job.validatedEntries.toLocaleString()}` : ''}
               </p>
            )}
         </div>
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
            Preparation checks metadata. Your browser download manager reports transfer progress and completion. Closing this panel leaves preparation
            running until it finishes or expires.
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
                     startNativeBackupDownload(API_URL, backupId, job.id);
                     setStarted(true);
                  }}
               >
                  Download TAR
               </button>
            )}
         </div>
      </Modal>
   );
}

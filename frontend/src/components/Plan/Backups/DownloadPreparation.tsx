import { useCallback, useEffect, useState } from 'react';
import Modal from '../../common/Modal/Modal';
import classes from '../../common/ActionModal/ActionModal.module.scss';
import styles from './DownloadPreparation.module.scss';
import { API_URL } from '../../../utils/constants';
import { startNativeBackupDownload } from '../../../utils/backupDownload';
import { preparationActive, preparationRequest, type DownloadPreparation as Job, type DownloadMode } from '../../../utils/downloadPreparation';
import ReliableDownload from './ReliableDownload';

const labels: Record<Job['state'], string> = {queued: 'Queued',
   indexing: 'Indexing snapshot metadata',
   validating: 'Validating snapshot and repository',
   ready: 'Ready to download',
   failed: 'Preparation failed',
   cancelled: 'Preparation cancelled',
   expired: 'Preparation expired',};
const entryLabels: Record<string, string> = {file: 'Regular files',
   dir: 'Directories',
   symlink: 'Symbolic links',
   dev: 'Block devices',
   chardev: 'Character devices',
   fifo: 'FIFOs',
   socket: 'Sockets',};
import ActionModal from '../../common/ActionModal/ActionModal';
import { useDownloadJob } from '../../../hooks/useDownloadJob';

// Bounded tab-local navigation hints only; every reopen reauthorizes with the server.
// Never retain proofs, credentials or private resume URLs here.
type Choice = { mode: DownloadMode; delivery: 'standard' | 'reliable'; ids: Record<string, string> };
const choices = new Map<string, Choice>();
let choiceDocument: Document;
function choiceFor(backupId: string): Choice {
   if (choiceDocument !== document) {
      choices.clear();
      choiceDocument = document;
   }
   return choices.get(backupId) || { mode: 'full', delivery: 'standard', ids: {} };
}
function remember(backupId: string, choice: Choice) {
   choices.delete(backupId);
   choices.set(backupId, choice);
   if (choices.size > 32) choices.delete(choices.keys().next().value!);
}
const standardInterval = (job: Job) => (job.state === 'ready' ? 5000 : preparationActive(job) ? Math.max(1000, job.retryAfterMs) : false);
function StandardDownload({backupId,
   mode,
   close,
   initialId,
   onStatus,}: {
   backupId: string;
   mode: DownloadMode;
   close: () => void;
   initialId?: string;
   onStatus: (id: string | undefined, locked: boolean) => void;
}) {
   const request = useCallback(
      (id: string | undefined, cancel: boolean, signal: AbortSignal) => preparationRequest(API_URL, backupId, id, cancel, signal, mode),
      [backupId, mode],
   );
   const { job, error, actionError, busy, observedAt, refresh, cancel, restart } = useDownloadJob(request, standardInterval, true, initialId);
   const [clock, setClock] = useState(() => Date.now());
   const [started, setStarted] = useState(false);
   const [confirm, setConfirm] = useState(false);
   const active = !!job && preparationActive(job);
   const jobId = job?.id;
   const optionsLocked = busy || (!job && !error) || active;
   useEffect(() => {
      onStatus(jobId, optionsLocked);
   }, [onStatus, jobId, optionsLocked]);
   useEffect(() => {
      if (!active) return;
      const timer = setInterval(() => setClock(Date.now()), 1000);
      return () => clearInterval(timer);
   }, [active]);
   const elapsed = Math.floor(((job?.elapsedMs || 0) + (active ? Math.max(0, clock - observedAt) : 0)) / 1000);
   return (
      <>
         <div>
            <p role="status" aria-live="polite">
               {job ? labels[job.state] : 'Requesting preparation…'}
            </p>
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
                  Included entries: {job.export.includedEntries.toLocaleString()} · Excluded entries: {job.export.excludedEntries.toLocaleString()}
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
         <div className={styles.connection} role="status" aria-live="polite">
            {error && (
               <>
                  {error} Waiting for connection — reconnecting. Last confirmed progress is retained.{' '}
                  <button type="button" disabled={busy} onClick={refresh}>
                     Reconnect now
                  </button>
               </>
            )}
         </div>
         <p>
            Preparation verifies the selected snapshot archive. Your browser download manager reports transfer progress and completion. Closing this
            panel leaves preparation running until it finishes or expires.
         </p>
         {started && <p>Download requested. Check your browser downloads for its result.</p>}
         <div className={classes.actions}>
            <button type="button" onClick={close}>
               Close
            </button>
            {job && preparationActive(job) && (
               <button type="button" disabled={busy} onClick={() => setConfirm(true)}>
                  Cancel preparation
               </button>
            )}
            {job && job.state !== 'ready' && !preparationActive(job) && (
               <button type="button" disabled={busy} onClick={restart}>
                  Prepare again
               </button>
            )}
            {job?.state === 'ready' && (
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
         {confirm && (
            <ActionModal
               title="Cancel this preparation?"
               closeModal={() => setConfirm(false)}
               message="Stop this preparation? Closing the window leaves it running. Existing backups remain unchanged."
               errorMessage={actionError}
               primaryAction={{type: 'danger',
                  title: 'Confirm cancellation',
                  isPending: busy,
                  action: async () => {
                     if (await cancel()) setConfirm(false);
                  },}}
               secondaryAction={{ title: 'Keep preparation', action: () => setConfirm(false) }}
            />
         )}
      </>
   );
}
export default function DownloadPreparation({ backupId, close }: { backupId: string; close: () => void }) {
   return <PreparationPanel key={backupId} backupId={backupId} close={close} />;
}
function PreparationPanel({ backupId, close }: { backupId: string; close: () => void }) {
   const [choice, setChoice] = useState(() => choiceFor(backupId));
   const [locked, setLocked] = useState(true);
   const { mode, delivery } = choice;
   const onStatus = useCallback(
      (id: string | undefined, nextLocked: boolean) => {
         const previous = choiceFor(backupId);
         if (id) remember(backupId, { ...previous, ids: { ...previous.ids, [delivery + ':' + mode]: id } });
         setLocked(nextLocked);
      },
      [backupId, delivery, mode],
   );
   const select = (next: Partial<Pick<Choice, 'mode' | 'delivery'>>) => {
      const value = { ...choiceFor(backupId), ...choice, ...next, ids: choiceFor(backupId).ids };
      remember(backupId, value);
      setLocked(true);
      setChoice(value);
   };
   return (
      <Modal title="Preparing Snapshot" closeModal={close} width="560px" stableLayout>
         <fieldset className={styles.modes} disabled={delivery === 'reliable' && locked}>
            <legend>Delivery method</legend>
            <label>
               <input type="radio" name="delivery-method" checked={delivery === 'standard'} onChange={() => select({ delivery: 'standard' })} />{' '}
               Standard Download
            </label>
            <p>Stream directly from the snapshot. An interrupted download starts again.</p>
            <label>
               <input type="radio" name="delivery-method" checked={delivery === 'reliable'} onChange={() => select({ delivery: 'reliable' })} />{' '}
               Reliable Download
            </label>
            <p>Prepare a private temporary archive for verified resume. Independent of backup replication.</p>
         </fieldset>
         <fieldset className={styles.modes} disabled={locked}>
            <legend>Download mode</legend>
            <label>
               <input type="radio" name="export-mode" checked={mode === 'full'} onChange={() => select({ mode: 'full' })} /> Full Download
               (Recommended)
            </label>
            <p>Complete snapshot archive. May preserve symbolic links. Requires successful security validation.</p>
            <label>
               <input type="radio" name="export-mode" checked={mode === 'regular-files'} onChange={() => select({ mode: 'regular-files' })} />{' '}
               Download Regular Files Only
            </label>
            <p>Partial archive excluding symbolic links and special filesystem entries.</p>
         </fieldset>
         <p>
            Selected mode: {mode === 'full' ? 'Full Download' : 'Download Regular Files Only'}.{' '}
            {locked && 'Cancel the active preparation before changing its mode.'}
         </p>
         {mode === 'regular-files' && (
            <p role="note" className={styles.partialWarning}>
               This is a partial export. Symbolic links and special filesystem entries are excluded. It may not be sufficient to restore the
               application completely.
            </p>
         )}
         {delivery === 'reliable' ? (
            <ReliableDownload
               key={mode}
               backupId={backupId}
               mode={mode}
               close={close}
               initialId={choice.ids[delivery + ':' + mode]}
               onStatus={onStatus}
            />
         ) : (
            <StandardDownload
               key={mode}
               backupId={backupId}
               mode={mode}
               close={close}
               initialId={choice.ids[delivery + ':' + mode]}
               onStatus={onStatus}
            />
         )}
      </Modal>
   );
}

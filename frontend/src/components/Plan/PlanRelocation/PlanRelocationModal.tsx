import { useEffect, useRef, useState } from 'react';
import Modal from '../../common/Modal/Modal';
import Select from '../../common/form/Select/Select';
import Input from '../../common/form/Input/Input';
import { useGetStorages } from '../../../services/storage';
import { usePlanRelocationAction, usePlanRelocations } from '../../../services/planRelocations';
import type { PlanRelocation } from '../../../@types/planRelocations';
import {
   currentRelocation,
   formatRelocationBytes,
   relocationFailureText,
   relocationOperationLabel,
   relocationPhaseLabel,
   relocationProgressText,
   relocationShowsForm,
   relocationStatusLabel,
   shortId,
} from '../../../utils/planRelocation';
import classes from './PlanRelocation.module.scss';

interface PlanRelocationModalProps {
   planId: string;
   planTitle: string;
   currentPath: string;
   close: () => void;
   /** The plan's Storage binding changed (switch or revert); refresh plan data. */
   onBindingChanged?: () => void;
}

const location = (value: { storageName?: string; storageId: string; storagePath: string }) => (
   <>
      {value.storageName || value.storageId} · <code>{value.storagePath}</code>
   </>
);

const PlanRelocationModal = ({ planId, planTitle, currentPath, close, onBindingChanged }: PlanRelocationModalProps) => {
   const overview = usePlanRelocations(planId);
   const storages = useGetStorages();
   const action = usePlanRelocationAction(planId);
   const [storageId, setStorageId] = useState('');
   const [storagePath, setStoragePath] = useState(currentPath || '');
   const [confirming, setConfirming] = useState<'' | 'switch' | 'revert'>('');
   const [confirmTitle, setConfirmTitle] = useState('');
   const latest = currentRelocation(overview.data);
   const showForm = relocationShowsForm(overview.data);
   const lastStatus = useRef<string | undefined>(undefined);

   useEffect(() => {
      const status = latest?.status;
      if (lastStatus.current && status !== lastStatus.current && (status === 'switched' || status === 'reverted')) onBindingChanged?.();
      lastStatus.current = status;
   }, [latest?.status, onBindingChanged]);

   const storageList: unknown = storages.data?.result;
   const sftpStorages = (Array.isArray(storageList) ? (storageList as { id: string; name: string; type: string }[]) : []).filter(
      (storage) => storage.type === 'sftp',
   );
   const busy = action.isPending;
   const run = (input: Parameters<typeof action.mutate>[0]) =>
      action.mutate(input, {
         onSuccess: () => {
            setConfirming('');
            setConfirmTitle('');
         },
      });

   const panel = (relocation: PlanRelocation) => {
      const progress = relocationProgressText(relocation);
      const failedPhase = [...relocation.audit].reverse().find((event) => event.event === 'failed')?.phase;
      const working = ['copying', 'verifying'].includes(relocation.status) || !!relocation.operation;
      return (
         <>
            <dl className={classes.meta}>
               <dt>From</dt>
               <dd>{location(relocation.source)}</dd>
               <dt>To</dt>
               <dd>{location(relocation.destination)}</dd>
               <dt>Status</dt>
               <dd>{relocationStatusLabel(relocation.status)}</dd>
               {relocation.evidence && (
                  <>
                     <dt>Verified copy</dt>
                     <dd>
                        {relocation.evidence.fileCount} files, {formatRelocationBytes(relocation.evidence.totalBytes)},{' '}
                        {relocation.evidence.snapshotCount} snapshots, repository <code>{shortId(relocation.evidence.repositoryConfigId)}</code>
                     </dd>
                  </>
               )}
            </dl>

            {working && (
               <div className={`${classes.status} ${classes.progress}`} role="status" aria-live="polite">
                  <span className={classes.spinner} aria-hidden="true" />
                  <span>
                     {relocation.operation ? relocationOperationLabel(relocation.operation) : relocationPhaseLabel(relocation.phase)}
                     {progress && <span className={classes.detail}>{progress}</span>}
                     {!relocation.operation && (
                        <span className={classes.detail}>The plan is paused until the move finishes or is cancelled.</span>
                     )}
                  </span>
               </div>
            )}

            {relocation.status === 'failed' && (
               <div className={`${classes.status} ${classes.error}`} role="alert">
                  <span>
                     {relocationFailureText(relocation.failureCode)}
                     <span className={classes.detail}>
                        Code <code>{relocation.failureCode}</code>
                        {failedPhase ? ` during ${relocationPhaseLabel(failedPhase).toLowerCase()}` : ''}. The plan stays on its current
                        Storage{relocation.planWasActive ? ' and was resumed' : ''}.
                     </span>
                  </span>
               </div>
            )}

            {relocation.lastOperationFailure && !working && (
               <div className={`${classes.status} ${classes.error}`} role="alert">
                  <span>
                     {relocation.lastOperationFailure.operation === 'resume'
                        ? 'The plan could not be resumed automatically. Resume it from the plan page.'
                        : relocationFailureText(relocation.lastOperationFailure.code)}
                     <span className={classes.detail}>
                        {relocation.lastOperationFailure.operation} stopped, code <code>{relocation.lastOperationFailure.code}</code>.
                     </span>
                  </span>
               </div>
            )}

            {relocation.status === 'ready' && !working && (
               <div className={`${classes.status} ${classes.attention}`}>
                  <span>
                     The copy is verified. The plan stays paused, and scheduled backups are skipped, until you switch or cancel.
                     Before switching, check that the Agent host can reach the new SFTP server.
                  </span>
               </div>
            )}

            {relocation.status === 'switched' && !working && (
               <div className={`${classes.status} ${classes.success}`}>
                  <span>
                     New backups go to the new Storage. The previous copy is kept.
                     {!relocation.actions.deleteSource && (
                        <span className={classes.detail}>
                           The previous copy can be deleted after one successful backup at the new location. Until then you can move back.
                        </span>
                     )}
                  </span>
               </div>
            )}
            {relocation.status === 'source-deleted' && (
               <div className={`${classes.status} ${classes.success}`}>
                  <span>Moved. The previous copy was deleted.</span>
               </div>
            )}

            {confirming === 'switch' && relocation.actions.switch && (
               <div className={classes.confirm}>
                  <p>
                     Switch the plan to {location(relocation.destination)}? Pluton rechecks both copies first. Backup history, restores and
                     mirror receipts move with the plan. {relocation.planWasActive ? 'The plan resumes afterwards.' : 'The plan stays paused.'}
                  </p>
                  <div className={classes.actions}>
                     <button type="button" className={classes.primary} disabled={busy} onClick={() => run({ action: 'switch', id: relocation.id })}>
                        Switch now
                     </button>
                     <button type="button" className={classes.secondary} disabled={busy} onClick={() => setConfirming('')}>
                        Back
                     </button>
                  </div>
               </div>
            )}
            {confirming === 'revert' && relocation.actions.revert && (
               <div className={classes.confirm}>
                  <p>
                     Move the plan back to {location(relocation.source)}? Pluton first checks that the previous copy is unchanged.
                  </p>
                  <div className={classes.actions}>
                     <button type="button" className={classes.primary} disabled={busy} onClick={() => run({ action: 'revert', id: relocation.id })}>
                        Move back
                     </button>
                     <button type="button" className={classes.secondary} disabled={busy} onClick={() => setConfirming('')}>
                        Back
                     </button>
                  </div>
               </div>
            )}

            {!confirming && (
               <div className={classes.actions}>
                  {relocation.actions.switch && (
                     <button type="button" className={classes.primary} disabled={busy} onClick={() => setConfirming('switch')}>
                        Switch to new Storage
                     </button>
                  )}
                  {relocation.actions.revert && (
                     <button type="button" className={classes.secondary} disabled={busy} onClick={() => setConfirming('revert')}>
                        Move back
                     </button>
                  )}
                  {relocation.actions.cancel && (
                     <button type="button" className={classes.secondary} disabled={busy} onClick={() => run({ action: 'cancel', id: relocation.id })}>
                        Cancel move
                     </button>
                  )}
               </div>
            )}

            {relocation.actions.deleteSource && !confirming && (
               <div className={classes.deletion}>
                  <p>
                     Delete the previous copy at {location(relocation.source)}. Only Restic repository files are removed, and only if
                     every one of them also exists in the new location. This cannot be undone.
                  </p>
                  <Input
                     label={`Type the plan name (${planTitle}) to confirm`}
                     fieldValue={confirmTitle}
                     onUpdate={setConfirmTitle}
                     full
                  />
                  <div className={classes.actions}>
                     <button
                        type="button"
                        className={classes.danger}
                        disabled={busy || confirmTitle !== planTitle}
                        onClick={() => run({ action: 'delete-source', id: relocation.id, confirmTitle })}
                     >
                        Delete previous copy
                     </button>
                  </div>
               </div>
            )}

            {relocation.audit.length > 0 && (
               <details className={classes.audit}>
                  <summary>History</summary>
                  <ul>
                     {relocation.audit.map((event, index) => (
                        <li key={`${event.at}-${index}`}>
                           {new Date(event.at).toLocaleString()} · {event.event}
                           {event.code ? ` (${event.code})` : ''}
                           {event.phase ? ` during ${relocationPhaseLabel(event.phase)}` : ''}
                        </li>
                     ))}
                  </ul>
               </details>
            )}
         </>
      );
   };

   return (
      <Modal title="Move repository to another Storage" closeModal={close} width="600px">
         <div className={classes.relocation}>
            {overview.isLoading && (
               <div className={`${classes.status} ${classes.progress}`} role="status">
                  <span className={classes.spinner} aria-hidden="true" />
                  <span>Loading</span>
               </div>
            )}
            {overview.error && (
               <div className={`${classes.status} ${classes.error}`} role="alert">
                  <span>{(overview.error as Error).message || 'Repository relocation status is unavailable.'}</span>
               </div>
            )}
            {overview.data && !overview.data.supported && (
               <p>Only Remote Agent backup plans can move their repository to another Storage.</p>
            )}
            {overview.data?.supported && showForm && (
               <>
                  <p>
                     Pluton pauses the plan, copies its Restic repository from the current SFTP Storage to the one you choose, and verifies
                     the copy: identical file list, every file read back by SHA-256, same repository ID and snapshots, and{' '}
                     <code>restic check</code>. You switch the plan afterwards. Snapshot history is kept and the previous copy is not
                     deleted. The Agent needs no update, only network access to the new SFTP server.
                  </p>
                  {latest && (
                     <div className={`${classes.status} ${latest.status === 'failed' ? classes.error : ''}`}>
                        <span>
                           Last move: {relocationStatusLabel(latest.status)}
                           {latest.status === 'failed' && <span className={classes.detail}>{relocationFailureText(latest.failureCode)}</span>}
                        </span>
                     </div>
                  )}
                  <div className={classes.form}>
                     <Select
                        label="Destination Storage (SFTP)"
                        fieldValue={storageId}
                        options={sftpStorages.map((storage) => ({ label: storage.name, value: storage.id }))}
                        onUpdate={setStorageId}
                        full
                     />
                     <Input
                        label="Destination path"
                        description="An empty folder on the destination. The same path as today is fine on a different Storage."
                        fieldValue={storagePath}
                        onUpdate={setStoragePath}
                        full
                     />
                  </div>
                  <div className={classes.actions}>
                     <button
                        type="button"
                        className={classes.primary}
                        disabled={busy || !storageId || !storagePath.trim()}
                        onClick={() => run({ action: 'start', storageId, storagePath: storagePath.trim() })}
                     >
                        Pause plan and copy
                     </button>
                     <button type="button" className={classes.secondary} onClick={close}>
                        Close
                     </button>
                  </div>
               </>
            )}
            {overview.data?.supported && !showForm && latest && panel(latest)}
            {action.error && (
               <div className={`${classes.status} ${classes.error}`} role="alert">
                  <span>{action.error.message}</span>
               </div>
            )}
         </div>
      </Modal>
   );
};

export default PlanRelocationModal;

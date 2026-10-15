import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { RestorePreview, RestoreSelection, DatabaseRestoreView } from '../../../@types/databaseRestores';
import { useRestorePreview, restoreRequest } from '../../../services/databaseRestores';
import { initialRestoreChoice, restoreRefusal, restoreBody } from '../../../utils/databaseRestores';
import { formatBytes } from '../../../utils/helpers';
import Modal from '../../common/Modal/Modal';
import classes from './DatabaseRestore.module.scss';

export function DatabaseRestoreForm({
   preview,
   pending,
   error,
   confirm,
   refresh,
}: {
   preview: RestorePreview;
   pending: boolean;
   error?: string;
   confirm: (body: ReturnType<typeof restoreBody>) => void;
   refresh: () => void;
}) {
   const [choice, setChoice] = useState(() => initialRestoreChoice(preview));
   const artifact = preview.databases.find((entry) => entry.databaseId === choice.databaseId);
   const targets = preview.targets.filter((target) => target.engine === artifact?.engine && target.database === artifact?.database);
   const refusal = restoreRefusal(preview, choice);
   const retention = [...new Set([...preview.retentionSeconds, ...targets.map((target) => target.maxRetentionSeconds)])].sort((a, b) => a - b);
   const sample = preview.resources.sample;
   return (
      <div className={`${classes.panel} ${classes.wizard} styled__scrollbar`}>
         <p>One-time persistent restore. Backup policies and disposable Recovery Testing are unchanged.</p>
         <div className={classes.card}>
            Completed backup: <code>{preview.backupId}</code>
            <br />
            Exact snapshot: <code>{preview.snapshotId}</code>
            <br />
            Repository: <code>{preview.repositoryId}</code>
         </div>
         <div className={classes.grid}>
            <div>
               <label>
                  Recorded database
                  <select value={choice.databaseId} onChange={(event) => setChoice({ ...choice, databaseId: event.target.value, targetId: '' })}>
                     <option value="">Select a recorded database</option>
                     {preview.databases
                        .filter((entry) => entry.databaseId)
                        .map((entry) => (
                           <option key={entry.databaseId} value={entry.databaseId}>
                              {entry.database || 'Name not recorded'} · {entry.engine || 'Engine not recorded'}
                           </option>
                        ))}
                  </select>
               </label>
               <p>
                  Auto-detected engine: <strong>{artifact?.engine || 'Not recorded'}</strong> · SQL: {formatBytes(artifact?.bytes || 0)}
                  <br />
                  SHA-256: <code>{artifact?.sha256}</code>
               </p>
               <label>
                  Destination
                  <select
                     value={choice.mode}
                     onChange={(event) => setChoice({ ...choice, mode: event.target.value as 'internal' | 'custom', targetId: '' })}
                  >
                     <option value="internal">Internal — manual operator provisioning</option>
                     <option value="custom">Custom — root-approved dedicated target</option>
                  </select>
               </label>
               {choice.mode === 'custom' && (
                  <label>
                     Approved target
                     <select value={choice.targetId} onChange={(event) => setChoice({ ...choice, targetId: event.target.value })}>
                        <option value="">Select an approved target</option>
                        {targets.map((target) => (
                           <option key={target.id} value={target.id}>
                              {target.id} · {target.engine}
                           </option>
                        ))}
                     </select>
                  </label>
               )}
               <label>
                  Retention from confirmation
                  <select value={choice.ttlSeconds} onChange={(event) => setChoice({ ...choice, ttlSeconds: Number(event.target.value) })}>
                     {retention.map((seconds) => (
                        <option key={seconds} value={seconds}>
                           {seconds / 3600} hours{seconds === 86400 ? ' (default)' : ''}
                           {seconds > 86400 ? ' — operator-approved' : ''}
                        </option>
                     ))}
                  </select>
               </label>
            </div>
            <div>
               <h4>Resources and isolation</h4>
               <p>
                  Estimated database expansion: {formatBytes((artifact?.bytes || 0) * 4 + 256 * 1024 ** 2)}. Internal hard limits: 2 GiB storage, 2
                  GiB memory, 1 CPU and 128 PIDs; default SQL budget {formatBytes(preview.internalPolicy.maxSqlBytes)}. This estimate is not a
                  guarantee; database temporary files are bounded separately.
               </p>
               {sample ? (
                  <p>
                     Available RAM {formatBytes(sample.available)} / {formatBytes(sample.total)} · Swap {formatBytes(sample.swapUsed)}
                     <br />
                     Memory pressure {sample.pressure}% · Server {formatBytes(sample.used)} / {formatBytes(sample.limit)}
                     <br />
                     Staging free {formatBytes(sample.diskAvailable)}
                  </p>
               ) : (
                  <p role="alert">Capacity unknown. Import cannot start.</p>
               )}
               <p>
                  Internal storage is separately owned and hard-bounded, not disposable tmpfs. The operator must provision, stop/resume and physically
                  delete it. There is no automatic container startup. Custom targets need independent quota and purpose-guard approval.
               </p>
               <p>
                  Only the selected SQL artifact is staged. Its digest and exact snapshot binding are checked again before import. No source
                  overwrite, public database port or arbitrary SQL console.
               </p>
               <p>
                  Metadata inspection only; no row content. Expiration revokes inspection and requests cleanup. Physical resources remain Cleanup
                  Required until verified.
               </p>
            </div>
         </div>
         <label>
            <input type="checkbox" checked={choice.resources} onChange={(event) => setChoice({ ...choice, resources: event.target.checked })} /> I
            acknowledge memory/storage usage and operator cleanup. This cannot override admission limits.
         </label>
         <label>
            <input type="checkbox" checked={choice.security} onChange={(event) => setChoice({ ...choice, security: event.target.checked })} /> I
            approve a new empty dedicated restore database, retention and owned deletion; never a source/production database.
         </label>
         {refusal && <p role="status">{refusal}</p>}
         {error && <p role="alert">{error}</p>}
         <button disabled={pending} onClick={refresh}>
            Refresh verification
         </button>
         <button disabled={pending || !!refusal} onClick={() => confirm(restoreBody(preview, choice))}>
            {pending ? 'Submitting…' : 'Confirm persistent restore'}
         </button>
      </div>
   );
}
export default function DatabaseRestoreWizard({ selection, close }: { selection: RestoreSelection; close: () => void }) {
   const preview = useRestorePreview(selection),
      navigate = useNavigate();
   const action = useMutation({
      mutationFn: (body: ReturnType<typeof restoreBody>) => restoreRequest<DatabaseRestoreView>('', body),
      onSuccess: (row) => navigate(`/database-restores/${row.id}`),
   });
   return (
      <Modal width="920px" title="Restore Database" closeModal={() => !action.isPending && close()}>
         {preview.isFetching ? (
            <p>Verifying selected backup and exact snapshot…</p>
         ) : preview.error ? (
            <div role="alert">
               {preview.error.message}
               <button onClick={() => void preview.refetch()}>Retry</button>
            </div>
         ) : (
            preview.data && (
               <DatabaseRestoreForm
                  key={`${preview.data.metadataToken}:${preview.dataUpdatedAt}`}
                  preview={preview.data}
                  pending={action.isPending}
                  error={action.error?.message}
                  confirm={(body) => action.mutate(body)}
                  refresh={() => void preview.refetch()}
               />
            )
         )}
      </Modal>
   );
}

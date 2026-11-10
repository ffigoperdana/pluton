import { Fragment, useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Modal from '../../common/Modal/Modal';
import Icon from '../../common/Icon/Icon';
import { API_URL } from '../../../utils/constants';
import {
   detailBackup,
   comparisonFailureMessage,
   snapshotRequest,
   type SnapshotDetails as Details,
   type ChangeFilter,
} from '../../../utils/snapshotReview';
import { useSnapshotComparison } from '../../../hooks/useSnapshotComparison';
import { formatBytes } from '../../../utils/helpers';
import { formatHistoryDate } from '../../../utils/backupHistory';
import type { Backup } from '../../../@types/backups';
import classes from '../SnapshotViewer/SnapshotReview.module.scss';
const absent = 'Not recorded';
// missing | ready | failed | cancelled | unavailable; 'preparing' shows live progress instead.
const comparisonStateLabel = (state: string) => (state === 'missing' ? 'Not compared yet' : `Comparison ${state}`);
const changeLabel = { added: 'Added', modified: 'Modified', deleted: 'Deleted', unchanged: 'Unchanged' } as const;
const PAGE = 50;
export default function SnapshotDetails({
   backupId,
   close,
   onBrowse,
}: {
   backupId: string;
   close: () => void;
   onBrowse: (backup: Backup, filter: ChangeFilter) => void;
}) {
   const details = useQuery({
      queryKey: ['snapshot-details', backupId],
      queryFn: ({ signal }) => snapshotRequest<Details>(API_URL, backupId, 'details', signal),
      gcTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
   });
   const value = details.data,
      review = useSnapshotComparison(backupId, !!value?.comparisonAvailable);
   // One change-type selection drives both Browse Changed Files and the detailed path list.
   const [filter, setFilter] = useState<ChangeFilter>('added'),
      [offset, setOffset] = useState(0),
      [listOpen, setListOpen] = useState(false);
   const listId = useId();
   const changes = useQuery({
      queryKey: ['snapshot-detailed-changes', backupId, filter, offset],
      queryFn: ({ signal }) =>
         snapshotRequest<{ files: { path: string; change: string; backupId: string }[]; nextOffset: number | null; total: number }>(
            API_URL,
            backupId,
            `comparison?view=files&recursive=true&change=${filter}&offset=${offset}&limit=${PAGE}`,
            signal,
         ),
      enabled: review.query.data?.state === 'ready' && listOpen,
      gcTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
   });
   const recorded = (n: number | null | undefined, bytes = false) => (n == null ? absent : bytes ? formatBytes(n) : n.toLocaleString());
   const field = (label: string, result: React.ReactNode) => (
      <Fragment key={label}>
         <dt>{label}</dt>
         <dd>{result ?? absent}</dd>
      </Fragment>
   );
   return (
      <Modal title="Snapshot Details" stableLayout layout="details" closeModal={close}>
         <div className={classes.details}>
            {details.isError ? (
               <p role="alert">
                  Snapshot details unavailable.{' '}
                  <button type="button" className={classes.secondaryButton} onClick={() => void details.refetch()}>
                     Retry
                  </button>
               </p>
            ) : !value ? (
               <p role="status">Preparing metadata…</p>
            ) : (
               <>
                  <section>
                     <h4>Snapshot overview</h4>
                     <dl>
                        {field('Backup Plan', value.planName)}
                        {field('Backup ID', <code>{value.backupId}</code>)}
                        {field('Backup status', value.status)}
                        {field('Restic Snapshot ID', value.snapshotId && <code>{value.snapshotId}</code>)}
                        {field('Started', value.started ? formatHistoryDate(value.started, value.timeZone) : absent)}
                        {field('Completed', value.completed ? formatHistoryDate(value.completed, value.timeZone) : absent)}
                        {field('Duration', value.durationSeconds == null ? absent : `${value.durationSeconds.toLocaleString()} seconds`)}
                        {field('Timezone', value.timeZone)}
                        {field('Primary storage', value.storage?.name)}
                        {field('Backup source', `${value.source.type} · ${value.source.id}`)}
                     </dl>
                  </section>
                  <section>
                     <h4>Snapshot contents and recorded statistics</h4>
                     <p className={classes.note}>
                        Completion counters describe the backup's recorded parent. The verified comparison below can use a different previous eligible
                        snapshot.
                     </p>
                     <dl>
                        {field('Total files', recorded(value.statistics.totalFiles))}
                        {field('Total directories', recorded(value.statistics.totalDirectories))}
                        {field('Logical snapshot size', recorded(value.statistics.logicalBytes, true))}
                        {field('New files (recorded)', recorded(value.statistics.newFiles))}
                        {field('Modified files (recorded)', recorded(value.statistics.modifiedFiles))}
                        {field('Unchanged files (recorded)', recorded(value.statistics.unchangedFiles))}
                        {field('Deleted files (recorded)', recorded(value.statistics.deletedFiles))}
                        {field('New repository blobs, before packing', recorded(value.statistics.addedRepositoryBytes, true))}
                        {field('New repository blobs, packed', recorded(value.statistics.packedRepositoryBytes, true))}
                     </dl>
                     <p className={classes.note}>
                        Logical file bytes, dump artifacts and newly stored repository blobs measure different things. Repository physical usage is
                        not recorded here.
                     </p>
                  </section>
                  <section>
                     <h4>Database backup artifacts</h4>
                     {!value.databases.length ? (
                        <p className={classes.note}>{absent}. No independent database snapshot is inferred.</p>
                     ) : (
                        value.databases.map((a) => (
                           <dl key={a.path} className={classes.artifact}>
                              {field('Engine', a.engine)}
                              {field('Configured database reference', a.reference || a.database)}
                              {field('Dump status', 'Completed according to the snapshot completion receipt')}
                              {field('Artifact path', a.path)}
                              {field('Dump artifact size', recorded(a.bytes, true))}
                              {field('Dump timestamp', absent)}
                              {field('Recorded SHA-256', <code>{a.sha256}</code>)}
                              {field('Recovery Test', value.recovery?.status || absent)}
                           </dl>
                        ))
                     )}
                  </section>
                  <section>
                     <h4>Compared with previous snapshot</h4>
                     <p className={classes.note}>
                        Only exact snapshots from the same Backup Plan and compatible recorded repository/source scope are eligible.
                     </p>
                     {value.comparisonAvailable ? (
                        <>
                           <div className={classes.compareBar}>
                              <p role="status">
                                 {review.query.data?.state === 'preparing'
                                    ? `${review.query.data.phase} · ${review.query.data.processedEntries?.toLocaleString() || 0} entries · ${Math.floor((review.query.data.elapsedMs || 0) / 1000)}s`
                                    : review.query.data?.reason ||
                                      (review.query.data && comparisonStateLabel(review.query.data.state)) ||
                                      'Not compared'}
                              </p>
                              <button
                                 type="button"
                                 className={classes.secondaryButton}
                                 disabled={review.action.isPending}
                                 onClick={() => review.action.mutate(review.query.data?.state === 'preparing' ? 'cancel' : 'start')}
                              >
                                 {review.query.data?.state === 'preparing'
                                    ? 'Cancel comparison'
                                    : review.query.data?.state === 'failed'
                                      ? 'Retry comparison'
                                      : 'Compare with previous'}
                              </button>
                           </div>
                           {comparisonFailureMessage(review.query.data) && (
                              <p role="alert" className={classes.alert}>
                                 {comparisonFailureMessage(review.query.data)}
                              </p>
                           )}
                           {review.query.data?.previousSnapshotId && (
                              <p className={classes.note}>
                                 Selected previous snapshot: <code>{review.query.data.previousSnapshotId}</code>
                                 {!!review.query.data.skippedCandidates && ' · Older compatible recorded scope selected.'}
                              </p>
                           )}
                           {(review.query.isError || review.action.isError) && (
                              <p role="alert" className={classes.alert}>
                                 {review.action.error?.message ||
                                    review.query.error?.message ||
                                    'Comparison unavailable. Retry explicitly; browsing remains available.'}
                              </p>
                           )}
                           {review.query.data?.state === 'ready' && (
                              <>
                                 <dl>
                                    {field('Current Snapshot ID', <code>{review.query.data.currentSnapshotId}</code>)}
                                    {field('Previous Snapshot ID', <code>{review.query.data.previousSnapshotId}</code>)}
                                 </dl>
                                 <ul className={classes.summary} aria-label="Change summary">
                                    {(['added', 'modified', 'deleted', 'unchanged'] as const).map((key) => (
                                       <li key={key} className={classes[key]}>
                                          <span>
                                             <i aria-hidden="true" />
                                             {changeLabel[key]} files
                                          </span>
                                          <strong>{recorded(review.query.data!.summary?.[key])}</strong>
                                       </li>
                                    ))}
                                 </ul>
                                 <dl>
                                    {field('Added files, logical bytes', recorded(review.query.data.summary?.addedLogicalBytes, true))}
                                    {field('Removed files, logical bytes', recorded(review.query.data.summary?.removedLogicalBytes, true))}
                                 </dl>
                                 <p className={classes.note}>
                                    Count and byte summaries describe regular files. Directory and symlink changes remain visible in the lists.
                                 </p>
                                 <div className={classes.changeActions}>
                                    <div role="group" aria-label="Change type" className={classes.segmented}>
                                       {(['added', 'modified', 'deleted'] as const).map((type) => (
                                          <button
                                             type="button"
                                             key={type}
                                             aria-pressed={filter === type}
                                             onClick={() => {
                                                setFilter(type);
                                                setOffset(0);
                                             }}
                                          >
                                             {changeLabel[type]}
                                          </button>
                                       ))}
                                    </div>
                                    <button type="button" className={classes.primaryButton} onClick={() => onBrowse(detailBackup(value), filter)}>
                                       Browse Changed Files
                                    </button>
                                 </div>
                                 <p className={classes.note}>
                                    Browse Changed Files opens the snapshot tree filtered to the selected change type, with its download and restore
                                    actions. Detailed changes lists the same change type as exact paths, {PAGE} per page.
                                 </p>
                                 <button
                                    type="button"
                                    className={classes.disclosure}
                                    aria-expanded={listOpen}
                                    aria-controls={listId}
                                    onClick={() => setListOpen((open) => !open)}
                                 >
                                    <Icon type="caret-down" size={12} />
                                    Detailed changes
                                 </button>
                                 <div id={listId} hidden={!listOpen} className={classes.changeList}>
                                    {listOpen &&
                                       (changes.isError ? (
                                          <p role="alert" className={classes.alert}>
                                             Change list unavailable.
                                          </p>
                                       ) : (
                                          <>
                                             {changes.data && !changes.data.files.length ? (
                                                <p className={classes.note}>
                                                   No {changeLabel[filter as 'added'].toLowerCase()} paths in this comparison.
                                                </p>
                                             ) : (
                                                <ul>
                                                   {changes.data?.files.map((file) => (
                                                      <li key={file.path}>
                                                         <code>{file.path}</code>
                                                         {filter === 'deleted' && <span> · Previous snapshot only</span>}
                                                      </li>
                                                   ))}
                                                </ul>
                                             )}
                                             <div className={classes.pager}>
                                                <span role="status">
                                                   {changes.isFetching
                                                      ? 'Loading changes…'
                                                      : changes.data?.files.length
                                                        ? `${(offset + 1).toLocaleString()}–${(offset + changes.data.files.length).toLocaleString()} of ${changes.data.total.toLocaleString()}`
                                                        : ''}
                                                </span>
                                                <button
                                                   type="button"
                                                   className={classes.secondaryButton}
                                                   disabled={!offset || changes.isFetching}
                                                   onClick={() => setOffset(Math.max(0, offset - PAGE))}
                                                >
                                                   Previous changes
                                                </button>
                                                <button
                                                   type="button"
                                                   className={classes.secondaryButton}
                                                   disabled={changes.data?.nextOffset == null || changes.isFetching}
                                                   onClick={() => setOffset(changes.data!.nextOffset!)}
                                                >
                                                   Next changes
                                                </button>
                                             </div>
                                          </>
                                       ))}
                                 </div>
                              </>
                           )}
                        </>
                     ) : (
                        <p className={classes.note}>Not compared. Verified read-only comparison metadata is unavailable for this snapshot.</p>
                     )}
                  </section>
                  <section>
                     <h4>Recovery and replication</h4>
                     <dl>
                        {field('Primary completion', value.status)}
                        {field('Latest Recovery Test', value.recovery?.status || absent)}
                        {field(
                           'Recovery result recorded',
                           value.recovery?.createdAt ? formatHistoryDate(value.recovery.createdAt, value.timeZone) : absent,
                        )}
                     </dl>
                     <p className={classes.note}>Backup completion alone does not establish recoverability.</p>
                     {value.replication.length ? (
                        <ul className={classes.plainList}>
                           {value.replication.map((replica) => (
                              <li key={replica.id}>
                                 {replica.storageName}: {replica.status}
                                 {replica.snapshotId && (
                                    <>
                                       {' · '}
                                       <code>{replica.snapshotId}</code>
                                    </>
                                 )}
                              </li>
                           ))}
                        </ul>
                     ) : (
                        <p className={classes.note}>Replica receipts: {absent}</p>
                     )}
                     {value.warnings.length > 0 && (
                        <div role="status">
                           <h4>Lifecycle warnings</h4>
                           <ul>
                              {value.warnings.map((warning, i) => (
                                 <li key={i}>
                                    {warning.stage}: {warning.code}
                                 </li>
                              ))}
                           </ul>
                        </div>
                     )}
                  </section>
               </>
            )}
         </div>
         <footer className={classes.footer}>
            <span>Read-only metadata · no backup or storage settings changed.</span>
            <button type="button" className={classes.secondaryButton} onClick={close}>
               Close
            </button>
         </footer>
      </Modal>
   );
}

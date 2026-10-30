import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Modal from '../../common/Modal/Modal';
import { API_URL } from '../../../utils/constants';
import { detailBackup, snapshotRequest, type SnapshotDetails as Details, type ChangeFilter } from '../../../utils/snapshotReview';
import { useSnapshotComparison } from '../../../hooks/useSnapshotComparison';
import { formatBytes } from '../../../utils/helpers';
import { formatHistoryDate } from '../../../utils/backupHistory';
import type { Backup } from '../../../@types/backups';
import classes from '../SnapshotViewer/SnapshotReview.module.scss';
const absent = 'Not recorded';
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
   const [expanded, setExpanded] = useState<ChangeFilter>('added'),
      [offset, setOffset] = useState(0);
   const changes = useQuery({
      queryKey: ['snapshot-detailed-changes', backupId, expanded, offset],
      queryFn: ({ signal }) =>
         snapshotRequest<{ files: { path: string; change: string; backupId: string }[]; nextOffset: number | null; total: number }>(
            API_URL,
            backupId,
            `comparison?view=files&recursive=true&change=${expanded}&offset=${offset}&limit=50`,
            signal,
         ),
      enabled: review.query.data?.state === 'ready',
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
                  Snapshot details unavailable. <button onClick={() => void details.refetch()}>Retry</button>
               </p>
            ) : !value ? (
               <p role="status">Preparing metadata…</p>
            ) : (
               <>
                  <section>
                     <h4>Snapshot overview</h4>
                     <dl>
                        {field('Backup Plan', value.planName)}
                        {field('Backup ID', value.backupId)}
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
                     <p>
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
                     <p>
                        Logical file bytes, dump artifacts and newly stored repository blobs measure different things. Repository physical usage is
                        not recorded here.
                     </p>
                  </section>
                  <section>
                     <h4>Database backup artifacts</h4>
                     {!value.databases.length ? (
                        <p>{absent}. No independent database snapshot is inferred.</p>
                     ) : (
                        value.databases.map((a) => (
                           <dl key={a.path}>
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
                     <p>Only exact snapshots from the same Backup Plan and compatible recorded repository/source scope are eligible.</p>
                     {value.comparisonAvailable ? (
                        <>
                           <p role="status">
                              {review.query.data?.state === 'preparing'
                                 ? `${review.query.data.phase} · ${review.query.data.processedEntries?.toLocaleString() || 0} entries · ${Math.floor((review.query.data.elapsedMs || 0) / 1000)}s`
                                 : review.query.data?.reason || review.query.data?.state || 'Not compared'}
                           </p>
                           <button
                              disabled={review.action.isPending}
                              onClick={() => review.action.mutate(review.query.data?.state === 'preparing' ? 'cancel' : 'start')}
                           >
                              {review.query.data?.state === 'preparing'
                                 ? 'Cancel comparison'
                                 : review.query.data?.state === 'failed'
                                   ? 'Retry comparison'
                                   : 'Compare with previous'}
                           </button>
                           {(review.query.isError || review.action.isError) && (
                              <p role="alert">Comparison unavailable. Retry later; browsing remains available.</p>
                           )}
                           {review.query.data?.state === 'ready' && (
                              <>
                                 <dl>
                                    {field('Current Snapshot ID', <code>{review.query.data.currentSnapshotId}</code>)}
                                    {field('Previous Snapshot ID', <code>{review.query.data.previousSnapshotId}</code>)}
                                    {['added', 'modified', 'unchanged', 'deleted'].map((key) =>
                                       field(`${key[0].toUpperCase() + key.slice(1)} files`, recorded(review.query.data!.summary?.[key as 'added'])),
                                    )}
                                    {field('Added files, logical bytes', recorded(review.query.data.summary?.addedLogicalBytes, true))}
                                    {field('Removed files, logical bytes', recorded(review.query.data.summary?.removedLogicalBytes, true))}
                                 </dl>
                                 <p>Count and byte summaries describe regular files. Directory and symlink changes remain visible in the lists.</p>
                                 <h4>Detailed changes</h4>
                                 {(['added', 'modified', 'deleted'] as const).map((filter) => (
                                    <button
                                       key={filter}
                                       aria-expanded={expanded === filter}
                                       onClick={() => {
                                          setExpanded(filter);
                                          setOffset(0);
                                       }}
                                    >
                                       {filter}
                                    </button>
                                 ))}
                                 {changes.isError ? (
                                    <p role="alert">Change list unavailable.</p>
                                 ) : (
                                    <ul>
                                       {changes.data?.files.map((file) => (
                                          <li key={file.path}>
                                             <code>{file.path}</code>
                                             {expanded === 'deleted' && <span> · Previous snapshot only</span>}
                                          </li>
                                       ))}
                                    </ul>
                                 )}
                                 <button disabled={!offset || changes.isFetching} onClick={() => setOffset(Math.max(0, offset - 50))}>
                                    Previous changes
                                 </button>
                                 <button
                                    disabled={changes.data?.nextOffset == null || changes.isFetching}
                                    onClick={() => setOffset(changes.data!.nextOffset!)}
                                 >
                                    Next changes
                                 </button>
                                 <p>
                                    <button onClick={() => onBrowse(detailBackup(value), expanded)}>Browse Changed Files</button>
                                 </p>
                              </>
                           )}
                        </>
                     ) : (
                        <p>Not compared. Verified read-only comparison metadata is unavailable for this snapshot.</p>
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
                     <p>Backup completion alone does not establish recoverability.</p>
                     {value.replication.length ? (
                        <ul>
                           {value.replication.map((replica) => (
                              <li key={replica.id}>
                                 {replica.storageName}: {replica.status}
                                 {replica.snapshotId && <code> · {replica.snapshotId}</code>}
                              </li>
                           ))}
                        </ul>
                     ) : (
                        <p>Replica receipts: {absent}</p>
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
            <button onClick={close}>Close</button>
         </footer>
      </Modal>
   );
}

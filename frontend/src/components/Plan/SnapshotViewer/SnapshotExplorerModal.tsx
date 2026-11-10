import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Modal from '../../common/Modal/Modal';
import SnapshotViewer, { type SnapshotViewerProps } from './SnapshotViewer';
import { API_URL } from '../../../utils/constants';
import { detailBackup, snapshotRequest, type SnapshotDetails, type ChangeFilter } from '../../../utils/snapshotReview';
import { formatBytes } from '../../../utils/helpers';
import { formatHistoryDate } from '../../../utils/backupHistory';
import classes from './SnapshotReview.module.scss';
export default function SnapshotExplorerModal(props: SnapshotViewerProps & { initialFilter?: ChangeFilter }) {
   const [backup, setBackup] = useState(props.backup);
   const [navigationError, setNavigationError] = useState('');
   const details = useQuery({
      queryKey: ['snapshot-details', backup.id],
      queryFn: ({ signal }) => snapshotRequest<SnapshotDetails>(API_URL, backup.id, 'details', signal),
      retry: false,
      gcTime: 0,
      refetchOnWindowFocus: false,
   });
   const value = details.data;
   const previous = async (id: string) => {
      setNavigationError('');
      const value = await snapshotRequest<SnapshotDetails>(API_URL, id, 'details');
      if (value.status !== 'completed' || !value.snapshotId) throw new Error();
      setBackup(detailBackup(value));
   };
   return (
      <Modal title="Browse Snapshot" stableLayout layout="explorer" closeModal={props.onClose}>
         <header className={classes.header}>
            <div className={classes.headerPrimary}>
               <strong>{value?.planName || props.planId}</strong>
               <span>{value ? formatHistoryDate(value.completed || value.started || undefined, value.timeZone) : 'Preparing metadata…'}</span>
               <span>
                  {value?.statistics.logicalBytes == null ? 'Size: Not recorded' : formatBytes(value.statistics.logicalBytes)} ·{' '}
                  {value?.statistics.totalFiles == null ? 'Files: Not recorded' : `${value.statistics.totalFiles.toLocaleString()} files`}
               </span>
            </div>
            <dl className={classes.identity}>
               <div>
                  <dt>Backup ID</dt>
                  <dd>
                     <code>{backup.id}</code>
                  </dd>
               </div>
               <div>
                  <dt>Snapshot</dt>
                  <dd>
                     <code>{value?.snapshotId || 'Not recorded'}</code>
                  </dd>
               </div>
            </dl>
         </header>
         {navigationError && (
            <p role="alert" className={`${classes.alert} ${classes.inset}`}>
               {navigationError}
            </p>
         )}
         <div className={classes.explorer}>
            <SnapshotViewer
               {...props}
               key={backup.id}
               backup={backup}
               toolbarLeftContent={<strong>Files and directories</strong>}
               comparison={{
                  enabled: !!value?.comparisonAvailable,
                  initialFilter: backup.id === props.backup.id ? props.initialFilter : 'all',
                  onPrevious: (id) => void previous(id).catch(() => setNavigationError('Previous snapshot is unavailable. Retry later.')),
               }}
            />
         </div>
         <footer className={classes.footer}>
            <span>Historical snapshot · Restore uses the selected snapshot identity.</span>
            <button type="button" className={classes.secondaryButton} onClick={props.onClose}>
               Close
            </button>
         </footer>
      </Modal>
   );
}

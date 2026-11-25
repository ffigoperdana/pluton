import { toast } from 'react-toastify';
import Modal from '../../common/Modal/Modal';
import Icon from '../../common/Icon/Icon';
import { useGetSelfBackupBackups, useDownloadSelfBackup } from '../../../services/settings';
import { formatBytes } from '../../../utils/helpers';
import classes from './SelfBackupSettings.module.scss';
import { APP_NAME } from '../../../utils/brand';

interface BackupsListModalProps {
   settingsID: string;
   closeModal: () => void;
}

function formatDate(iso?: string): string {
   if (!iso) return '—';
   const date = new Date(iso);
   return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

const BackupsListModal = ({ settingsID, closeModal }: BackupsListModalProps) => {
   const { data, isLoading, isError, error } = useGetSelfBackupBackups(settingsID);
   const downloadMutation = useDownloadSelfBackup();
   const backups = data?.result || [];
   const downloadingName = downloadMutation.isPending ? downloadMutation.variables?.blobName : undefined;

   const download = (blobName: string) => {
      downloadMutation.mutate(
         { settingsID, blobName },
         { onError: (err: Error) => toast.error('Could not download backup. ' + (err?.message || '')) },
      );
   };

   return (
      <Modal title={`${APP_NAME} Backups`} width="640px" closeModal={closeModal}>
         <div className={classes.backupsModal}>
            {isLoading ? (
               <div className={classes.backupsEmpty}>
                  <Icon type="loading" size={16} /> Loading backups…
               </div>
            ) : isError ? (
               <div className={classes.backupsEmpty}>Could not load backups. {(error as Error)?.message || ''}</div>
            ) : backups.length === 0 ? (
               <div className={classes.backupsEmpty}>No backups found yet.</div>
            ) : (
               <ul className={classes.backupsList}>
                  {backups.map((backup) => (
                     <li key={backup.name} className={classes.backupRow}>
                        <div className={classes.backupInfo}>
                           <Icon type="box" size={20} />
                           <div className={classes.backupInfoTitle}>
                              <span className={classes.backupName}>{backup.name}</span>
                              <span className={classes.backupMeta}>
                                 {formatBytes(backup.size)} · {formatDate(backup.modTime)}
                              </span>
                           </div>
                        </div>
                        <button
                           className={classes.downloadBtn}
                           onClick={() => download(backup.name)}
                           disabled={downloadMutation.isPending}
                           title="Download backup"
                        >
                           <Icon type={downloadingName === backup.name ? 'loading' : 'download'} size={14} />
                           Download
                        </button>
                     </li>
                  ))}
               </ul>
            )}
         </div>
      </Modal>
   );
};

export default BackupsListModal;

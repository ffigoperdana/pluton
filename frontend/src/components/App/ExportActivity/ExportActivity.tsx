import { useState } from 'react';
import { useExportActivity } from '../../../hooks/useExportActivity';
import Modal from '../../common/Modal/Modal';
import ReliableDownload from '../../Plan/Backups/ReliableDownload';
import { reliableActive } from '../../../utils/reliableDownload';
import { downloadBytes } from '../../../utils/downloadProgress';
import styles from './ExportActivity.module.scss';

export default function ExportActivity() {
   const { jobs, error, checking, manager } = useExportActivity();
   const [open, setOpen] = useState(false);
   const [selected, setSelected] = useState<string>();
   const item = jobs.find((value) => value.job.id === selected);
   const count = jobs.filter(({ job }) => reliableActive(job) || job.cleanupPending).length;
   return (
      <>
         <aside className={styles.floating} aria-label="Background exports">
            <button
               type="button"
               onClick={() => {
                  setOpen(true);
                  void manager.refresh();
               }}
               aria-haspopup="dialog"
            >
               Exports{count ? ' · ' + count + ' active' : jobs.length ? ' · ' + jobs.length : ''}
               {error ? ' · attention' : ''}
            </button>
         </aside>
         {open && (
            <Modal
               title="Background export activity"
               closeModal={() => {
                  setOpen(false);
                  setSelected(undefined);
               }}
               width="560px"
               stableLayout
            >
               {item ? (
                  <>
                     <button type="button" onClick={() => setSelected(undefined)}>
                        Back to activities
                     </button>
                     {item.job.mode === 'regular-files' && (
                        <p role="note">
                           Partial archive: symbolic links and special entries are excluded. This may not restore the complete application.
                        </p>
                     )}
                     <ReliableDownload
                        key={item.job.id}
                        backupId={item.backupId}
                        mode={item.job.mode}
                        initialId={item.job.id}
                        close={() => {
                           setSelected(undefined);
                           setOpen(false);
                        }}
                     />
                  </>
               ) : (
                  <>
                     <p>
                        Server-side archive preparation continues when you close this window or navigate. Browser file transfers are separate; resume
                        uses the existing authorized Range download.
                     </p>
                     {error && <p role="status">{error.message}</p>}
                     <button type="button" disabled={checking} onClick={() => void manager.refresh()}>
                        Check server activity
                     </button>
                     {!jobs.length && <p>{checking ? 'Checking admitted exports…' : 'No admitted exports found for this session owner.'}</p>}
                     <ul className={styles.list}>
                        {jobs.map(({ backupId, job }) => (
                           <li key={job.id}>
                              <button type="button" onClick={() => setSelected(job.id)}>
                                 <strong>{job.mode === 'full' ? 'Full archive' : 'Regular files only'}</strong>
                                 <span>
                                    Backup {backupId} ·{' '}
                                    {job.cleanupPending ? 'Cleanup pending' : job.state === 'ready' ? 'Ready — server archive verified' : job.state}
                                 </span>
                                 <span>
                                    {job.totalBytes ? downloadBytes(job.totalBytes) + ' · ' : ''}
                                    {new Date(job.createdAt).toLocaleString()}
                                 </span>
                              </button>
                           </li>
                        ))}
                     </ul>
                  </>
               )}
            </Modal>
         )}
      </>
   );
}

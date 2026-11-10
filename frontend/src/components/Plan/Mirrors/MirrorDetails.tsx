import AssistedRecovery from '../../Restore/AssistedRecovery/AssistedRecovery';
import { toast } from 'react-toastify';
import { Backup, PlanReplicationSettings } from '../../../@types';
import { useRetryFailedReplications } from '../../../services';
import { formatBytes, formatDuration } from '../../../utils';
import Icon from '../../common/Icon/Icon';
import Modal from '../../common/Modal/Modal';
import classes from './MirrorDetails.module.scss';
import { mirrorStatusLabel, mirrorSummary } from '../../../utils/replication';

interface MirrorDetailsProps {
   mirrors: Backup['mirrors'];
   replicationSettings?: PlanReplicationSettings;
   managedAgent?: boolean;
   backupId: string;
   backupTitle?: string;
   planId: string;
   close: () => void;
}

const MirrorDetails = ({ mirrors = [], replicationSettings, managedAgent, backupId, backupTitle, planId, close }: MirrorDetailsProps) => {
   const retryReplicationsMutation = useRetryFailedReplications();
   const summary = mirrorSummary(mirrors, replicationSettings?.enabled ? replicationSettings.storages.length : mirrors.length);

   const retryReplication = (backupId: string, replicationId: string) => {
      toast.promise(retryReplicationsMutation.mutateAsync({ backupId, planId, replicationId }), {
         pending: 'Retrying failed replication...',
         success: 'Replication retry queued!',
         error: {
            render({ data }: any) {
               return `Failed to retry replication. ${data?.message || 'Unknown Error.'}`;
            },
         },
      });
   };

   return (
      <Modal title={`Mirrors for ${backupTitle ? backupTitle : 'backup-' + backupId}`} closeModal={close} width="560px">
         <div className={classes.mirrorDetails}>
            {summary.incomplete && (
               <p role="status" className={classes.notice}>
                  {summary.label}. A successful primary backup does not confirm replica protection.
               </p>
            )}
            <p className={classes.note}>
               Retries are explicit. Pending copies are reconciled by the server; uncertain results may require an operator review.
            </p>
            <div className={classes.mirrorList}>
               {mirrors && mirrors.length > 0 ? (
                  mirrors.map((mirror, index) => {
                     const duration = mirror.ended && mirror.started ? formatDuration((mirror.ended - mirror.started) / 1000) : 'N/A';
                     const mirrorSize = mirror.size ? formatBytes(mirror.size) : '';
                     const label = mirrorStatusLabel(mirror.status);
                     const iconType =
                        mirror.status === 'completed'
                           ? 'check'
                           : mirror.status === 'failed'
                             ? 'error'
                             : mirror.status === 'started'
                               ? 'loading'
                               : 'clock';
                     return (
                        <div key={mirror.replicationId || index} className={classes.mirrorItem}>
                           <div className={classes.mirrorItemContent}>
                              <div className={classes.mirrorItemLabel}>
                                 <img alt="" src={`/providers/${mirror.storageType}.png`} /> <strong>{mirror.storageName}</strong>{' '}
                                 {mirror.status === 'completed' && (
                                    <>
                                       {mirrorSize && (
                                          <i>
                                             <Icon type="disk" size={12} /> {mirrorSize}
                                          </i>
                                       )}{' '}
                                       <i>
                                          <Icon type="clock" size={12} /> {duration}
                                       </i>
                                    </>
                                 )}
                              </div>
                              <div className={`${classes.mirrorItemStatus} ${classes[mirror.status]}`}>
                                 {mirror.status === 'failed' && (
                                    <button
                                       type="button"
                                       className={classes.retryButton}
                                       disabled={retryReplicationsMutation.isPending}
                                       onClick={() => !retryReplicationsMutation.isPending && retryReplication(backupId, mirror.replicationId)}
                                    >
                                       <Icon type={'reload'} size={14} /> Retry
                                    </button>
                                 )}{' '}
                                 <Icon type={iconType} size={12} /> {label}
                              </div>
                           </div>
                           {mirror.snapshotId && (
                              <div className={classes.mirrorMetadata}>
                                 Last replicated snapshot: <code>{mirror.snapshotId}</code>
                              </div>
                           )}
                           {mirror.sourceSnapshotId && (
                              <div className={classes.mirrorMetadata}>
                                 Source snapshot: <code>{mirror.sourceSnapshotId}</code>
                              </div>
                           )}
                           {mirror.attempts !== undefined && <div className={classes.mirrorMetadata}>Attempts: {mirror.attempts}</div>}
                           {mirror.verifiedAt && <div className={classes.mirrorMetadata}>Verified: {new Date(mirror.verifiedAt).toISOString()}</div>}
                           {mirror.lastErrorCode && <div className={classes.mirrorMetadata}>Decision: {mirror.lastErrorCode}</div>}
                           {mirror.error && <div className={classes.mirrorItemError}>{mirror.error}</div>}
                        </div>
                     );
                  })
               ) : (
                  <div className={classes.empty}>No replica result has been recorded for this backup yet.</div>
               )}
            </div>
            {managedAgent && (
               <div className={classes.recovery}>
                  {replicationSettings?.recoveryPolicy === 'assisted' ? (
                     <AssistedRecovery planId={planId} backupId={backupId} manual />
                  ) : (
                     <p className={classes.note}>
                        This plan uses Primary Only. Enable Assisted Failover in plan settings to authorize isolated replica recovery. Native database
                        import retains its separate approval.
                     </p>
                  )}
               </div>
            )}
         </div>
      </Modal>
   );
};

export default MirrorDetails;

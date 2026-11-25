import { useState } from 'react';
import Modal from '../../common/Modal/Modal';
import classes from './AgentHostRestore.module.scss';
import AgentHostTargetFields from './AgentHostTargetFields';
import AgentHostRestoreConfirm from './AgentHostRestoreConfirm';
import { useAgentHostRestoreOptions } from '../../../services/restores';
import { APP_NAME } from '../../../utils/brand';

interface AgentHostRestoreModalProps {
   backupId: string;
   planId: string;
   /** The `.sql` dump path recorded for the backup (/pluton/database/<file>). */
   databasePath: string;
   close: () => void;
}

/** "Restore to Agent host" for one database dump artifact (docs/AGENT_HOST_RESTORE.md 8.4). */
const AgentHostRestoreModal = ({ backupId, planId, databasePath, close }: AgentHostRestoreModalProps) => {
   const options = useAgentHostRestoreOptions({ backupId, planId, enabled: true });
   const [target, setTarget] = useState<{ root: string; name: string } | null>(null);
   const [reviewing, setReviewing] = useState(false);
   const database = options.data?.databases.find((entry) => entry.path === databasePath);
   const current = target || {
      root: options.data?.roots[0]?.path || '',
      name: options.data?.suggestedName || '',
   };
   return (
      <Modal title="Restore database dump to the Agent host" closeModal={close}>
         <div className={classes.modalBody}>
            <p className={classes.note}>
               Restores <code>{databasePath}</code> on the Agent host only, without passing it through {APP_NAME} or this browser. Load it into a
               new database afterwards.
            </p>
            {options.data?.supported && !database ? (
               <div className={classes.error}>This dump is not recorded in the backup's completion receipt, so it cannot be verified.</div>
            ) : reviewing && options.data && database ? (
               <AgentHostRestoreConfirm
                  backupId={backupId}
                  planId={planId}
                  hostname={options.data.agent?.hostname || 'the Agent host'}
                  snapshotId={options.data.snapshotId}
                  root={current.root}
                  name={current.name}
                  databaseId={database.databaseId}
                  databasePath={database.path}
                  onDone={close}
               />
            ) : (
               <AgentHostTargetFields
                  options={options.data}
                  loading={options.isLoading}
                  error={options.error?.message}
                  root={current.root}
                  name={current.name}
                  onChange={setTarget}
               />
            )}
            <div className={classes.modalFooter}>
               {reviewing ? (
                  <button onClick={() => setReviewing(false)}>Back</button>
               ) : (
                  options.data?.supported &&
                  database && (
                     <button className={classes.primary} onClick={() => setReviewing(true)}>
                        Review
                     </button>
                  )
               )}
               <button onClick={close}>Close</button>
            </div>
         </div>
      </Modal>
   );
};

export default AgentHostRestoreModal;

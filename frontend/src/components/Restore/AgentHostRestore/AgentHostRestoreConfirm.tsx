import { toast } from 'react-toastify';
import { useNavigate } from 'react-router';
import Icon from '../../common/Icon/Icon';
import classes from './AgentHostRestore.module.scss';
import { useStartAgentHostRestore } from '../../../services/restores';
import {
   agentHostOperatorSteps,
   agentHostRequestBody,
   agentHostRestoreNameProblem,
   agentHostRestoreScope,
   agentHostRestoreTarget,
   agentHostSelectionProblem,
} from '../../../utils/agentHostRestore';

interface AgentHostRestoreConfirmProps {
   backupId: string;
   planId: string;
   hostname: string;
   snapshotId?: string;
   root: string;
   name: string;
   includes?: string[];
   excludes?: string[];
   databaseId?: string;
   databasePath?: string;
   /** Rendered after a successful queue, e.g. the wizard's Close button. */
   onDone?: () => void;
}

/** Review, queue and the operator's next steps (docs/AGENT_HOST_RESTORE.md 7 and 8.4). */
const AgentHostRestoreConfirm = ({
   backupId,
   planId,
   hostname,
   snapshotId,
   root,
   name,
   includes = [],
   excludes = [],
   databaseId,
   databasePath,
   onDone,
}: AgentHostRestoreConfirmProps) => {
   const mutation = useStartAgentHostRestore();
   const navigate = useNavigate();
   const selection = { includes: databaseId ? [] : includes, excludes: databaseId ? [] : excludes };
   const problem = agentHostRestoreNameProblem(name) || (!root ? 'Select a host-approved restore folder.' : undefined) || agentHostSelectionProblem(selection);
   const target = agentHostRestoreTarget(root, name);

   const queue = () =>
      mutation.mutate(agentHostRequestBody({ backupId, planId, root, name, ...selection, databaseId }), {
         onSuccess: () => toast.success(`Restore queued on ${hostname}`, { autoClose: 5000 }),
      });

   if (mutation.isSuccess)
      return (
         <div className={classes.summary}>
            <p>
               <Icon type="check-circle-filled" size={14} /> The restore is queued on <strong>{hostname}</strong> (restore{' '}
               <code>{mutation.data.restoreId}</code>). Follow it in the plan's restore history; it starts when the Agent is free.
            </p>
            <p className={classes.note}>
               While it runs the folder is <code>{mutation.data.target}.partial</code>. Only a folder without <code>.partial</code> is complete
               and verified. Pluton never moves, chowns or deletes it. After it completes, the host administrator typically runs:
            </p>
            <ol className={classes.steps}>
               {agentHostOperatorSteps(mutation.data.target, databasePath).map((step) => (
                  <li key={step}>
                     <code>{step}</code>
                  </li>
               ))}
            </ol>
            <button
               className={classes.primary}
               onClick={() => {
                  navigate(`/plan/${planId}`);
                  onDone?.();
               }}
            >
               Open plan restores
            </button>
         </div>
      );

   return (
      <div className={classes.summary}>
         <dl>
            <dt>Agent host</dt>
            <dd>{hostname}</dd>
            <dt>What</dt>
            <dd>{agentHostRestoreScope(selection, databasePath)}</dd>
            {snapshotId && (
               <>
                  <dt>Snapshot</dt>
                  <dd>
                     <code>{snapshotId}</code>
                  </dd>
               </>
            )}
            <dt>New folder</dt>
            <dd>
               <code>{target}</code>
            </dd>
            <dt>Rules</dt>
            <dd>New empty folder only; never overwrite or delete; verified with restic restore --verify{databasePath ? ' and the recorded SHA-256' : ''}.</dd>
         </dl>
         <p className={classes.note}>
            The Agent checks free space and inodes on its host before writing. A failed or cancelled restore leaves <code>{name}.partial</code>{' '}
            for review; remove it before reusing the name.
         </p>
         {problem && <div className={classes.error}>{problem}</div>}
         {mutation.isError && <div className={classes.error}>{mutation.error?.message || 'Could not queue the restore.'}</div>}
         <button className={classes.primary} disabled={!!problem || mutation.isPending} onClick={queue}>
            {mutation.isPending ? (
               <>
                  <Icon type="loading" size={12} /> Queuing…
               </>
            ) : (
               <>
                  <Icon type="restore" size={14} /> Restore on {hostname}
               </>
            )}
         </button>
      </div>
   );
};

export default AgentHostRestoreConfirm;

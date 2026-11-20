import Select from '../../common/form/Select/Select';
import Input from '../../common/form/Input/Input';
import classes from './AgentHostRestore.module.scss';
import {
   agentHostRestoreNameProblem,
   agentHostRestoreTarget,
   agentHostRootLabel,
   type AgentHostRestoreOptions,
} from '../../../utils/agentHostRestore';

interface AgentHostTargetFieldsProps {
   options?: AgentHostRestoreOptions;
   loading: boolean;
   error?: string | null;
   root: string;
   name: string;
   showErrors?: boolean;
   onChange: (value: { root: string; name: string }) => void;
}

/** Host-approved restore root and the new folder name (docs/AGENT_HOST_RESTORE.md 8.4). */
const AgentHostTargetFields = ({ options, loading, error, root, name, showErrors = false, onChange }: AgentHostTargetFieldsProps) => {
   if (loading) return <p className={classes.note}>Checking what the Agent of this plan can restore on its host…</p>;
   if (error) return <div className={classes.error}>{error}</div>;
   if (!options) return null;
   if (!options.supported)
      return (
         <div className={classes.fields}>
            <div className={classes.error}>{options.message || 'This Agent cannot restore to its host.'}</div>
            {options.unavailableRoots.length > 0 && (
               <p className={classes.note}>
                  Reported restore folders that are not usable:{' '}
                  {options.unavailableRoots.map((entry) => `${entry.path} (${entry.code || entry.status})`).join(', ')}.
               </p>
            )}
         </div>
      );
   const nameProblem = agentHostRestoreNameProblem(name);
   return (
      <div className={classes.fields}>
         <Select
            label="Host-approved restore folder"
            options={options.roots.map((entry) => ({ label: agentHostRootLabel(entry), value: entry.path }))}
            fieldValue={root}
            full
            onUpdate={(value) => onChange({ root: value, name })}
         />
         <Input
            label="New folder name"
            placeholder={options.suggestedName}
            fieldValue={name}
            full
            onUpdate={(value) => onChange({ root, name: value.trim() })}
         />
         {showErrors && nameProblem && <div className={classes.error}>{nameProblem}</div>}
         {root && !nameProblem && <div className={classes.target}>{agentHostRestoreTarget(root, name)}</div>}
         <p className={classes.note}>
            The Agent on <strong>{options.agent?.hostname}</strong> reads the backup repository itself and restores into this new folder.
            Nothing passes through the Pluton server or this browser. It never overwrites or deletes anything: while it runs the folder is
            named <code>{name || options.suggestedName}.partial</code> and it is renamed only after Restic verified every restored file.
            Restored files are owned by <code>pluton-agent</code>; the host administrator moves them into place and sets owners.
         </p>
      </div>
   );
};

export default AgentHostTargetFields;

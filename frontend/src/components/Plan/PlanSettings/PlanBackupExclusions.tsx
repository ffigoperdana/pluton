import { useState } from 'react';
import type { NewPlanSettings } from '../../../@types/plans';
import type { Device } from '../../../@types/devices';
import { parseBackupExclusions } from '../../../utils/backupExclusions';
import classes from './PlanSettings.module.scss';

export default function PlanBackupExclusions({
   plan,
   device,
   onUpdate,
}: {
   plan: NewPlanSettings;
   device: Device;
   onUpdate: (plan: NewPlanSettings) => void;
}) {
   const [text, setText] = useState(() => plan.sourceConfig.excludes.join('\n'));
   const capable = device?.agent?.capabilities?.backupExclusionsVersion === 1;
   let error = '';
   try {
      parseBackupExclusions(text.split(/\r?\n/).filter((line) => line.trim()));
   } catch (failure) {
      error = failure instanceof Error ? failure.message : 'Invalid Backup Exclusions.';
   }
   return (
      <div className={`${classes.field} ${classes.backupExclusions}`}>
         <label className={classes.label} htmlFor="backup-exclusions">
            Backup Exclusions
         </label>
         <textarea
            id="backup-exclusions"
            rows={5}
            value={text}
            aria-invalid={Boolean(error)}
            aria-describedby="backup-exclusions-help backup-exclusions-error"
            placeholder={'.git/\nnode_modules/\n.cache/\n**/cache/\n*.tmp'}
            onChange={(event) => {
               const value = event.target.value;
               setText(value);
               onUpdate({
                  ...plan,
                  sourceConfig: {
                     ...plan.sourceConfig,
                     excludes: value
                        .split(/\r?\n/)
                        .map((line) => line.trim())
                        .filter(Boolean),
                  },
               });
            }}
         />
         <p id="backup-exclusions-help">
            One relative pattern per line. Bare names match at any depth; paths start at the source. Use *, ?, or one recursive ** component (optional
            trailing /**). Trailing / is ignored. Excluded data will not exist in the recovery snapshot. Generated database dumps remain separate.
         </p>
         {!capable && (
            <p role="status">
               Update this Agent to 0.7.0 or later and refresh its inventory before using exclusions. Empty exclusions keep existing behavior.
            </p>
         )}
         <span id="backup-exclusions-error" role={error ? 'alert' : undefined}>
            {error}
         </span>
      </div>
   );
}

import { troubleshootingTopics } from '../../../docs/troubleshootingTopics';
import { useState } from 'react';
import type { NewPlanSettings } from '../../../@types/plans';
import type { Device } from '../../../@types/devices';
import { parseBackupExclusions, sourcePrefixedExclusions, backupExclusionMatches } from '../../../utils/backupExclusions';
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
   const [preview, setPreview] = useState('');
   const patterns = text.split(/\r?\n/).filter((line) => line.trim());
   const capable = device?.agent?.capabilities?.backupExclusionsVersion === 1;
   let error = '';
   try {
      parseBackupExclusions(patterns);
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
         <p>
            Examples: <code>app/logs</code>, <code>.git</code>, <code>cache</code>, <code>public_html/console-app/export/tmp</code>. Do not include
            the absolute source root, even with its leading slash removed.
         </p>
         {sourcePrefixedExclusions(plan.sourceConfig.includes[0] || '', patterns).length > 0 && (
            <p role="alert">
               A pattern appears to contain the source root. Patterns start inside the selected source; verify the intended relative path. Saved
               exclusions will not be changed automatically.
            </p>
         )}
         <p>
            <a href={troubleshootingTopics.exclusions.href}>Backup Exclusions and permission troubleshooting</a>
         </p>
         <details>
            <summary>Preview a relative path</summary>
            <label htmlFor="exclusion-preview">Sample path inside the source</label>
            <input id="exclusion-preview" value={preview} maxLength={512} onChange={(event) => setPreview(event.target.value)} />
            {preview && !error && (
               <p role="status">
                  {preview.startsWith('/') || preview.includes('\\') || preview.split('/').includes('..')
                     ? 'Enter a relative path without traversal.'
                     : backupExclusionMatches(patterns, preview)
                       ? 'This path matches an exclusion.'
                       : 'This path does not match an exclusion.'}{' '}
                  Pattern preview only; no Agent scan is performed.
               </p>
            )}
         </details>
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

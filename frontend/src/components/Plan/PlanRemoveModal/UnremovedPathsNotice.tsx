import { useState } from 'react';
import Icon from '../../common/Icon/Icon';
import { UnremovedStoragePath } from '../../../services/plans';
import classes from './UnremovedPathsNotice.module.scss';

interface UnremovedPathsNoticeProps {
   paths: UnremovedStoragePath[];
   reason?: string;
}

/**
 * Rendered inside a toast, so it outlives the plan page it was triggered from and keeps its
 * own copy state.
 */
const UnremovedPathsNotice = ({ paths, reason }: UnremovedPathsNoticeProps) => {
   const [copiedPath, setCopiedPath] = useState<string>('');

   const copyPath = (path: string) => {
      navigator.clipboard.writeText(path).then(
         () => setCopiedPath(path),
         () => setCopiedPath(''),
      );
   };

   return (
      <div className={classes.unremovedNotice}>
         <strong>Plan Removed</strong>
         {reason && <p className={classes.reason}>Warning: {reason}</p>}
         <p>The storage data could not be removed. You will have to remove these storage paths yourself:</p>
         <ul className={classes.paths}>
            {paths.map(({ storageName, storagePath }) => {
               const fullPath = `${storageName}:${storagePath}`;
               return (
                  <li key={fullPath}>
                     <span>{fullPath}</span>
                     <button type="button" onClick={() => copyPath(fullPath)} title="Copy path">
                        <Icon type={copiedPath === fullPath ? 'check' : 'copy'} size={13} />
                     </button>
                  </li>
               );
            })}
         </ul>
      </div>
   );
};

export default UnremovedPathsNotice;

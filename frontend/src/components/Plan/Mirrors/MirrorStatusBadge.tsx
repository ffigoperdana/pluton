import { useState } from 'react';
import { BackupMirror } from '../../../@types/backups';
import Icon from '../../common/Icon/Icon';
import classes from './MirrorStatusBadge.module.scss';
import MirrorDetails from './MirrorDetails';
import { PlanReplicationSettings } from '../../../@types';
import { failoverSummary, mirrorSummary } from '../../../utils/replication';

interface MirrorStatusBadgeProps {
   mirrors: BackupMirror[];
   planId: string;
   backupId: string;
   replicationSettings?: PlanReplicationSettings;
   managedAgent?: boolean;
}

const MirrorStatusBadge = ({ mirrors, planId, backupId, replicationSettings, managedAgent }: MirrorStatusBadgeProps) => {
   const [showMirrorDetails, setShowMirrorDetails] = useState(false);
   const expected = replicationSettings?.enabled ? replicationSettings.storages.length : mirrors.length;
   if (!mirrors.length && !expected) return null;
   const summary = mirrorSummary(mirrors, expected);
   const failover = failoverSummary(mirrors);
   const tooltip = failover ? `${failover.detail} ${summary.label}` : summary.label;

   let badgeClass = classes.badge;
   if (summary.state === 'pending') {
      badgeClass += ` ${classes.badgeProgress}`;
   } else if (summary.state === 'failed') {
      badgeClass += ` ${classes.badgeFailed}`;
   } else {
      badgeClass += ` ${classes.badgeSuccess}`;
   }

   return (
      <>
         <button
            type="button"
            className={badgeClass}
            aria-label={tooltip}
            title={tooltip}
            data-tooltip-id="appTooltip"
            data-tooltip-place="top"
            data-tooltip-content={tooltip}
            onClick={() => setShowMirrorDetails(true)}
         >
            <Icon type={'mirrors'} size={13} />
            {failover ? (
               <span className={failover.state === 'failed' ? classes.badgeFailed : failover.state === 'success' ? classes.badgeSuccess : classes.badgeProgress}>
                  {failover.label}
               </span>
            ) : (
               summary.incomplete && <span>Redundancy incomplete</span>
            )}
         </button>
         {showMirrorDetails && (
            <MirrorDetails
               mirrors={mirrors}
               planId={planId}
               backupId={backupId}
               replicationSettings={replicationSettings}
               managedAgent={managedAgent}
               close={() => setShowMirrorDetails(false)}
            />
         )}
      </>
   );
};

export default MirrorStatusBadge;

import { ReactNode } from 'react';
import Icon from '../../common/Icon/Icon';
import StorageIcon from '../../common/Icon/StorageIcon';
import { Plan } from '../../../@types/plans';
import { useGetStorages } from '../../../services/storage';
import { formatIntervalDisplay, getBackupIconName } from '../../../utils/helpers';
import PlanHistory from '../PlanHistory/PlanHistory';
import PlanSizeChart from '../PlanSizeChart/PlanSizeChart';
import classes from './PlanStats.module.scss';
import PlanStorageInfo from '../PlanStorageInfo/PlanStorageInfo';
import { formatBytes, formatNumberToK } from '../../../utils/helpers';

interface PlanStatsProps {
   plan: Plan;
   isSync: boolean;
   lastBackupItem: any;
   storageAction?: ReactNode;
}

const PlanStats = ({ plan, isSync, lastBackupItem, storageAction }: PlanStatsProps) => {
   const { sourceConfig, storage, storagePath, isActive, settings } = plan;
   const { interval } = settings;
   const isStorageSource = plan.sourceType === 'storage';

   const { data: storageData } = useGetStorages();
   const sourceStorage = isStorageSource
      ? ((storageData?.result as { id: string; name: string; type: string }[]) || []).find((s) => s.id === plan.sourceId)
      : undefined;
   const sourceName = isStorageSource ? sourceStorage?.name || '' : plan.device?.name || '';

   const totalFiles = lastBackupItem?.totalFiles || 0;
   const totalSize = lastBackupItem?.totalSize || 0;

   const sourceTooltipHTML = (sources: Plan['sourceConfig']) => {
      let html = '';
      if (sources && sources.includes && sources.includes.length > 0) {
         html += `<div><strong>Includes</strong></div>`;
         html += sources.includes.map((p) => `<div>${sourceName} -> ${p}</div>`).join('');
      }
      if (sources && sources.excludes && sources.excludes.length > 0) {
         html += `<div><strong>Excludes</strong></div>`;
         html += sources.excludes.map((p) => `<div>${p}</div>`).join('');
      }
      return html;
   };

   return (
      <div className={classes.planStats}>
         <div className={classes.sources}>
            <div className={classes.widgetTitle}>
               <Icon type={getBackupIconName(plan.method, plan.sourceType)} size={12} /> {isSync ? 'Syncing' : 'Backing Up'}
            </div>
            <div className={classes.sourceContent}>
               <div data-tooltip-id="htmlToolTip" data-tooltip-place="top" data-tooltip-html={sourceTooltipHTML(sourceConfig)}>
                  {isStorageSource ? <StorageIcon type={sourceStorage?.type} size={18} /> : <Icon type="folders" size={18} />}
                  <span>{isStorageSource ? sourceName : `${sourceConfig?.includes.length} Sources`}</span>
               </div>
               <div
                  data-tooltip-id="htmlToolTip"
                  data-tooltip-place="top"
                  data-tooltip-html={isActive ? `${isSync ? 'Syncing' : 'Copying'} changes ${formatIntervalDisplay(interval)}` : 'Plan is Not Active'}
               >
                  <Icon type={isActive ? (isSync ? 'reload' : 'copy') : 'pause'} size={16} />
                  <div className={classes.sourceArrow}>→</div>
               </div>
               <PlanStorageInfo
                  disableTooltip={false}
                  inline={false}
                  replicationSettings={plan.settings.replication}
                  storage={storage}
                  storagePath={storagePath}
                  action={storageAction}
               />
            </div>
         </div>
         <div className={classes.snapshots}>
            <div className={classes.widgetTitle}>
               <Icon type="folders" size={12} /> Stats{' '}
               <span className={classes.widgetSubTitle}>
                  {formatNumberToK(totalFiles)} files <i>|</i> {formatBytes(totalSize)}
               </span>
            </div>
            <div className={classes.snapshotsContent}>
               <PlanSizeChart backups={plan.backups} />
            </div>
         </div>
         <div className={classes.health}>
            <div className={classes.widgetTitle}>
               <Icon type="speed" size={12} /> Health
            </div>
            <div className={classes.healthContent}>
               <PlanHistory planId={plan.id} history={plan.backups} itemsCount={90} />
            </div>
         </div>
      </div>
   );
};

export default PlanStats;

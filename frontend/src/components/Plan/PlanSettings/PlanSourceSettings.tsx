import classes from './PlanSettings.module.scss';
import PathPicker from '../../common/PathPicker/PathPicker';
import { NewPlanSettings } from '../../../@types/plans';
import { useGetDevices } from '../../../services/devices';
import { useGetStorages } from '../../../services/storage';
import Select from '../../common/form/Select/Select';
import StoragePicker from '../../common/form/StoragePicker/StoragePicker';
import { Device } from '../../../@types/devices';
import type { SourceAccessView } from '../../../@types/agentSourceAccess';
import RemoteSourcePicker from './RemoteSourcePicker';

interface PlanSourceSettingsProps {
   plan: NewPlanSettings;
   isEditing: boolean;
   onUpdate: (plan: NewPlanSettings) => void;
   error: string;
   sourceAccess?: SourceAccessView;
   sourceAccessError?: boolean;
   onDraftBlocked: (blocked: boolean) => void;
}

const PlanSourceSettings = ({ plan, onUpdate, error, isEditing, sourceAccess, sourceAccessError, onDraftBlocked }: PlanSourceSettingsProps) => {
   const { data } = useGetDevices();
   const { data: storageData } = useGetStorages();
   const isStorageSource = plan.sourceType === 'storage';
   const devices = (data?.success && data.result ? data.result : []) as Device[];
   const selectedDevice = devices.find((device) => device.id === plan.sourceId);
   const isRemoteFilesystemSource = Boolean(selectedDevice?.isRemote);
   const canUseRemoteFilesystem = (device: Device) =>
      device.isRemote === true &&
      device.agent?.status !== 'revoked' &&
      (device.agent?.capabilities?.filesystemRootsConfigured === true || device.agent?.capabilities?.sourceAccessVersion === 1) &&
      device.agent?.capabilities?.commandTypes?.includes('BACKUP_FILESYSTEM') === true &&
      Boolean(device.agent?.resticVersion && device.agent?.rcloneVersion);
   const deviceList = [];
   const deviceId = plan.sourceId || 'main';
   const selectDevice = (nextDeviceId: string) => {
      const nextDevice = devices.find((device) => device.id === nextDeviceId);
      const nextIsRemoteFilesystem = nextDevice?.isRemote === true;
      if (nextDeviceId !== deviceId) onDraftBlocked(false);
      onUpdate({
         ...plan,
         sourceId: nextDeviceId,
         ...(nextDeviceId !== deviceId ? { sourceConfig: { ...plan.sourceConfig, includes: [], excludes: [] } } : {}),
         ...(nextIsRemoteFilesystem
            ? {
                 settings: {
                    ...plan.settings,
                    // Replication runs on the server; arbitrary scripts never run on an agent.
                    scripts: undefined,
                 },
              }
            : {}),
      });
   };
   if (data?.success && data.result) {
      deviceList.push(
         ...devices.map((device: Device) => ({
            label: `${device.name} ${device.id === 'main' ? '(Main)' : device.isRemote ? (canUseRemoteFilesystem(device) ? '(Remote filesystem backup)' : '(Remote agent: backup unavailable)') : ''}`,
            value: device.id,
            icon: device.id === 'main' ? 'computer' : 'computer-remote',
            disabled: device.isRemote === true && !canUseRemoteFilesystem(device),
         })),
      );
   }

   if (isStorageSource) {
      const storages = (storageData?.result as { id: string; name: string }[]) || [];
      const sourceStorage = storages.find((s) => s.id === plan.sourceId);
      const prefix = sourceStorage ? `${sourceStorage.name}:` : '';
      const bakedPath = plan.sourceConfig.includes[0] || '';
      const sourcePath = prefix && bakedPath.startsWith(prefix) ? bakedPath.slice(prefix.length) : bakedPath;

      return (
         <div className={classes.field}>
            <label className={classes.label}>Source Storage*</label>
            {error && <span className={classes.fieldErrorLabel}>{error}</span>}
            <StoragePicker
               storageId={plan.sourceId}
               storagePath={sourcePath}
               deviceId="main"
               excludeStorageIds={plan.storage.id ? [plan.storage.id] : []}
               disabled={isEditing}
               disabledHint="The source storage can't be changed after a plan is created."
               onUpdate={(s) =>
                  onUpdate({
                     ...plan,
                     sourceId: s.storage.id,
                     sourceConfig: { ...plan.sourceConfig, includes: [s.path] },
                  })
               }
            />
         </div>
      );
   }

   return (
      <>
         <div className={classes.field}>
            <label className={classes.label}>Select Device*</label>
            <Select options={deviceList} fieldValue={deviceId} disabled={isEditing} full={true} onUpdate={selectDevice} />
         </div>
         {isRemoteFilesystemSource ? (
            <div className={classes.field}>
               {error && <span className={classes.fieldErrorLabel}>{error}</span>}
               <RemoteSourcePicker
                  key={deviceId}
                  deviceId={deviceId}
                  sourcePath={plan.sourceConfig.includes[0] || ''}
                  isEditing={isEditing}
                  access={sourceAccess}
                  accessError={sourceAccessError}
                  onDraftBlocked={onDraftBlocked}
                  onUpdate={(sourcePath) =>
                     onUpdate({
                        ...plan,
                        sourceConfig: { ...plan.sourceConfig, includes: sourcePath ? [sourcePath] : [] },
                     })
                  }
               />
            </div>
         ) : (
            <div className={classes.field}>
               <label className={classes.label}>Backup Sources*</label>
               {error && <span className={classes.fieldErrorLabel}>{error}</span>}
               <PathPicker
                  paths={{ includes: plan.sourceConfig.includes, excludes: plan.sourceConfig.excludes }}
                  onUpdate={(paths) => onUpdate({ ...plan, sourceConfig: { ...paths } })}
                  deviceId={deviceId}
                  single={plan.method === 'sync'}
                  disallowChange={plan.method === 'sync' && isEditing}
               />
            </div>
         )}
      </>
   );
};

export default PlanSourceSettings;

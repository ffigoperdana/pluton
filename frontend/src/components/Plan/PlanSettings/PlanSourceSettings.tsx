import { useEffect, useRef } from 'react';
import classes from './PlanSettings.module.scss';
import PathPicker from '../../common/PathPicker/PathPicker';
import { NewPlanSettings } from '../../../@types/plans';
import { useGetDevices } from '../../../services/devices';
import { useGetStorages } from '../../../services/storage';
import Select from '../../common/form/Select/Select';
import StoragePicker from '../../common/form/StoragePicker/StoragePicker';
import { Device } from '../../../@types/devices';

interface PlanSourceSettingsProps {
   plan: NewPlanSettings;
   isEditing: boolean;
   onUpdate: (plan: NewPlanSettings) => void;
   error: string;
}

const PlanSourceSettings = ({ plan, onUpdate, error, isEditing }: PlanSourceSettingsProps) => {
   const { data } = useGetDevices();
   const { data: storageData } = useGetStorages();
   const isStorageSource = plan.sourceType === 'storage';
   const deviceList = [];
   const deviceId = plan.sourceId || 'main';
   if (data?.success && data.result) {
      deviceList.push(
         ...data.result.map((device: Device) => ({
            label: `${device.name} ${device.id === 'main' ? '(Main)' : ''}`,
            value: device.id,
            icon: device.id === 'main' ? 'computer' : 'computer-remote',
            // disabled: device.id === 'main' || device.connected ? false : true,
         })),
      );
   }

   // When the device changes, reset the sourceConfig paths to prevent invalid paths from being submitted.
   // Use a ref to track the previous deviceId so we only reset on an actual change (not on mount/remount,
   // e.g. when navigating between steps in the Add Plan form).
   const prevDeviceIdRef = useRef<string | null>(null);
   useEffect(() => {
      if (isEditing || isStorageSource) {
         prevDeviceIdRef.current = deviceId;
         return;
      }
      if (prevDeviceIdRef.current !== null && prevDeviceIdRef.current !== deviceId) {
         onUpdate({
            ...plan,
            sourceConfig: {
               includes: [],
               excludes: [],
            },
         });
      }
      prevDeviceIdRef.current = deviceId;
   }, [isEditing, deviceId]);

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
            <Select
               options={deviceList}
               fieldValue={deviceId}
               disabled={isEditing}
               full={true}
               onUpdate={(val) => onUpdate({ ...plan, sourceId: val })}
            />
         </div>
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
      </>
   );
};

export default PlanSourceSettings;

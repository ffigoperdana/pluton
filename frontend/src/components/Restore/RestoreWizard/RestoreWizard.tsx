import { useMemo, useState } from 'react';
import { useIsFetching, useIsMutating } from '@tanstack/react-query';
import Icon from '../../common/Icon/Icon';
import classes from './RestoreWizard.module.scss';
import RestoreSettingsStep from './RestoreSettingsStep';
import RestorePreviewStep from './RestorePreviewStep';
import RestoreConfirmStep from './RestoreConfirmStep';
import { RestoredFileItem, RestoredItemsStats, RestoreFileItem, RestoreSettings } from '../../../@types/restores';
import { useGetSnapshotFiles } from '../../../services/backups';
import RestoreFileSelectorStep from './RestoreFileSelectorStep';
import { Backup, Plan } from '../../..';
import { restoreSelectionSummary } from '../../../utils/restoreSelection';
import ManagedSnapshotViewer from '../../Plan/SnapshotViewer/ManagedSnapshotViewer';

interface RestoreWizardProps {
   backupId: string;
   planId: string;
   deviceId: string;
   planStorage: Plan['storage'];
   mirrors?: Backup['mirrors'];
   stagingOnly?: boolean;
   close: () => void;
}

const RestoreWizard = ({ backupId, planId, deviceId, mirrors, planStorage, stagingOnly = false, close }: RestoreWizardProps) => {
   const [step, setStep] = useState(1);
   const [restoreSettings, setRestoreSettings] = useState<RestoreSettings>({
      type: 'original',
      path: '',
      overwrite: stagingOnly ? 'never' : 'always',
      includes: [],
      excludes: [],
      delete: false,
      storageId: undefined,
   });
   const [restorePreview, setRestorePreview] = useState<{ stats: RestoredItemsStats | null; files: RestoredFileItem[]; truncated?: boolean }>({
      stats: null,
      files: [],
   });
   const isFetching = useIsFetching();
   const isMutating = useIsMutating();
   const isLoading = isFetching > 0 || isMutating > 0;
   const { data: snapshotData, error: snapShotError } = useGetSnapshotFiles({ backupId, enabled: !stagingOnly });
   const files: RestoreFileItem[] = snapshotData?.result && Array.isArray(snapshotData.result) ? snapshotData.result : [];

   const snapShotsStats = useMemo(() => {
      const counts = restoreSelectionSummary(files, { includes: new Set(), excludes: new Set() });
      return {
         total_files: counts.totalFiles,
         total_bytes: counts.totalBytes,
      };
   }, [files]);

   return (
      <div className={classes.restoreWizard}>
         <div className={classes.content} style={{ maxWidth: ((step === 2 || step === 3) && 1200) || undefined }}>
            <div className={classes.header}>
               <h3>
                  <Icon type="restore" size={16} /> Restore Backup
               </h3>
               <button className={classes.close} onClick={() => !isLoading && close()}>
                  <Icon type="close" size={24} />
               </button>
            </div>
            <div className={classes.steps}>
               <ul>
                  <li className={` ${step >= 1 ? classes.stepCurrent : ''}  ${step > 1 ? classes.stepPassed : ''}`}>
                     <span>
                        {step > 1 && <Icon type="check" size={11} />}
                        {step === 1 ? '●' : ''}
                     </span>
                     <i>Settings</i>
                  </li>
                  <li className={` ${step >= 2 ? classes.stepCurrent : ''}  ${step > 2 ? classes.stepPassed : ''}`}>
                     <span>
                        {step > 2 && <Icon type="check" size={11} />}
                        {step === 2 ? '●' : ''}
                     </span>
                     <i>Select Files</i>
                  </li>
                  <li className={` ${step >= 3 ? classes.stepCurrent : ''} ${step > 3 ? classes.stepPassed : ''}`}>
                     <span>
                        {step > 3 && <Icon type="check" size={11} />}
                        {step === 3 ? '●' : ''}
                     </span>
                     <i>Preview</i>
                  </li>
                  <li className={` ${step === 4 ? classes.stepCurrent : ''}`}>
                     <span>{step === 4 && <Icon type="check" size={11} />}</span>
                     <i>Restore</i>
                  </li>
               </ul>
            </div>
            {step === 1 && (
               <RestoreSettingsStep
                  backupId={backupId}
                  deviceId={deviceId}
                  settings={restoreSettings}
                  primaryStorage={planStorage}
                  mirrors={mirrors}
                  stagingOnly={stagingOnly}
                  updateSettings={(settings) => setRestoreSettings(settings)}
                  goNext={() => setStep(2)}
                  close={close}
               />
            )}
            {step === 2 && stagingOnly && (
               <div className={classes.stepContent}>
                  <div className={classes.step} style={{ height: '60vh' }}>
                     <ManagedSnapshotViewer
                        backup={{ id: backupId, totalSize: 0 } as Backup}
                        planId={planId}
                        files={[]}
                        stagingOnly
                        onClose={close}
                        selection={{
                           includes: restoreSettings.includes || [],
                           excludes: restoreSettings.excludes || [],
                           onChange: (includes, excludes) => {
                              setRestoreSettings({ ...restoreSettings, includes, excludes });
                              setRestorePreview({ stats: null, files: [] });
                           },
                        }}
                     />
                  </div>
                  <div className={classes.footer}>
                     <button onClick={() => setStep(1)}>Back</button>
                     <button onClick={() => setStep(3)}>Next: Preview Restore</button>
                  </div>
               </div>
            )}
            {step === 2 && !stagingOnly && (
               <RestoreFileSelectorStep
                  backupId={backupId}
                  settings={restoreSettings}
                  updateSettings={(settings) => setRestoreSettings(settings as RestoreSettings)}
                  files={files}
                  isLoading={isLoading}
                  errorFetching={snapShotError?.message || null}
                  currentStep={step}
                  goBack={() => step > 0 && setStep(step - 1)}
                  goNext={() => setStep(3)}
                  close={close}
                  method="backup"
               />
            )}
            {step === 3 && (
               <RestorePreviewStep
                  stagingOnly={stagingOnly}
                  backupId={backupId}
                  planId={planId}
                  settings={restoreSettings}
                  preview={restorePreview}
                  updatePreview={(preview) => setRestorePreview(preview)}
                  goBack={() => step > 0 && setStep(step - 1)}
                  goNext={() => setStep(4)}
                  close={close}
               />
            )}
            {step === 4 && (
               <RestoreConfirmStep
                  stagingOnly={stagingOnly}
                  backupId={backupId}
                  planId={planId}
                  settings={restoreSettings}
                  stats={restorePreview.stats}
                  selectionCounts={restoreSelectionSummary(files, {
                     includes: new Set(restoreSettings.includes),
                     excludes: new Set(restoreSettings.excludes),
                  })}
                  snapshotsStats={snapShotsStats}
                  method="backup"
                  goBack={() => step > 0 && setStep(step - 1)}
                  close={close}
               />
            )}
         </div>
      </div>
   );
};

export default RestoreWizard;

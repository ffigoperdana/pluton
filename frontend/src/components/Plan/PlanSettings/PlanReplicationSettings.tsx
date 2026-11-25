import { useState, useCallback } from 'react';
import { PlanReplicationSettings as ReplicationSettings, PlanReplicationStorage } from '../../../@types/plans';
import Icon from '../../common/Icon/Icon';
import StoragePicker from '../../common/form/StoragePicker/StoragePicker';
import Toggle from '../../common/form/Toggle/Toggle';
import classes from '../../Plan/AddPlan/AddPlan.module.scss';
import mirrorClasses from './PlanReplicationSettings.module.scss';
import ActionModal from '../../common/ActionModal/ActionModal';
import { useDeleteReplicationStorage } from '../../../services';
import { toast } from 'react-toastify';
import { nanoid } from 'nanoid';
import {
   MAX_REPLICATION_DESTINATIONS,
   needsReplicationOffConfirmation,
   replicationOffNotice,
   replicationSettingsError,
} from '../../../utils/replication';
import DeleteDependencyNotice from '../../common/ActionModal/DeleteDependencyNotice';
import { AGENT_S3_STORAGE_TYPES, managedReplicaStorageTypes } from '../../../utils/agentRepository';
import { APP_NAME } from '../../../utils/brand';

interface PlanReplicationSettingsProps {
   replication?: ReplicationSettings;
   primaryStorageId: string;
   primaryStoragePath?: string;
   /** Storage type of the primary; a Managed Agent replica uses the other type (S3 or SFTP). */
   primaryStorageType?: string;
   deviceId: string;
   excludeStorageIds?: string[];
   isEditing?: boolean;
   planID?: string;
   maxReplications?: number;
   managedAgent?: boolean;
   /** Set when replication cannot be used for this primary. */
   unavailableReason?: string;
   onUpdate: (replication: ReplicationSettings) => void;
}

const defaultReplication: ReplicationSettings = {
   enabled: false,
   concurrent: false,
   storages: [],
};

const PlanReplicationSettings = ({
   replication,
   primaryStorageId,
   primaryStoragePath,
   primaryStorageType,
   deviceId,
   excludeStorageIds,
   isEditing = false,
   planID,
   maxReplications: maxReplicationsProp,
   managedAgent = false,
   unavailableReason,
   onUpdate,
}: PlanReplicationSettingsProps) => {
   const [tempStorages, setTempStorages] = useState<PlanReplicationStorage[]>([]);
   const [removeStorageData, setRemoveStorageData] = useState<boolean>(false);
   const [showRemoveModal, setShowRemoveModal] = useState<boolean | PlanReplicationStorage>(false);
   const [confirmOff, setConfirmOff] = useState(false);

   const deleteStorageMutation = useDeleteReplicationStorage();
   const settings = replication || defaultReplication;
   const maxReplications = Math.min(MAX_REPLICATION_DESTINATIONS, maxReplicationsProp ?? MAX_REPLICATION_DESTINATIONS);
   const validationError = replicationSettingsError(
      settings,
      { storageId: primaryStorageId, storagePath: primaryStoragePath || '', storageType: primaryStorageType },
      managedAgent,
   );
   /** S3 replicas for an SFTP primary, SFTP replicas for an S3 primary (S3_PRIMARY_REPLICATION.md). */
   // Until the primary type is known (storages still loading) the established S3 replica flow applies.
   const replicaStorageTypes = managedAgent
      ? primaryStorageType
         ? managedReplicaStorageTypes(primaryStorageType)
         : AGENT_S3_STORAGE_TYPES
      : undefined;
   /** Either failover policy needs at least one compatible replica; the server re-validates identity and ownership. */
   const failoverReplicas =
      settings.storages.length > 0 && settings.storages.every((storage) => (replicaStorageTypes || []).includes(storage.storageType));

   /** Check if a storage+path combination already exists in committed or temp storages */
   const isDuplicateStorage = useCallback(
      (storageId: string, storagePath: string, excludeCommittedIndex?: number, excludeTempIndex?: number) => {
         // Skip duplicate check if storageId or storagePath is empty (incomplete selection)
         if (!storageId || !storagePath) return false;
         const committedDuplicate = settings.storages.some(
            (s, i) =>
               (excludeCommittedIndex === undefined || i !== excludeCommittedIndex) && s.storageId === storageId && s.storagePath === storagePath,
         );
         const tempDuplicate = tempStorages.some(
            (s, i) => (excludeTempIndex === undefined || i !== excludeTempIndex) && s.storageId === storageId && s.storagePath === storagePath,
         );
         return committedDuplicate || tempDuplicate;
      },
      [settings.storages, tempStorages],
   );

   const applyEnabled = (enabled: boolean) => {
      onUpdate({ ...settings, enabled, ...(!enabled && { recoveryPolicy: 'primary-only', backupFailover: 'off' }) });
   };

   const updateEnabled = (enabled: boolean) => {
      if (needsReplicationOffConfirmation(settings, enabled, isEditing && !!planID)) {
         setConfirmOff(true);
         return;
      }
      applyEnabled(enabled);
   };

   const updateConcurrent = (concurrent: boolean) => {
      onUpdate({ ...settings, concurrent });
   };

   const addReplicationStorage = () => {
      if (isEditing) {
         if (settings.storages.length + tempStorages.length >= maxReplications) return;
         setTempStorages([...tempStorages, { replicationId: nanoid(), storageId: '', storagePath: '', storageType: '', addedAt: Date.now() }]);
      } else {
         if (settings.storages.length >= maxReplications) return;
         onUpdate({
            ...settings,
            storages: [...settings.storages, { replicationId: nanoid(), storageId: '', storagePath: '', storageType: '', addedAt: Date.now() }],
         });
      }
   };

   const updateTempStorage = (index: number, storage: PlanReplicationStorage) => {
      setTempStorages((prev) => {
         const updated = [...prev];
         updated[index] = storage;
         return updated;
      });
   };

   const confirmAddStorage = (index: number) => {
      const storage = tempStorages[index];
      if (!storage.storageId || (managedAgent && !storage.storagePath.trim()) || settings.storages.length >= maxReplications) return;
      if (storage.storageId === primaryStorageId && storage.storagePath === primaryStoragePath) {
         toast.error('Cannot replicate to the same storage as the primary backup.');
         return;
      }
      if (isDuplicateStorage(storage.storageId, storage.storagePath, undefined, index)) {
         toast.error('This storage destination is already added.');
         return;
      }
      setTempStorages((prev) => prev.filter((_, i) => i !== index));
      onUpdate({ ...settings, storages: [...settings.storages, storage] });
   };

   const removeTempStorage = (index: number) => {
      setTempStorages((prev) => prev.filter((_, i) => i !== index));
   };

   const updateReplicationStorage = (index: number, storage: PlanReplicationStorage) => {
      const updated = [...settings.storages];
      updated[index] = storage;
      onUpdate({ ...settings, storages: updated });
   };

   const removeAddedStorage = (index: number) => {
      const updated = settings.storages.filter((_, i) => i !== index);
      onUpdate({ ...settings, storages: updated });
   };

   const removeReplicationStorage = () => {
      if (deleteStorageMutation.isPending) return;
      if (typeof showRemoveModal === 'object' && planID) {
         const storageToRemove = showRemoveModal;
         deleteStorageMutation.mutate(
            {
               planID: planID,
               storageID: storageToRemove.storageId,
               removeData: managedAgent ? false : removeStorageData,
               storagePath: storageToRemove.storagePath,
               replicationId: storageToRemove.replicationId,
            },
            {
               onSuccess: () => {
                  // Remove the storage from local state and close modal
                  const updated = settings.storages.filter((s) => s.replicationId !== storageToRemove.replicationId);
                  onUpdate({
                     ...settings,
                     storages: updated,
                     ...(updated.length === 0 && { enabled: false, recoveryPolicy: 'primary-only' as const, backupFailover: 'off' as const }),
                  });
                  setShowRemoveModal(false);
                  setRemoveStorageData(false);
                  deleteStorageMutation.reset();
               },
            },
         );
      }
   };

   const openRemoveModal = (mirror: PlanReplicationStorage) => {
      setRemoveStorageData(false);
      deleteStorageMutation.reset();
      setShowRemoveModal(mirror);
   };

   return (
      <div className={classes.field}>
         <div className={mirrorClasses.mirrorSection}>
            <Toggle
               label="Enable Replication"
               description="Copy verified snapshots to up to two additional repositories. Primary backup success and replica success are tracked separately."
               fieldValue={unavailableReason ? false : settings.enabled}
               disabled={Boolean(unavailableReason)}
               onUpdate={updateEnabled}
            />

            {unavailableReason && <p className={classes.fieldNotice}>{unavailableReason}</p>}

            {!unavailableReason && settings.enabled && (
               <div className={mirrorClasses.mirrorSettings}>
                  <p className={classes.fieldNotice}>
                     Replication runs sequentially by default. Use a dedicated repository path for each destination.
                     {managedAgent && ` The ${APP_NAME} server performs the copy; the source Agent does not receive replica credentials, except during a failover backup.`}
                  </p>
                  {validationError && (
                     <p role="alert" className={mirrorClasses.validationError}>
                        {validationError}
                     </p>
                  )}
                  {managedAgent && (
                     <fieldset className={mirrorClasses.recoveryPolicy}>
                        <legend>Recovery &amp; Failover</legend>
                        <label>
                           Recovery source policy
                           <select
                              value={settings.recoveryPolicy || 'primary-only'}
                              onChange={(event) =>
                                 onUpdate({ ...settings, recoveryPolicy: event.target.value as 'primary-only' | 'assisted' | 'automatic' })
                              }
                           >
                              <option value="primary-only">Primary Only (default)</option>
                              <option value="assisted" disabled={!failoverReplicas}>
                                 Assisted Failover (optional, recommended with verified replicas)
                              </option>
                              <option value="automatic" disabled={!failoverReplicas}>
                                 Automatic Failover (verified replica chosen automatically)
                              </option>
                           </select>
                        </label>
                        <p>
                           {settings.recoveryPolicy === 'automatic'
                              ? `Recovery starts on the primary repository. If it is unreachable, ${APP_NAME} continues automatically with the first replica that passes identity and integrity checks, restoring only into isolated staging. Selecting this does not prove a replica is recoverable, and nothing is restored to production or imported into a database automatically.`
                              : settings.recoveryPolicy === 'assisted'
                                ? 'Prefer the primary repository. A verified replica requires your explicit approval and restores only into isolated staging. Database import keeps its existing separate approval.'
                                : 'Recovery uses the primary repository only. Choose a failover policy to allow verified replicas as a recovery source.'}
                        </p>
                        <label>
                           Backup failover
                           <select
                              value={settings.backupFailover || 'off'}
                              onChange={(event) => onUpdate({ ...settings, backupFailover: event.target.value as 'off' | 'automatic' })}
                           >
                              <option value="off">Off (default)</option>
                              <option value="automatic" disabled={!failoverReplicas}>
                                 Automatic (write to a verified replica while the primary is down)
                              </option>
                           </select>
                        </label>
                        <p>
                           {settings.backupFailover === 'automatic'
                              ? `When a backup fails before upload because the primary is unreachable, and the ${APP_NAME} server cannot reach it either, the Agent writes a new backup into the first verified replica it can reach. ${APP_NAME} verifies it there and copies it back to the primary once the primary is reachable. During that run the Agent receives the replica storage credentials, sealed. An outage during an upload is not detected; that run fails and the next one fails over. Requires Agent 0.8.0 or later.`
                              : 'Backups use the primary repository only. A backup fails while the primary is unreachable.'}
                        </p>
                     </fieldset>
                  )}

                  {settings.storages.map((mirror, index) => (
                     <div key={mirror.addedAt || index} className={mirrorClasses.mirrorDestination}>
                        <div className={mirrorClasses.mirrorHeader}>
                           <label className={classes.label}>Replication Destination {index + 1}</label>
                           <div className={mirrorClasses.mirrorHeaderRight}>
                              {settings.storages.length > 1 && (
                                 <div className={mirrorClasses.storagePositionControls}>
                                    <button
                                       title="Move Up"
                                       disabled={index === 0}
                                       onClick={() => {
                                          const updatedStorages = [...(settings.storages || [])];
                                          const [movedStorage] = updatedStorages.splice(index, 1);
                                          updatedStorages.splice(index - 1, 0, movedStorage);
                                          onUpdate({ ...settings, storages: updatedStorages });
                                       }}
                                    >
                                       <Icon type={'caret-up'} size={14} />
                                    </button>
                                    <button
                                       title="Move Down"
                                       disabled={index === settings.storages.length - 1}
                                       onClick={() => {
                                          const updatedStorages = [...(settings.storages || [])];
                                          const [movedStorage] = updatedStorages.splice(index, 1);
                                          updatedStorages.splice(index + 1, 0, movedStorage);
                                          onUpdate({ ...settings, storages: updatedStorages });
                                       }}
                                    >
                                       <Icon type={'caret-down'} size={14} />
                                    </button>
                                 </div>
                              )}
                              <button
                                 className={mirrorClasses.removeBtn}
                                 onClick={() => (isEditing ? openRemoveModal(mirror) : removeAddedStorage(index))}
                                 title="Remove replication destination"
                              >
                                 <Icon type="trash" size={14} /> Remove
                              </button>
                           </div>
                        </div>
                        <StoragePicker
                           storagePath={mirror.storagePath}
                           storageId={mirror.storageId}
                           deviceId={deviceId}
                           excludeStorageIds={excludeStorageIds}
                           allowedStorageTypes={replicaStorageTypes}
                           requirePath={managedAgent}
                           disabled={isEditing}
                           onUpdate={(s) => {
                              if (s.storage.id === primaryStorageId && s.path === primaryStoragePath) {
                                 toast.error('Cannot replicate to the same storage as the primary backup.');
                                 return;
                              }
                              updateReplicationStorage(index, {
                                 replicationId: mirror.replicationId,
                                 storageId: s.storage.id,
                                 storagePath: s.path,
                                 storageType: s.storage.type,
                                 storageName: s.storage.name,
                                 addedAt: mirror.addedAt,
                              });
                           }}
                        />
                     </div>
                  ))}

                  {isEditing &&
                     tempStorages.map((tempStorage, index) => (
                        <div key={tempStorage.addedAt} className={mirrorClasses.mirrorDestination}>
                           <div className={mirrorClasses.mirrorHeader}>
                              <label className={classes.label}>Replication Destination {settings.storages.length + index + 1}</label>
                              <div className={mirrorClasses.mirrorHeaderRight}>
                                 <button
                                    className={mirrorClasses.confirmBtn}
                                    onClick={() => confirmAddStorage(index)}
                                    disabled={!tempStorage.storageId || (managedAgent && !tempStorage.storagePath.trim())}
                                    title={!tempStorage.storageId ? 'Select Storage Type to add the storage' : 'Confirm replication destination'}
                                 >
                                    <Icon type="check" size={11} /> Confirm
                                 </button>
                                 <button
                                    className={mirrorClasses.removeBtn}
                                    onClick={() => removeTempStorage(index)}
                                    title="Remove replication destination"
                                 >
                                    <Icon type="trash" size={14} /> Remove
                                 </button>
                              </div>
                           </div>
                           <StoragePicker
                              storagePath={tempStorage.storagePath}
                              storageId={tempStorage.storageId}
                              deviceId={deviceId}
                              excludeStorageIds={excludeStorageIds}
                              allowedStorageTypes={replicaStorageTypes}
                              requirePath={managedAgent}
                              disabled={false}
                              onUpdate={(s) => {
                                 updateTempStorage(index, {
                                    replicationId: tempStorage.replicationId,
                                    storageId: s.storage.id,
                                    storagePath: s.path,
                                    storageType: s.storage.type,
                                    storageName: s.storage.name,
                                    addedAt: tempStorage.addedAt,
                                 });
                              }}
                           />
                        </div>
                     ))}

                  {settings.storages.length + (isEditing ? tempStorages.length : 0) < maxReplications && (
                     <button className={mirrorClasses.addMirrorBtn} onClick={addReplicationStorage}>
                        <Icon type="plus" size={12} /> + Add Replication Destination
                     </button>
                  )}

                  {managedAgent && <p>Managed copies are serialized on the {APP_NAME} server to bound resource use.</p>}
                  {settings.storages.length > 1 && !managedAgent && (
                     <div className={mirrorClasses.concurrentOption}>
                        <Toggle
                           label="Run replications concurrently"
                           description="Run replications in parallel to speed up the backup process"
                           fieldValue={settings.concurrent}
                           onUpdate={updateConcurrent}
                        />
                     </div>
                  )}
               </div>
            )}
         </div>

         {confirmOff && (
            <ActionModal
               title="Turn Off Replication?"
               message={
                  <div>
                     <ul className={mirrorClasses.offNotice}>
                        {replicationOffNotice(managedAgent).map((line) => (
                           <li key={line}>{line}</li>
                        ))}
                     </ul>
                     <p>The change takes effect when you save the plan.</p>
                  </div>
               }
               closeModal={() => setConfirmOff(false)}
               width="440px"
               secondaryAction={{ title: 'Keep Replication On', action: () => setConfirmOff(false) }}
               primaryAction={{
                  title: 'Turn Off Replication',
                  type: 'danger',
                  isPending: false,
                  action: () => {
                     applyEnabled(false);
                     setConfirmOff(false);
                  },
               }}
            />
         )}
         {showRemoveModal && (
            <ActionModal
               title="Detach Replication Destination"
               message={
                  <div>
                     <p>
                        {managedAgent
                           ? 'Detach this destination and retain its remote repository? Physical cleanup of managed replicas is unavailable in this release.'
                           : 'Detach this destination from the plan? Its remote repository is retained unless you explicitly select cleanup below.'}
                     </p>
                     <p>
                        Retained data is no longer updated by this plan. Cleanup requires an exact owned repository path; shared or uncertain scopes
                        are refused.
                     </p>
                     {!managedAgent && (
                        <Toggle
                           fieldValue={removeStorageData}
                           disabled={deleteStorageMutation.isPending}
                           onUpdate={() => setRemoveStorageData((prev) => !prev)}
                           description="Permanently delete this destination's owned repository data"
                           customClasses={classes.removeRemoteToggle}
                        />
                     )}
                  </div>
               }
               closeModal={() => {
                  if (!deleteStorageMutation.isPending) {
                     setShowRemoveModal(false);
                     setRemoveStorageData(false);
                     deleteStorageMutation.reset();
                  }
               }}
               width="400px"
               errorMessage={deleteStorageMutation.error ? <DeleteDependencyNotice error={deleteStorageMutation.error} /> : undefined}
               primaryAction={{
                  title: removeStorageData ? 'Delete Owned Data and Detach' : 'Detach and Retain Data',
                  type: 'danger',
                  icon: 'trash',
                  isPending: deleteStorageMutation.isPending,
                  action: () => removeReplicationStorage(),
               }}
            />
         )}
      </div>
   );
};

export default PlanReplicationSettings;

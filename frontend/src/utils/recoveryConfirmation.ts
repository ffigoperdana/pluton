import type { RecoveryPreparation, RecoverySelection, RecoveryEngine } from '../@types/recoveryTests';

export function initialRecoverySelection(preview: RecoveryPreparation): RecoverySelection {
   return { databaseImport: preview.policy.databaseImport, targetModes: { ...preview.policy.targetModes } };
}
export function recoveryDestinationStatus(preview: RecoveryPreparation, selection: RecoverySelection, engine?: RecoveryEngine) {
   if (selection.databaseImport === 'disabled') return 'SQL import NOT TESTED — artifact integrity only';
   if (!engine) return 'Engine metadata missing — native import unavailable';
   const internal = engine !== 'mysql' && selection.targetModes?.[engine] === 'internal';
   if (internal) {
      const target = preview.internalTargets.find((view) => view.engine === engine);
      if (target?.status !== 'ready') return target?.status === 'cleanup_required' ? 'Cleanup Required' : 'Not Provisioned / unavailable';
      if (target.admission?.status !== 'admitted') return `Insufficient Resources / ${target.admission?.reason || 'capacity-unknown'}`;
      return target.mode === 'automatic'
         ? 'Ready to provision — automatic provisioning and verified disposable cleanup; execution checks again'
         : 'Ready — operator-managed; execution checks again';
   }
   if (!preview.customTargets.some((target) => target.engine === engine && target.status === 'configured')) return 'Not Configured';
   if (engine === 'mysql' && preview.mysqlWorker !== 'ready') return 'Worker Unavailable';
   return 'Configured — TLS, guard, permissions and compatibility checked at execution';
}
export function canConfirmRecovery(preview: RecoveryPreparation, selection: RecoverySelection, acknowledged: boolean) {
   if (!acknowledged) return false;
   if (preview.policy.databaseImport === 'required' && selection.databaseImport !== 'required') return false;
   if (selection.databaseImport === 'disabled') return true;
   if (Object.values(preview.workloads).some(Boolean)) return false;
   const internalEngines = new Set(
      preview.databases
         .filter((entry) => entry.engine && entry.engine !== 'mysql' && selection.targetModes?.[entry.engine] === 'internal')
         .map((entry) => entry.engine),
   );
   return (
      internalEngines.size <= 1 &&
      preview.databases.every(
         (entry) => !!entry.engine && !!entry.database && /^(Ready|Configured)/.test(recoveryDestinationStatus(preview, selection, entry.engine)),
      )
   );
}
export function recoveryConfirmationBody(preview: RecoveryPreparation, selection: RecoverySelection) {
   return {
      backupId: preview.backupId,
      snapshotId: preview.snapshotId,
      metadataToken: preview.metadataToken,
      resourcesAcknowledged: true as const,
      selection: {
         databaseImport: selection.databaseImport,
         targetModes: { mariadb: selection.targetModes?.mariadb || 'custom', postgresql: selection.targetModes?.postgresql || 'custom' },
      },
   };
}

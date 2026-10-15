import type { RecoveryPreparation, RecoveryEngine } from './recoveryTests';

export type RestoreSelection = { planId: string; backupId: string; snapshotId: string };
export type RestorePreview = RestoreSelection & {
   planTitle: string;
   repositoryId: string;
   metadataToken: string;
   databases: RecoveryPreparation['databases'];
   resources: RecoveryPreparation['resources'];
   targets: {
      id: string;
      engine: RecoveryEngine;
      database: string;
      mode: 'custom';
      maxRetentionSeconds: number;
      maxSqlBytes: number;
      quotaBytes: number;
   }[];
   engines: Record<RecoveryEngine, ('internal' | 'custom')[]>;
   internalPolicy: { maxSqlBytes: number; maxRetentionSeconds: number };
   retentionSeconds: number[];
   workloadBusy: boolean;
   warnings: string[];
};
export type RestoreChoice = {
   databaseId: string;
   mode: 'internal' | 'custom';
   targetId: string;
   ttlSeconds: number;
   resources: boolean;
   security: boolean;
};
export type DatabaseRestoreView = RestoreSelection & {
   id: string;
   purpose: string;
   repositoryId: string;
   databaseId: string;
   engine: RecoveryEngine;
   logicalDatabase: string;
   sqlBytes: number;
   sha256: string;
   mode: 'internal' | 'custom';
   targetId: string;
   database: string | null;
   status:
      | 'provisioning_required'
      | 'queued'
      | 'importing'
      | 'active'
      | 'stopped'
      | 'expired'
      | 'deleting'
      | 'cleanup_required'
      | 'deleted'
      | 'failed'
      | 'cancelled';
   stage: string;
   cleanup: string;
   createdAt: number;
   expiresAt: number;
   lastValidatedAt: number | null;
   errorCode: string | null;
   expired: boolean;
   cancelRequested: boolean;
   operatorAction: boolean;
   inspection: null | {
      engine: RecoveryEngine;
      version: string;
      database: string;
      tables: number;
      views: number;
      bytes: number | null;
      observedAt: number;
      catalogTruncated: boolean;
      catalog: { schema: string; name: string; type: string }[];
   };
};

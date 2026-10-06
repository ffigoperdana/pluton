export type RecoveryEngine = 'mariadb' | 'mysql' | 'postgresql';
export type RecoveryPolicy = { enabled: boolean; databaseImport: 'disabled' | 'required' };
export type RecoveryTarget = {
   engine: RecoveryEngine;
   host: string;
   port: number;
   username: string;
   tls: 'local' | 'verify-identity';
   enabled: boolean;
   dedicated: true;
   passwordConfigured: boolean;
};
export type RecoveryTest = {
   id: string;
   planId: string;
   backupId: string;
   snapshotId: string;
   status: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'passed_with_warning';
   trigger: 'manual' | 'after_backup';
   createdAt: string;
   startedAt?: string;
   completedAt?: string;
   failureStage?: string;
   failureCode?: string;
   warnings: { stage: string; code: string }[];
   result?: {
      filesystem?: { files: number; bytes: number; sourceTrees: number; integrity: string };
      databases: {
         databaseId?: string;
         engine?: RecoveryEngine;
         database?: string;
         path: string;
         bytes: number;
         sha256: string;
         artifactValidation: string;
         importValidation: string;
         failureCode?: string;
         tables?: number;
         views?: number;
      }[];
      cleanup: { workspace: boolean; databases: boolean };
   };
};

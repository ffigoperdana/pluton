export type RelocationStatus =
   | 'copying'
   | 'verifying'
   | 'ready'
   | 'switched'
   | 'reverted'
   | 'failed'
   | 'cancelled'
   | 'source-deleted';

export type RelocationOperation = 'switching' | 'reverting' | 'deleting-source';

export interface RelocationLocationView {
   storageId: string;
   storageName?: string;
   storagePath: string;
}

export interface PlanRelocation {
   id: string;
   planId: string;
   repositoryId: string;
   source: RelocationLocationView;
   destination: RelocationLocationView;
   status: RelocationStatus;
   phase: string;
   planWasActive: boolean;
   failureCode?: string;
   progress?: {
      totalFiles?: number;
      totalBytes?: number;
      copiedBytes?: number;
      copyTotalBytes?: number;
      copiedFiles?: number;
      copyTotalFiles?: number;
      verifiedFiles?: number;
   };
   evidence?: {
      repositoryConfigId: string;
      fileCount: number;
      totalBytes: number;
      listingDigest: string;
      snapshotCount: number;
   };
   createdAt: number;
   updatedAt: number;
   verifiedAt?: number;
   switchedAt?: number;
   revertedAt?: number;
   sourceDeletedAt?: number;
   operation?: RelocationOperation;
   lastOperationFailure?: { operation: string; code: string; at: number };
   actions: { cancel: boolean; switch: boolean; revert: boolean; deleteSource: boolean };
   audit: { at: number; event: string; code?: string; phase?: string }[];
}

export interface PlanRelocationOverview {
   supported: boolean;
   canStart: boolean;
   current: { storageId: string | null; storagePath: string | null };
   relocations: PlanRelocation[];
}

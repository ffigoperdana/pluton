/** Stage 4 replica promotion (docs/PRIMARY_PROMOTION.md). */
export type PromotionStatus = 'catching-up' | 'switching' | 'switched' | 'failed' | 'cancelled';

/** A backup the replica could not receive. It stays in the previous primary. */
export interface PromotionLeftBehind {
   backupId: string;
   code: string;
   /** Restorable from the previous primary through Verified Replica Recovery. */
   restorable?: boolean;
}

export interface PrimaryPromotion {
   id: string;
   planId: string;
   replicationId: string;
   previousStorageId: string;
   previousStoragePath: string;
   previousStorageName?: string;
   promotedStorageId: string;
   promotedStoragePath: string;
   promotedStorageName?: string;
   status: PromotionStatus;
   planWasActive: boolean | null;
   totalBackups: number;
   copiedBackups: number;
   retried: string[];
   leftBehind: PromotionLeftBehind[];
   lastErrorCode: string | null;
   createdAt: number;
   updatedAt: number;
   switchedAt: number | null;
   actions: { cancel: boolean };
}

export interface PromotionReplica {
   replicationId: string;
   storageId: string;
   storageName: string;
   storageType: string;
   storagePath: string;
   eligible: boolean;
   reason?: string;
}

export interface PrimaryPromotionOverview {
   supported: boolean;
   reason?: string;
   replicas: PromotionReplica[];
   active?: PrimaryPromotion;
   history: PrimaryPromotion[];
}

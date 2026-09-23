export type LegacyRepositoryValidationStatus = 'unknown' | 'available' | 'unavailable';

export interface LegacyRepository {
   id: string;
   displayName: string;
   repositoryPath: string;
   backend: 'local';
   isReadOnly: true;
   validationStatus: LegacyRepositoryValidationStatus;
   lastValidatedAt: string | null;
   createdAt: string;
   updatedAt: string | null;
}

export interface LegacyRepositorySnapshot {
   id: string;
   shortId: string;
   time: string;
   hostname: string;
   tags: string[];
   paths: string[];
   parent?: string;
}

export interface LegacyRepositorySnapshotFilters {
   tag?: string;
   path?: string;
   host?: string;
}

export interface LegacyRepositoryStats {
   totalSize: number;
   totalUncompressedSize: number;
   compressionRatio: number;
   totalBlobCount: number;
   snapshotCount: number;
}

export interface LegacyRepositoryRegistration {
   displayName: string;
   repositoryPath: string;
   password: string;
}

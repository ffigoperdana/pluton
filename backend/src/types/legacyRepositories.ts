import type {
	LegacyRepository,
	LegacyRepositoryBackend,
	LegacyRepositoryValidationStatus,
} from '../db/schema/legacyRepositories';

export type LegacyRepositoryPublic = Omit<LegacyRepository, 'encryptedPassword'>;

export type LegacyRepositoryRegistration = {
	displayName: string;
	repositoryPath: string;
	password: string;
};

export type LegacyRepositorySnapshot = {
	id: string;
	shortId: string;
	time: string;
	hostname: string;
	tags: string[];
	paths: string[];
	parent?: string;
};

export type LegacyRepositorySnapshotFilters = {
	tag?: string;
	path?: string;
	host?: string;
};

export type LegacyRepositoryStats = {
	totalSize: number;
	totalUncompressedSize: number;
	compressionRatio: number;
	totalBlobCount: number;
	snapshotCount: number;
};

export type LegacyRepositoryConnectionStatus = {
	validationStatus: LegacyRepositoryValidationStatus;
	lastValidatedAt: Date | null;
};

export type { LegacyRepositoryBackend, LegacyRepositoryValidationStatus };

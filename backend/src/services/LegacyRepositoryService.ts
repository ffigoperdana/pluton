import path from 'path';
import Cryptr from 'cryptr';
import { z } from 'zod';
import { configService } from './ConfigService';
import { LegacyRepositoryStore } from '../stores/LegacyRepositoryStore';
import type { LegacyRepository } from '../db/schema/legacyRepositories';
import { AppError, NotFoundError } from '../utils/AppError';
import { generateUID } from '../utils/helpers';
import {
	LegacyRepositoryInspectionError,
	LegacyResticInspectionClient,
	ResticLegacyRepositoryInspector,
} from '../utils/restic/LegacyRepositoryInspector';
import type {
	LegacyRepositoryConnectionStatus,
	LegacyRepositoryPublic,
	LegacyRepositoryRegistration,
	LegacyRepositorySnapshot,
	LegacyRepositorySnapshotFilters,
	LegacyRepositoryStats,
} from '../types/legacyRepositories';

const registrationSchema = z
	.object({
		displayName: z.string().trim().min(1).max(100),
		repositoryPath: z.string().trim().min(1).max(1024),
		password: z.string().min(1).max(4096),
	})
	.strict();

const snapshotFiltersSchema = z
	.object({
		tag: z.string().trim().min(1).max(256).optional(),
		path: z.string().trim().min(1).max(1024).optional(),
		host: z.string().trim().min(1).max(256).optional(),
	})
	.strict();

const fullSnapshotId = /^[a-fA-F0-9]{64}$/;

/**
 * Keeps imported Restic repositories apart from Pluton's managed plans.
 * The only repository interactions available here are through the dedicated
 * inspection client; there is no backup, retention, restore, or lock cleanup path.
 */
export class LegacyRepositoryService {
	constructor(
		private readonly repositoryStore: LegacyRepositoryStore,
		private readonly inspector: LegacyResticInspectionClient = new ResticLegacyRepositoryInspector()
	) {}

	async register(input: unknown): Promise<LegacyRepositoryPublic> {
		const parsed = registrationSchema.safeParse(input);
		if (!parsed.success) {
			throw new AppError(400, 'A display name, absolute repository path, and repository password are required.');
		}

		const registration = this.validateRegistration(parsed.data);
		await this.inspectRegistration(registration.repositoryPath, registration.password);

		const created = await this.repositoryStore.create({
			id: generateUID(),
			displayName: registration.displayName,
			repositoryPath: registration.repositoryPath,
			backend: 'local',
			encryptedPassword: this.encryptPassword(registration.password),
			isReadOnly: true,
			validationStatus: 'available',
			lastValidatedAt: new Date(),
		});

		if (!created) {
			throw new AppError(500, 'Could not save the legacy repository registration.');
		}

		return this.toPublic(created);
	}

	async getAll(): Promise<LegacyRepositoryPublic[]> {
		const repositories = await this.repositoryStore.getAll();
		return repositories.map(repository => this.toPublic(repository));
	}

	async getById(id: string): Promise<LegacyRepositoryPublic> {
		return this.toPublic(await this.getStoredRepository(id));
	}

	async validate(id: string): Promise<LegacyRepositoryConnectionStatus> {
		const repository = await this.getStoredRepository(id);
		await this.inspectRepository(repository);
		const updated = await this.repositoryStore.updateValidationStatus(id, 'available');
		return {
			validationStatus: updated?.validationStatus || 'available',
			lastValidatedAt: updated?.lastValidatedAt || new Date(),
		};
	}

	async listSnapshots(id: string, filters: unknown = {}): Promise<LegacyRepositorySnapshot[]> {
		const parsedFilters = snapshotFiltersSchema.safeParse(filters);
		if (!parsedFilters.success) {
			throw new AppError(400, 'Snapshot filters must be non-empty text values.');
		}

		const snapshots = await this.inspectRepository(await this.getStoredRepository(id));
		await this.repositoryStore.updateValidationStatus(id, 'available');
		return this.filterSnapshots(snapshots, parsedFilters.data);
	}

	async getSnapshot(id: string, snapshotId: string): Promise<LegacyRepositorySnapshot> {
		if (!fullSnapshotId.test(snapshotId)) {
			throw new AppError(400, 'A full snapshot ID is required.');
		}
		const snapshots = await this.listSnapshots(id);
		const snapshot = snapshots.find(candidate => candidate.id.toLowerCase() === snapshotId.toLowerCase());
		if (!snapshot) {
			throw new NotFoundError('Snapshot not found.');
		}
		return snapshot;
	}

	async getStats(id: string): Promise<LegacyRepositoryStats> {
		const repository = await this.getStoredRepository(id);
		try {
			const stats = await this.inspector.getRepositoryStats(
				repository.repositoryPath,
				this.decryptPassword(repository)
			);
			await this.repositoryStore.updateValidationStatus(id, 'available');
			return stats;
		} catch (error) {
			await this.markUnavailable(id);
			throw this.toSafeInspectionError(error);
		}
	}

	async deleteRegistration(id: string): Promise<void> {
		await this.getStoredRepository(id);
		const deleted = await this.repositoryStore.delete(id);
		if (!deleted) {
			throw new NotFoundError('Legacy repository not found.');
		}
	}

	private validateRegistration(input: LegacyRepositoryRegistration): LegacyRepositoryRegistration {
		if (input.repositoryPath.includes('\0') || !path.isAbsolute(input.repositoryPath)) {
			throw new AppError(400, 'Repository path must be an absolute local filesystem path.');
		}
		return input;
	}

	private async getStoredRepository(id: string): Promise<LegacyRepository> {
		if (!id || typeof id !== 'string') {
			throw new AppError(400, 'Legacy repository ID is required.');
		}
		const repository = await this.repositoryStore.getById(id);
		if (!repository) {
			throw new NotFoundError('Legacy repository not found.');
		}
		if (repository.backend !== 'local' || repository.isReadOnly !== true) {
			throw new AppError(409, 'This legacy repository is not available for read-only inspection.');
		}
		return repository;
	}

	private async inspectRegistration(repositoryPath: string, password: string): Promise<void> {
		try {
			await this.inspector.listSnapshots(repositoryPath, password);
		} catch (error) {
			throw this.toSafeInspectionError(error);
		}
	}

	private async inspectRepository(repository: LegacyRepository): Promise<LegacyRepositorySnapshot[]> {
		try {
			return await this.inspector.listSnapshots(repository.repositoryPath, this.decryptPassword(repository));
		} catch (error) {
			await this.markUnavailable(repository.id);
			throw this.toSafeInspectionError(error);
		}
	}

	private async markUnavailable(id: string): Promise<void> {
		try {
			await this.repositoryStore.updateValidationStatus(id, 'unavailable');
		} catch {
			// A local status update must not hide the original safe inspection error.
		}
	}

	private filterSnapshots(
		snapshots: LegacyRepositorySnapshot[],
		filters: LegacyRepositorySnapshotFilters
	): LegacyRepositorySnapshot[] {
		return snapshots.filter(snapshot => {
			if (filters.tag && !snapshot.tags.includes(filters.tag)) return false;
			if (filters.path && !snapshot.paths.includes(filters.path)) return false;
			if (filters.host && snapshot.hostname !== filters.host) return false;
			return true;
		});
	}

	private encryptPassword(password: string): string {
		const secret = configService.config.SECRET;
		if (!secret) {
			throw new AppError(503, 'Legacy repository credentials are unavailable until Pluton setup is complete.');
		}
		return new Cryptr(secret).encrypt(password);
	}

	private decryptPassword(repository: LegacyRepository): string {
		const secret = configService.config.SECRET;
		if (!secret) {
			throw new AppError(503, 'Legacy repository credentials are unavailable until Pluton setup is complete.');
		}
		try {
			return new Cryptr(secret).decrypt(repository.encryptedPassword);
		} catch {
			throw new AppError(500, 'Legacy repository credentials cannot be accessed.');
		}
	}

	private toPublic(repository: LegacyRepository): LegacyRepositoryPublic {
		const { encryptedPassword: _encryptedPassword, ...publicRepository } = repository;
		return publicRepository;
	}

	private toSafeInspectionError(error: unknown): AppError {
		if (error instanceof AppError) return error;
		if (error instanceof LegacyRepositoryInspectionError) {
			switch (error.kind) {
				case 'wrong-password':
					return new AppError(400, 'Repository credentials could not be verified.');
				case 'repository-unavailable':
					return new AppError(400, 'Repository could not be accessed.');
				case 'timeout':
					return new AppError(504, 'Repository inspection timed out.');
				case 'invalid-output':
					return new AppError(422, 'Repository returned unsupported inspection data.');
				case 'output-limit':
					return new AppError(422, 'Repository inspection output is too large.');
				case 'forbidden-operation':
					return new AppError(403, 'That repository operation is not allowed.');
				default:
					return new AppError(502, 'Repository inspection failed.');
			}
		}
		return new AppError(502, 'Repository inspection failed.');
	}
}

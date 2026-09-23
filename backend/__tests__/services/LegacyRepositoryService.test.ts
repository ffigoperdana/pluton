import path from 'path';
import Cryptr from 'cryptr';

jest.mock('../../src/services/ConfigService', () => ({
	configService: {
		config: {
			SECRET: 'legacy-adapter-test-secret-key',
		},
	},
}));

import { LegacyRepositoryService } from '../../src/services/LegacyRepositoryService';
import type { LegacyRepository } from '../../src/db/schema/legacyRepositories';
import type { LegacyRepositoryStore } from '../../src/stores/LegacyRepositoryStore';
import {
	LegacyRepositoryInspectionError,
	type LegacyResticInspectionClient,
} from '../../src/utils/restic/LegacyRepositoryInspector';
import type { LegacyRepositorySnapshot } from '../../src/types/legacyRepositories';

const repositoryPath = path.resolve(process.cwd(), 'fixtures', 'legacy-restic-repository');
const adapterPassword = 'adapter-test-password';
const encryptionSecret = 'legacy-adapter-test-secret-key';
const snapshots: LegacyRepositorySnapshot[] = [
	{
		id: 'a'.repeat(64),
		shortId: 'aaaaaaaa',
		time: '2026-01-03T00:00:00.000Z',
		hostname: 'host-a',
		tags: ['daily', 'database'],
		paths: ['C:\\fixtures\\source-a'],
	},
	{
		id: 'b'.repeat(64),
		shortId: 'bbbbbbbb',
		time: '2026-01-02T00:00:00.000Z',
		hostname: 'host-b',
		tags: ['weekly'],
		paths: ['C:\\fixtures\\source-b'],
	},
	{
		id: 'c'.repeat(64),
		shortId: 'cccccccc',
		time: '2026-01-01T00:00:00.000Z',
		hostname: 'host-a',
		tags: ['daily'],
		paths: ['C:\\fixtures\\source-c'],
	},
];

function createStoredRepository(overrides: Partial<LegacyRepository> = {}): LegacyRepository {
	return {
		id: 'legacy-fixture',
		displayName: 'Fixture legacy repository',
		repositoryPath,
		backend: 'local',
		encryptedPassword: new Cryptr(encryptionSecret).encrypt(adapterPassword),
		isReadOnly: true,
		validationStatus: 'available',
		lastValidatedAt: new Date('2026-01-01T00:00:00.000Z'),
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: null,
		...overrides,
	};
}

describe('LegacyRepositoryService', () => {
	let store: {
		getAll: jest.Mock;
		getById: jest.Mock;
		create: jest.Mock;
		updateValidationStatus: jest.Mock;
		delete: jest.Mock;
	};
	let inspector: jest.Mocked<LegacyResticInspectionClient>;
	let service: LegacyRepositoryService;

	beforeEach(() => {
		store = {
			getAll: jest.fn(),
			getById: jest.fn(),
			create: jest.fn(),
			updateValidationStatus: jest.fn(),
			delete: jest.fn(),
		};
		inspector = {
			listSnapshots: jest.fn(),
			getRepositoryStats: jest.fn(),
			listSnapshotDirectory: jest.fn(),
		};
		service = new LegacyRepositoryService(store as unknown as LegacyRepositoryStore, inspector);
	});

	it('registers a validated local repository as read-only without returning its password', async () => {
		inspector.listSnapshots.mockResolvedValue(snapshots);
		store.create.mockImplementation(async data =>
			createStoredRepository({
				...data,
				createdAt: new Date('2026-01-03T00:00:00.000Z'),
				updatedAt: null,
			})
		);

		const result = await service.register({
			displayName: 'Imported fixture',
			repositoryPath,
			password: adapterPassword,
		});

		expect(inspector.listSnapshots).toHaveBeenCalledWith(repositoryPath, adapterPassword);
		expect(store.create).toHaveBeenCalledWith(
			expect.objectContaining({ backend: 'local', isReadOnly: true, validationStatus: 'available' })
		);
		const saved = store.create.mock.calls[0][0];
		expect(saved.encryptedPassword).not.toContain(adapterPassword);
		expect(result).toEqual(expect.objectContaining({ backend: 'local', isReadOnly: true }));
		expect(JSON.stringify(result)).not.toContain(adapterPassword);
		expect(result).not.toHaveProperty('encryptedPassword');
	});

	it('rejects a non-absolute repository path before inspection', async () => {
		await expect(
			service.register({
				displayName: 'Invalid fixture',
				repositoryPath: 'relative/legacy-repository',
				password: adapterPassword,
			})
		).rejects.toMatchObject({ statusCode: 400 });
		expect(inspector.listSnapshots).not.toHaveBeenCalled();
		expect(store.create).not.toHaveBeenCalled();
	});

	it('returns a safe validation error for incorrect credentials', async () => {
		inspector.listSnapshots.mockRejectedValue(new LegacyRepositoryInspectionError('wrong-password'));

		await expect(
			service.register({ displayName: 'Fixture legacy', repositoryPath, password: adapterPassword })
		).rejects.toMatchObject({
			statusCode: 400,
			message: 'Repository credentials could not be verified.',
		});
		await service
			.register({ displayName: 'Fixture legacy', repositoryPath, password: adapterPassword })
			.catch(error => expect((error as Error).message).not.toContain(adapterPassword));
	});

	it('lists and filters multiple workloads locally by tag, path, and host', async () => {
		store.getById.mockResolvedValue(createStoredRepository());
		store.updateValidationStatus.mockResolvedValue(createStoredRepository());
		inspector.listSnapshots.mockResolvedValue(snapshots);

		await expect(service.listSnapshots('legacy-fixture', { tag: 'daily' })).resolves.toHaveLength(2);
		await expect(service.listSnapshots('legacy-fixture', { host: 'host-b' })).resolves.toEqual([
			expect.objectContaining({ id: 'b'.repeat(64) }),
		]);
		await expect(
			service.listSnapshots('legacy-fixture', { path: 'C:\\fixtures\\source-c' })
		).resolves.toEqual([expect.objectContaining({ id: 'c'.repeat(64) })]);
		expect(inspector.listSnapshots).toHaveBeenCalledWith(repositoryPath, expect.any(String));
	});

	it('only deletes the local registration and never inspects or changes the repository', async () => {
		store.getById.mockResolvedValue(createStoredRepository());
		store.delete.mockResolvedValue(true);

		await expect(service.deleteRegistration('legacy-fixture')).resolves.toBeUndefined();
		expect(store.delete).toHaveBeenCalledWith('legacy-fixture');
		expect(inspector.listSnapshots).not.toHaveBeenCalled();
		expect(inspector.getRepositoryStats).not.toHaveBeenCalled();
	});

	it('rejects caller-supplied mode changes and refuses stored non-read-only records', async () => {
		await expect(
			service.register({
				displayName: 'Unsafe fixture',
				repositoryPath,
				password: adapterPassword,
				isReadOnly: false,
			})
		).rejects.toMatchObject({ statusCode: 400 });
		expect(inspector.listSnapshots).not.toHaveBeenCalled();

		store.getById.mockResolvedValue(createStoredRepository({ isReadOnly: false }));
		await expect(service.listSnapshots('legacy-fixture')).rejects.toMatchObject({ statusCode: 409 });
		expect(inspector.listSnapshots).not.toHaveBeenCalled();
	});
});

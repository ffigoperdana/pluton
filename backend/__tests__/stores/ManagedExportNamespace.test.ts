import fs from 'fs';
import os from 'os';
import path from 'path';
import Cryptr from 'cryptr';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { fixture } from '../integration/persistentRestore.fixture';
import { PlanStore } from '../../src/stores/PlanStore';
import { StorageStore } from '../../src/stores/StorageStore';
import { ManagedReplicationStore } from '../../src/stores/ManagedReplicationStore';
import { SettingsStore } from '../../src/stores/SettingsStore';
import { BackupStore } from '../../src/stores/BackupStore';
import { exportConfiguration } from '../../src/utils/managedExport/ExportPolicy';
import { assertExportIsolation } from '../../src/utils/managedExport/ExportIsolation';
import {
	initializeExportNamespaceReservations,
	reserveExportNamespace,
	beginExportStorageEdit,
	configureExportNamespaceSecurity,
} from '../../src/utils/managedExport/NamespaceReservation';
import { configureReplicaScopeResolver } from '../../src/utils/managedReplicationPolicy';
import {
	canonicalS3RepositoryIdentity,
	s3RepositoryScope,
	canonicalS3Location,
	decryptStorageCredentials,
	isS3Storage,
} from '../../src/utils/storageSecurity';

jest.mock('../../src/services/ConfigService', () => ({
	configService: { config: { SECRET: 'synthetic-shared-namespace-secret' } },
}));
const cipher = new Cryptr('synthetic-shared-namespace-secret');
const configuration = (shared = true) =>
	exportConfiguration({
		MANAGED_EXPORT_ENABLED: 'true',
		MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE: String(shared),
		MANAGED_EXPORT_ENDPOINT: 'https://tenant.example.internal',
		MANAGED_EXPORT_BUCKET: 'fixture-bucket',
		MANAGED_EXPORT_ACCESS_KEY_ID: 'synthetic-shared-key',
		MANAGED_EXPORT_SECRET_ACCESS_KEY: 'synthetic-shared-secret',
	})!;
const storage = (id = 'mirror-01', endpoint = 'https://tenant.example.internal') =>
	({
		id,
		name: id.replace(/-/g, '_'),
		type: 's3compatible',
		settings: { hcp_mode: true },
		credentials: Object.fromEntries(
			Object.entries({
				bucket: 'fixture-bucket',
				endpoint,
				access_key_id: 'synthetic-shared-key',
				secret_access_key: 'synthetic-shared-secret',
			}).map(([key, value]) => [key, cipher.encrypt(value)])
		),
	}) as any;
const plan = (id: string, prefix: string, storageId = 'mirror-01') =>
	({
		id,
		title: 'Synthetic fixture',
		sourceId: 'app-01',
		sourceType: 'device',
		method: 'backup',
		storageId,
		storagePath: prefix,
		sourceConfig: {},
		settings: { encryption: true },
	}) as any;

describe('shared export namespace: actual SQLite admission and durable reservations', () => {
	let context: ReturnType<typeof fixture>, plans: PlanStore, storages: StorageStore;
	beforeEach(() => {
		context = fixture();
		initializeExportNamespaceReservations(context.sqlite);
		configureExportNamespaceSecurity({
			canonicalS3Location,
			s3RepositoryScope,
			decryptStorageCredentials,
			isS3Storage,
		});
		configureReplicaScopeResolver(s3RepositoryScope);
		const row = storage();
		context.sqlite
			.prepare('INSERT INTO storages(id,name,type,credentials,settings) VALUES(?,?,?,?,?)')
			.run(
				row.id,
				row.name,
				row.type,
				JSON.stringify(row.credentials),
				JSON.stringify(row.settings)
			);
		plans = new PlanStore(drizzle(context.sqlite) as any);
		storages = new StorageStore(drizzle(context.sqlite) as any);
	});
	afterEach(() => {
		context.sqlite.close();
		configureReplicaScopeResolver(undefined);
		configureExportNamespaceSecurity(undefined);
	});
	test('shared mode is operator-only, strictly boolean, and reserves only the fixed prefix', () => {
		const base = {
			MANAGED_EXPORT_ENABLED: 'true',
			MANAGED_EXPORT_ENDPOINT: 'https://tenant.example.internal',
			MANAGED_EXPORT_BUCKET: 'fixture-bucket',
			MANAGED_EXPORT_ACCESS_KEY_ID: 'synthetic-key',
			MANAGED_EXPORT_SECRET_ACCESS_KEY: 'synthetic-secret',
		};
		expect(exportConfiguration(base)?.allowSharedNamespace).toBe(false);
		for (const value of ['yes', '1', 'TRUE'])
			expect(() =>
				exportConfiguration({ ...base, MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE: value })
			).toThrow('configuration-invalid');
		expect(() =>
			exportConfiguration({
				...base,
				MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE: 'true',
				MANAGED_EXPORT_PREFIX: 'pluton-temporary-exports/nested',
			})
		).toThrow('configuration-invalid');
		expect(() => assertExportIsolation(configuration(), [storage()])).toThrow(
			'destination-not-isolated'
		);
		expect(() =>
			exportConfiguration({
				...base,
				MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE: 'true',
				MANAGED_EXPORT_ENDPOINT: 'https://fixture-bucket.tenant.example.internal',
			})
		).toThrow('configuration-invalid');
	});
	test('uncertain jobs and retained backup mirror receipts are authoritative even without a destination row', () => {
		new ManagedReplicationStore(context.sqlite);
		// Use the actual job table columns with a disposable minimal historical row.
		context.sqlite
			.prepare(
				`INSERT INTO managed_replication_jobs(id,backup_id,plan_id,repository_id,agent_id,source_storage_id,source_storage_path,source_snapshot_id,source_repository_config_id,source_tree_id,source_binding_hash,replication_id,destination_storage_id,destination_storage_path,destination_fingerprint,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
			)
			.run(
				'uncertain-01',
				'backup-01',
				'plan-01',
				'repo-01',
				'agent-01',
				'storage-01',
				'managed/fixture',
				'b'.repeat(64),
				'c'.repeat(64),
				'd'.repeat(64),
				'e'.repeat(64),
				'old-replica',
				'mirror-01',
				'fixture-bucket/pluton-temporary-exports',
				'f'.repeat(64),
				'uncertain',
				1,
				1
			);
		expect(() => reserveExportNamespace(context.sqlite, configuration())).toThrow(
			'destination-not-isolated'
		);
		context.sqlite.prepare('DELETE FROM managed_replication_jobs').run();
		context.sqlite.prepare('UPDATE backups SET mirrors=?').run(
			JSON.stringify([
				{
					storageId: 'mirror-01',
					storagePath: 'fixture-bucket/pluton-temporary-exports',
					status: 'completed',
				},
			])
		);
		expect(() => reserveExportNamespace(context.sqlite, configuration())).toThrow(
			'destination-not-isolated'
		);
	});
	test('late mirror receipt writes and duplicate storage remote names cannot bypass the reservation', async () => {
		reserveExportNamespace(context.sqlite, configuration());
		await expect(
			new BackupStore(drizzle(context.sqlite) as any).update('backup-01', {
				mirrors: [
					{ storageId: 'mirror-01', storagePath: 'fixture-bucket/pluton-temporary-exports' },
				] as any,
			})
		).rejects.toThrow('reserved');
		await expect(storages.create({ ...storage('alias-02'), name: 'MIRROR_01' })).rejects.toThrow(
			'ambiguous'
		);
		const release = beginExportStorageEdit(context.sqlite, 'new-s3', storage('new-s3'));
		expect(() =>
			beginExportStorageEdit(context.sqlite, 'new-local', {
				id: 'new-local',
				name: 'NEW_S3',
				type: 'local',
				credentials: {},
				settings: {},
			} as any)
		).toThrow('reserved');
		release();
	});
	test('strict default still rejects bucket and credential reuse; explicit shared mode accepts five disjoint plans', async () => {
		expect(() => assertExportIsolation(configuration(false), [storage()], context.sqlite)).toThrow(
			'destination-not-isolated'
		);
		for (let index = 0; index < 5; index++)
			await plans.create(plan(`scope-${index}`, `fixture-bucket/repositories/app-${index}`));
		expect(() => assertExportIsolation(configuration(), [storage()], context.sqlite)).not.toThrow();
		expect(
			context.sqlite
				.prepare('SELECT count(*) AS n FROM managed_export_namespace_reservations')
				.get()
		).toEqual({ n: 1 });
		// Different dedicated credentials are also accepted; credentials never define a prefix boundary.
		expect(() =>
			reserveExportNamespace(context.sqlite, {
				...configuration(),
				accessKeyId: 'synthetic-other-key',
			})
		).not.toThrow();
	});
	test('scope resolution derives shared credentials once per transaction and revalidates later edits', async () => {
		for (let index = 0; index < 5; index++)
			await plans.create(plan(`cache-${index}`, `fixture-bucket/repositories/cache-${index}`));
		const decrypt = jest.fn(decryptStorageCredentials);
		configureExportNamespaceSecurity({
			canonicalS3Location,
			s3RepositoryScope,
			decryptStorageCredentials: decrypt,
			isS3Storage,
		});
		reserveExportNamespace(context.sqlite, configuration());
		expect(decrypt).toHaveBeenCalledTimes(1);
		context.sqlite
			.prepare('UPDATE plans SET storage_path=? WHERE id=?')
			.run('fixture-bucket/pluton-temporary-exports', 'cache-0');
		expect(() => reserveExportNamespace(context.sqlite, configuration())).toThrow(
			'destination-not-isolated'
		);
		expect(decrypt).toHaveBeenCalledTimes(2);
	});
	test.each([
		'fixture-bucket',
		'fixture-bucket/',
		'fixture-bucket/pluton-temporary-exports',
		'fixture-bucket/pluton-temporary-exports/child',
		'fixture-bucket/pluton-temporary-exports/%2e%2e/repository',
		'fixture-bucket//ambiguous',
	])('future plan %s is refused before DB publication', async prefix => {
		reserveExportNamespace(context.sqlite, configuration());
		await expect(plans.create(plan('future-01', prefix))).rejects.toThrow();
		expect(
			context.sqlite.prepare("SELECT id FROM plans WHERE id='future-01'").get()
		).toBeUndefined();
		await expect(
			plans.create(plan('sibling-01', 'fixture-bucket/pluton-temporary-exports-other'))
		).resolves.toBeTruthy();
	});
	test.each([
		'fixture-bucket',
		'fixture-bucket/pluton-temporary-exports',
		'fixture-bucket//ambiguous',
	])('preexisting repository %s blocks export without changing it', async prefix => {
		await plans.create(plan('existing-01', prefix));
		const before = context.sqlite.prepare("SELECT * FROM plans WHERE id='existing-01'").get();
		expect(() => reserveExportNamespace(context.sqlite, configuration())).toThrow(
			'destination-not-isolated'
		);
		expect(context.sqlite.prepare("SELECT * FROM plans WHERE id='existing-01'").get()).toEqual(
			before
		);
	});
	test('disabled replication and inherited root scope remain authoritative', async () => {
		await plans.create({
			...plan('disabled-01', 'fixture-bucket/repository-a'),
			settings: {
				replication: {
					enabled: false,
					storages: [
						{ replicationId: 'disabled-replica', storageId: 'mirror-01', storagePath: '' },
					],
				},
			},
		});
		expect(() => reserveExportNamespace(context.sqlite, configuration())).toThrow(
			'destination-not-isolated'
		);
	});
	test('future replica edits are guarded transactionally even when disabled', async () => {
		await plans.create(plan('future-01', 'fixture-bucket/repositories/app-01'));
		reserveExportNamespace(context.sqlite, configuration());
		await expect(
			plans.update('future-01', {
				settings: {
					replication: {
						enabled: false,
						storages: [
							{
								replicationId: 'replica-x',
								storageId: 'mirror-01',
								storagePath: 'fixture-bucket/pluton-temporary-exports/nested',
							},
						],
					},
				} as any,
			})
		).rejects.toThrow('reserved');
	});
	test.each([
		'https://fixture-bucket.TENANT.example.internal:443/',
		'https://alias.example.internal',
	])('endpoint alias %s cannot hide a collision', async endpoint => {
		const row = storage('alias-01', endpoint);
		context.sqlite
			.prepare('INSERT INTO storages(id,name,type,credentials,settings) VALUES(?,?,?,?,?)')
			.run(
				row.id,
				row.name,
				row.type,
				JSON.stringify(row.credentials),
				JSON.stringify(row.settings)
			);
		await plans.create(plan('alias-plan', 'fixture-bucket/pluton-temporary-exports', row.id));
		expect(() => reserveExportNamespace(context.sqlite, configuration())).toThrow(
			'destination-not-isolated'
		);
	});
	test.each(['uninitialized', 'initializing', 'uncertain', 'detached', 'ready'])(
		'retained or %s replica ownership blocks exports and is never rewritten',
		state => {
			const replicas = new ManagedReplicationStore(context.sqlite);
			const row = storage();
			const identity = canonicalS3RepositoryIdentity(
				row,
				'fixture-bucket/pluton-temporary-exports'
			);
			replicas.reserveDestination({
				planId: 'plan-01',
				replicationId: 'replica-01',
				sourceRepositoryId: 'repo-01',
				destinationStorageId: row.id,
				destinationStoragePath: 'fixture-bucket/pluton-temporary-exports',
				destinationAuthority: identity.authority,
				destinationPrefix: identity.prefix,
				destinationFingerprint: identity.fingerprint,
			});
			context.sqlite.prepare('UPDATE managed_replication_destinations SET init_state=?').run(state);
			const before = context.sqlite.prepare('SELECT * FROM managed_replication_destinations').all();
			expect(() => reserveExportNamespace(context.sqlite, configuration())).toThrow(
				'destination-not-isolated'
			);
			expect(
				context.sqlite.prepare('SELECT * FROM managed_replication_destinations').all()
			).toEqual(before);
		}
	);
	test('late replica reservation loses to the export reservation', () => {
		reserveExportNamespace(context.sqlite, configuration());
		const replicas = new ManagedReplicationStore(context.sqlite);
		const identity = canonicalS3RepositoryIdentity(
			storage(),
			'fixture-bucket/pluton-temporary-exports/replica'
		);
		expect(() =>
			replicas.reserveDestination({
				planId: 'plan-01',
				replicationId: 'replica-01',
				sourceRepositoryId: 'repo-01',
				destinationStorageId: 'mirror-01',
				destinationStoragePath: 'fixture-bucket/pluton-temporary-exports/replica',
				destinationAuthority: identity.authority,
				destinationPrefix: identity.prefix,
				destinationFingerprint: identity.fingerprint,
			})
		).toThrow('reserved');
	});
	test('historical backup and retained repository references are included', () => {
		context.sqlite
			.prepare('UPDATE backups SET storage_id=?,storage_path=? WHERE id=?')
			.run('mirror-01', 'fixture-bucket/pluton-temporary-exports', 'backup-01');
		expect(() => reserveExportNamespace(context.sqlite, configuration())).toThrow(
			'destination-not-isolated'
		);
		context.sqlite
			.prepare('UPDATE backups SET storage_id=? WHERE id=?')
			.run('storage-01', 'backup-01');
		context.sqlite
			.prepare(
				'INSERT INTO retained_managed_repositories(id,former_plan_id,agent_id,storage_id,storage_path,encrypted_password,repository_created_at) VALUES(?,?,?,?,?,?,?)'
			)
			.run(
				'retained-01',
				'old-plan',
				'agent-01',
				'mirror-01',
				'fixture-bucket/pluton-temporary-exports',
				'synthetic-cipher',
				1
			);
		expect(() => reserveExportNamespace(context.sqlite, configuration())).toThrow(
			'destination-not-isolated'
		);
	});
	test('future storage redirection and self-backup paths cannot cover the reservation', async () => {
		await plans.create(plan('existing-01', 'fixture-bucket/repository-01'));
		reserveExportNamespace(context.sqlite, configuration());
		const next = storage();
		expect(() => beginExportStorageEdit(context.sqlite, next.id, next)).toThrow('reserved');
		await expect(
			new SettingsStore(drizzle(context.sqlite) as any).create({
				settings: {
					selfBackup: {
						storageId: next.id,
						path: 'fixture-bucket/pluton-temporary-exports',
						enabled: false,
					},
				} as any,
			})
		).rejects.toThrow('reserved');
	});
	test('an in-flight storage edit wins the race; uncertain edits stay a durable blocker', () => {
		beginExportStorageEdit(context.sqlite, 'mirror-01', storage());
		expect(() => reserveExportNamespace(context.sqlite, configuration())).toThrow(
			'destination-not-isolated'
		);
		expect(
			context.sqlite.prepare('SELECT storage_id FROM managed_export_storage_edits').all()
		).toEqual([{ storage_id: 'mirror-01' }]);
	});
	test('reservation survives reopening and cannot be bypassed by disabling the feature', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pluton-prefix-reservation-'));
		const file = path.join(directory, 'fixture.sqlite');
		const disk = fixture(file);
		try {
			initializeExportNamespaceReservations(disk.sqlite);
			reserveExportNamespace(disk.sqlite, configuration());
			disk.sqlite.close();
			const Database = (await import('better-sqlite3')).default;
			const reopened = new Database(file);
			try {
				const row = storage();
				reopened
					.prepare('INSERT INTO storages(id,name,type,credentials,settings) VALUES(?,?,?,?,?)')
					.run(
						row.id,
						row.name,
						row.type,
						JSON.stringify(row.credentials),
						JSON.stringify(row.settings)
					);
				await expect(
					new PlanStore(drizzle(reopened) as any).create(
						plan('after-restart', 'fixture-bucket/pluton-temporary-exports')
					)
				).rejects.toThrow('reserved');
			} finally {
				reopened.close();
			}
		} finally {
			if (disk.sqlite.open) disk.sqlite.close();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
	test('two database connections serialize concurrent export reservation and conflicting plan creation', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pluton-prefix-race-'));
		const disk = fixture(path.join(directory, 'fixture.sqlite'));
		const second = new Database(path.join(directory, 'fixture.sqlite'), { timeout: 1 });
		try {
			initializeExportNamespaceReservations(disk.sqlite);
			const row = storage();
			disk.sqlite
				.prepare('INSERT INTO storages(id,name,type,credentials,settings) VALUES(?,?,?,?,?)')
				.run(
					row.id,
					row.name,
					row.type,
					JSON.stringify(row.credentials),
					JSON.stringify(row.settings)
				);
			disk.sqlite.exec('BEGIN IMMEDIATE');
			reserveExportNamespace(disk.sqlite, configuration());
			const competing = new PlanStore(drizzle(second) as any);
			await expect(
				competing.create(plan('race-plan', 'fixture-bucket/pluton-temporary-exports'))
			).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
			disk.sqlite.exec('COMMIT');
			await expect(
				competing.create(plan('race-plan', 'fixture-bucket/pluton-temporary-exports'))
			).rejects.toThrow('reserved');
			expect(second.prepare("SELECT id FROM plans WHERE id='race-plan'").get()).toBeUndefined();
		} finally {
			if (disk.sqlite.inTransaction) disk.sqlite.exec('ROLLBACK');
			second.close();
			disk.sqlite.close();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});

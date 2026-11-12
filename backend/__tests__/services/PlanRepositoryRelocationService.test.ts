import Cryptr from 'cryptr';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { fixture } from '../integration/persistentRestore.fixture';
import { PlanStore } from '../../src/stores/PlanStore';
import { PlanRepositoryRelocationStore } from '../../src/stores/PlanRepositoryRelocationStore';
import { PlanRepositoryRelocationService } from '../../src/services/PlanRepositoryRelocationService';
import {
	buildInventory,
	RelocationError,
	type RelocationFailureCode,
} from '../../src/utils/relocation/repositoryInventory';
import type {
	RepositoryTransferProvider,
	RepositoryTransferSession,
	SftpEndpoint,
} from '../../src/utils/relocation/SftpRepositoryTransfer';

const SECRET = 'synthetic-relocation-secret-0123456789abcdef';
const hex = (seed: string) => seed.repeat(64).slice(0, 64);

type FakeRepository = { files: Map<string, number>; id: string; snapshots: string[] };
function repository(snapshot = hex('b')): FakeRepository {
	return {
		id: hex('c'),
		snapshots: [snapshot],
		files: new Map([
			['config', 155],
			[`keys/${hex('1')}`, 460],
			[`snapshots/${snapshot}`, 300],
			[`index/${hex('2')}`, 900],
			[`data/ab/${'ab' + hex('3').slice(2)}`, 4096],
			[`locks/${hex('4')}`, 120],
		]),
	};
}

/** In-memory SFTP endpoints keyed by host and path; faults are injected per test. */
class FakeTransfer implements RepositoryTransferProvider {
	readonly repositories = new Map<string, FakeRepository>();
	readonly calls: string[] = [];
	faults: {
		copy?: RelocationFailureCode;
		hash?: RelocationFailureCode;
		check?: RelocationFailureCode;
		afterCopy?: () => void;
		blockCopy?: Promise<void>;
	} = {};
	key(endpoint: SftpEndpoint) {
		return `${endpoint.options.host}:${endpoint.path}`;
	}
	async withSession<T>(
		input: { source: SftpEndpoint; destination: SftpEndpoint; password: string },
		consume: (session: RepositoryTransferSession) => Promise<T>,
		signal?: AbortSignal
	): Promise<T> {
		expect(input.password).toBe('synthetic-restic-password');
		const at = (side: 'source' | 'destination') => this.key(input[side]);
		const session: RepositoryTransferSession = {
			inventory: async (side, options) => {
				this.calls.push(`inventory:${side}`);
				const repo = this.repositories.get(at(side));
				if (!repo) return null;
				return buildInventory(
					[...repo.files].map(([Path, Size]) => ({ Path, Size })),
					options
				);
			},
			removeDestinationPartials: async () => {
				this.calls.push('remove-partials');
				const repo = this.repositories.get(at('destination'))!;
				for (const name of [...repo.files.keys()])
					if (name.endsWith('.partial')) repo.files.delete(name);
			},
			copy: async onProgress => {
				this.calls.push('copy');
				if (this.faults.blockCopy) await this.faults.blockCopy;
				if (signal?.aborted) throw new RelocationError('cancelled');
				if (this.faults.copy) throw new RelocationError(this.faults.copy);
				const source = this.repositories.get(at('source'))!;
				const destination = this.repositories.get(at('destination')) || {
					id: source.id,
					snapshots: [],
					files: new Map(),
				};
				for (const [name, size] of source.files)
					if (!name.startsWith('locks/') && !destination.files.has(name))
						destination.files.set(name, size);
				destination.id = source.id;
				destination.snapshots = [...source.snapshots];
				this.repositories.set(at('destination'), destination);
				onProgress({ copiedBytes: 10, copyTotalBytes: 10, copiedFiles: 1, copyTotalFiles: 1 });
				this.faults.afterCopy?.();
			},
			sha256: async () => hex('a'),
			verifyDestinationHashes: async (inventory, _sha, onProgress) => {
				this.calls.push('hash');
				if (this.faults.hash) throw new RelocationError(this.faults.hash);
				onProgress(inventory.fileCount);
			},
			repositoryId: async side => this.repositories.get(at(side))!.id,
			snapshotIds: async side => this.repositories.get(at(side))!.snapshots,
			checkDestination: async () => {
				this.calls.push('check');
				if (this.faults.check) throw new RelocationError(this.faults.check);
			},
			purgeSource: async () => {
				this.calls.push('purge');
				this.repositories.delete(at('source'));
			},
		};
		return consume(session);
	}
}

describe('plan repository relocation service', () => {
	let context: ReturnType<typeof fixture>;
	let store: PlanRepositoryRelocationStore;
	let transfer: FakeTransfer;
	let service: PlanRepositoryRelocationService;
	let exportsBusy: boolean;
	const pause = jest.fn(async (planId: string) => {
		context.sqlite.prepare('UPDATE plans SET active=0 WHERE id=?').run(planId);
	});
	const resume = jest.fn(async (planId: string) => {
		context.sqlite.prepare('UPDATE plans SET active=1 WHERE id=?').run(planId);
	});
	const plan = () =>
		context.sqlite
			.prepare('SELECT active,storage_id,storage_path FROM plans WHERE id=?')
			.get('plan-01') as { active: number; storage_id: string; storage_path: string };
	const start = (patch: Partial<{ storageId: string; storagePath: string; planId: string }> = {}) =>
		service.start({
			planId: 'plan-01',
			storageId: 'storage-02',
			storagePath: 'managed/fixture-moved',
			...patch,
		});
	const successfulBackupAtNewLocation = () =>
		context.sqlite.exec(
			`INSERT INTO backups(id,plan_id,source_id,source_type,method,storage_id,storage_path,status,in_progress,success,completion_stats)
			 VALUES('backup-new','plan-01','app-01','device','backup','storage-02','managed/fixture-moved','completed',0,1,'{"snapshot_id":"${hex('e')}"}')`
		);

	beforeEach(() => {
		context = fixture();
		context.sqlite.exec(`
			UPDATE plans SET storage_path='managed/fixture';
			INSERT INTO storages(id,name,type) VALUES('storage-02','Fixture SFTP 2','sftp');
			INSERT INTO storages(id,name,type) VALUES('storage-s3','Fixture S3','s3');
		`);
		context.sqlite
			.prepare('UPDATE remote_managed_repositories SET encrypted_password=? WHERE id=?')
			.run(new Cryptr(SECRET).encrypt('synthetic-restic-password'), 'repo-01');
		store = new PlanRepositoryRelocationStore(context.sqlite);
		transfer = new FakeTransfer();
		transfer.repositories.set('storage-01.example.internal:managed/fixture', repository());
		exportsBusy = false;
		pause.mockClear();
		resume.mockClear();
		const sqlite = context.sqlite;
		const planStore = new PlanStore(drizzle(sqlite) as any);
		service = new PlanRepositoryRelocationService(
			store,
			{
				getById: async (id: string) => {
					const row = sqlite.prepare('SELECT * FROM plans WHERE id=?').get(id) as any;
					return row
						? ({
								id: row.id,
								title: row.title,
								sourceId: row.source_id,
								sourceType: row.source_type,
								method: row.method,
								storageId: row.storage_id,
								storagePath: row.storage_path,
								isActive: row.active === 1,
							} as any)
						: null;
				},
				getStorageRemovalReferences: () => planStore.getStorageRemovalReferences(),
			},
			{
				getByPlanId: async (planId: string) => {
					const row = sqlite
						.prepare('SELECT * FROM remote_managed_repositories WHERE plan_id=?')
						.get(planId) as any;
					return row
						? ({
								id: row.id,
								planId: row.plan_id,
								storageId: row.storage_id,
								storagePath: row.storage_path,
								encryptedPassword: row.encrypted_password,
								initializedAt: row.initialized_at,
							} as any)
						: null;
				},
			},
			{
				getById: async (id: string) =>
					(sqlite.prepare('SELECT id,name,type FROM storages WHERE id=?').get(id) as any) || null,
			},
			{
				getSftpRecoveryOptions: async (storageId: string) => ({
					host: `${storageId}.example.internal`,
					user: 'fixture-user',
					pass: 'fixture-pass',
				}),
			},
			{ pause, resume },
			() => exportsBusy,
			transfer,
			SECRET
		);
	});
	afterEach(async () => {
		await service.shutdown();
		context.sqlite.close();
	});

	it('copies, proves, switches every binding and resumes the plan it paused', async () => {
		const started = await start();
		expect(started.status).toBe('copying');
		expect(pause).toHaveBeenCalledWith('plan-01');
		await service.idle();
		const ready = await service.get(started.id);
		expect(ready.status).toBe('ready');
		expect(ready.evidence).toMatchObject({ repositoryConfigId: hex('c'), fileCount: 5, snapshotCount: 1 });
		expect(ready.progress).toMatchObject({ totalFiles: 5, verifiedFiles: 5, copiedBytes: 10 });
		expect(ready.actions).toEqual({ cancel: true, switch: true, revert: false, deleteSource: false });
		expect(plan().active).toBe(0);
		// Locks are never copied.
		expect(
			[...transfer.repositories.get('storage-02.example.internal:managed/fixture-moved')!.files.keys()].some(
				name => name.startsWith('locks/')
			)
		).toBe(false);
		expect(transfer.calls).toEqual(
			expect.arrayContaining(['copy', 'hash', 'check'])
		);
		await service.switch(started.id);
		await service.idle();
		const switched = await service.get(started.id);
		expect(switched.status).toBe('switched');
		expect(plan()).toEqual({ active: 1, storage_id: 'storage-02', storage_path: 'managed/fixture-moved' });
		expect(resume).toHaveBeenCalledWith('plan-01');
		expect(switched.actions).toEqual({ cancel: false, switch: false, revert: true, deleteSource: false });
		expect(switched.source.storageName).toBe('Fixture SFTP');
		expect(switched.destination.storageName).toBe('Fixture SFTP 2');
	});

	it('keeps a paused plan paused', async () => {
		context.sqlite.exec('UPDATE plans SET active=0');
		const started = await start();
		await service.idle();
		await service.switch(started.id);
		await service.idle();
		expect(pause).not.toHaveBeenCalled();
		expect(resume).not.toHaveBeenCalled();
		expect(plan().active).toBe(0);
	});

	it.each([
		[{ storageId: 'storage-s3' }, 400, 'SFTP Storage'],
		[{ storageId: 'storage-01', storagePath: 'managed/fixture/nested' }, 400, 'current repository'],
		[{ storagePath: '../escape' }, 400, 'failed safely'],
		[{ storagePath: '/' }, 400, 'failed safely'],
	])('refuses an unsafe destination %#', async (patch, status, message) => {
		await expect(start(patch)).rejects.toMatchObject({ statusCode: status });
		await expect(start(patch)).rejects.toThrow(message);
		expect(store.listForPlan('plan-01')).toEqual([]);
		expect(pause).not.toHaveBeenCalled();
	});

	it('refuses a destination that overlaps another repository and a non-remote plan', async () => {
		context.sqlite.exec(`
			INSERT INTO plans(id,title,source_id,source_type,method,storage_id,storage_path,source_config,settings)
			VALUES('plan-02','Other','app-01','device','backup','storage-02','managed/other','{}','{}');
			INSERT INTO devices(id,name) VALUES('main','Server');
			INSERT INTO plans(id,title,source_id,source_type,method,storage_id,storage_path,source_config,settings)
			VALUES('plan-local','Local','main','device','backup','storage-01','local/path','{}','{}');
		`);
		await expect(start({ storagePath: 'managed/other/inside' })).rejects.toThrow('overlaps');
		await expect(start({ planId: 'plan-local' })).rejects.toThrow('Remote Agent');
		exportsBusy = true;
		await expect(start()).rejects.toThrow('Reliable Download');
	});

	it('fails closed on a foreign destination and gives the plan back', async () => {
		const foreign = repository(hex('9'));
		foreign.id = hex('8');
		transfer.repositories.set('storage-02.example.internal:managed/fixture-moved', foreign);
		const started = await start();
		await service.idle();
		const failed = await service.get(started.id);
		expect(failed.status).toBe('failed');
		expect(failed.failureCode).toBe('destination-not-empty');
		expect(transfer.calls).not.toContain('copy');
		expect(plan()).toEqual({ active: 1, storage_id: 'storage-01', storage_path: 'managed/fixture' });
	});

	it('fails on a corrupt copy and lets the same repository retry its own destination', async () => {
		transfer.faults.hash = 'destination-hash-mismatch';
		const first = await start();
		await service.idle();
		expect((await service.get(first.id)).failureCode).toBe('destination-hash-mismatch');
		expect(plan().active).toBe(1);
		transfer.faults.hash = undefined;
		transfer.repositories
			.get('storage-02.example.internal:managed/fixture-moved')!
			.files.set(`data/ab/${'ab' + hex('5').slice(2)}.x1y2.partial`, 10);
		const retry = await start();
		await service.idle();
		const ready = await service.get(retry.id);
		expect(ready.status).toBe('ready');
		expect(transfer.calls).toContain('remove-partials');
		expect(ready.audit.map(event => event.event)).toContain('destination-reused');
	});

	it('detects a source that changed during the copy', async () => {
		transfer.faults.afterCopy = () =>
			transfer.repositories
				.get('storage-01.example.internal:managed/fixture')!
				.files.set(`snapshots/${hex('7')}`, 280);
		const started = await start();
		await service.idle();
		expect((await service.get(started.id)).failureCode).toBe('source-changed');
	});

	it('requires every recorded backup snapshot in the copy', async () => {
		context.sqlite.exec(
			`INSERT INTO backups(id,plan_id,source_id,source_type,method,storage_id,storage_path,status,in_progress,success,completion_stats)
			 VALUES('backup-02','plan-01','app-01','device','backup','storage-01','managed/fixture','completed',0,1,'{"snapshot_id":"${hex('6')}"}')`
		);
		const started = await start();
		await service.idle();
		expect((await service.get(started.id)).failureCode).toBe('snapshot-missing');
	});

	it('reports restic check failure and copy transport failure with closed codes', async () => {
		transfer.faults.check = 'restic-check-failed';
		const first = await start();
		await service.idle();
		expect((await service.get(first.id)).failureCode).toBe('restic-check-failed');
		transfer.faults = { copy: 'destination-full' };
		const second = await start();
		await service.idle();
		expect((await service.get(second.id)).failureCode).toBe('destination-full');
	});

	it('cancels a running copy and restores the plan', async () => {
		let release!: () => void;
		transfer.faults.blockCopy = new Promise<void>(resolve => (release = resolve));
		const started = await start();
		await new Promise(resolve => setTimeout(resolve, 10));
		const cancelling = service.cancel(started.id);
		release();
		const cancelled = await cancelling;
		expect(cancelled.status).toBe('cancelled');
		expect(plan().active).toBe(1);
		expect(resume).toHaveBeenCalledTimes(1);
	});

	it('refuses to switch when the source changed after verification', async () => {
		const started = await start();
		await service.idle();
		transfer.repositories
			.get('storage-01.example.internal:managed/fixture')!
			.files.set(`snapshots/${hex('7')}`, 280);
		await service.switch(started.id);
		await service.idle();
		const failed = await service.get(started.id);
		expect(failed.status).toBe('failed');
		expect(failed.failureCode).toBe('source-changed');
		expect(plan()).toEqual({ active: 1, storage_id: 'storage-01', storage_path: 'managed/fixture' });
	});

	it('keeps a verified copy ready when the plan became busy before the switch', async () => {
		const started = await start();
		await service.idle();
		context.sqlite.exec(
			"INSERT INTO restores(id,plan_id,backup_id,source_id,in_progress) VALUES('restore-01','plan-01','backup-01','app-01',1)"
		);
		await expect(service.switch(started.id)).rejects.toThrow('running restore');
		expect((await service.get(started.id)).status).toBe('ready');
	});

	it('reverts while no successful backup exists at the new location', async () => {
		const started = await start();
		await service.idle();
		await service.switch(started.id);
		await service.idle();
		await service.revert(started.id);
		await service.idle();
		const reverted = await service.get(started.id);
		expect(reverted.status).toBe('reverted');
		expect(plan()).toEqual({ active: 1, storage_id: 'storage-01', storage_path: 'managed/fixture' });
	});

	it('refuses revert if the previous copy changed', async () => {
		const started = await start();
		await service.idle();
		await service.switch(started.id);
		await service.idle();
		transfer.repositories
			.get('storage-01.example.internal:managed/fixture')!
			.files.delete(`index/${hex('2')}`);
		await service.revert(started.id);
		await service.idle();
		const view = await service.get(started.id);
		expect(view.status).toBe('switched');
		expect(view.lastOperationFailure).toMatchObject({ operation: 'revert', code: 'source-changed' });
	});

	it('deletes the previous copy only after a successful backup and an exact confirmation', async () => {
		const started = await start();
		await service.idle();
		await service.switch(started.id);
		await service.idle();
		await expect(service.deleteSourceCopy(started.id, 'Fixture')).rejects.toThrow(
			'at least one successful backup'
		);
		successfulBackupAtNewLocation();
		const live = transfer.repositories.get('storage-02.example.internal:managed/fixture-moved')!;
		live.files.set(`snapshots/${hex('e')}`, 290);
		expect((await service.get(started.id)).actions).toMatchObject({ revert: false, deleteSource: true });
		await expect(service.revert(started.id)).rejects.toThrow('successful backup already exists');
		await expect(service.deleteSourceCopy(started.id, 'fixture')).rejects.toMatchObject({
			statusCode: 400,
		});
		// A file the live repository does not have means the previous location is not only ours.
		transfer.repositories
			.get('storage-01.example.internal:managed/fixture')!
			.files.set(`data/cd/${'cd' + hex('0').slice(2)}`, 1);
		await service.deleteSourceCopy(started.id, 'Fixture');
		await service.idle();
		let view = await service.get(started.id);
		expect(view.status).toBe('switched');
		expect(view.lastOperationFailure).toMatchObject({ operation: 'source-delete', code: 'source-changed' });
		expect(transfer.calls).not.toContain('purge');
		transfer.repositories
			.get('storage-01.example.internal:managed/fixture')!
			.files.delete(`data/cd/${'cd' + hex('0').slice(2)}`);
		await service.deleteSourceCopy(started.id, 'Fixture');
		await service.idle();
		view = await service.get(started.id);
		expect(view.status).toBe('source-deleted');
		expect(transfer.repositories.has('storage-01.example.internal:managed/fixture')).toBe(false);
		expect(store.retainedLocations()).toEqual([]);
	});

	it('marks an interrupted copy failed at startup and resumes the plan it paused', async () => {
		const now = Date.now();
		context.sqlite.exec('UPDATE plans SET active=0');
		store.create({
			id: 'f'.repeat(24),
			planId: 'plan-01',
			repositoryId: 'repo-01',
			source: { storageId: 'storage-01', storagePath: 'managed/fixture' },
			destination: { storageId: 'storage-02', storagePath: 'managed/fixture-moved' },
			status: 'copying',
			phase: 'copying',
			planWasActive: true,
			createdAt: now,
			updatedAt: now,
			audit: [],
		});
		await service.recoverInterrupted();
		const failed = await service.get('f'.repeat(24));
		expect(failed.status).toBe('failed');
		expect(failed.failureCode).toBe('server-restarted');
		expect(plan().active).toBe(1);
	});

	it('protects kept copies from other relocations', async () => {
		const started = await start();
		await service.idle();
		await service.switch(started.id);
		await service.idle();
		context.sqlite.exec(`
			INSERT INTO plans(id,title,source_id,source_type,method,storage_id,storage_path,source_config,settings)
			VALUES('plan-02','Other','app-01','device','backup','storage-02','managed/other','{}','{}');
			INSERT INTO remote_managed_repositories(id,plan_id,agent_id,storage_id,storage_path,encrypted_password,initialized_at)
			VALUES('repo-02','plan-02','agent-01','storage-02','managed/other','synthetic-cipher',1);
		`);
		await expect(
			start({ planId: 'plan-02', storageId: 'storage-01', storagePath: 'managed/fixture' })
		).rejects.toThrow('overlaps');
		const references = await new PlanStore(drizzle(context.sqlite) as any).getStorageRemovalReferences();
		expect(references).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ storageId: 'storage-01', storagePath: 'managed/fixture', kind: 'retained' }),
			])
		);
	});
});

import Cryptr from 'cryptr';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { configService } from '../../src/services/ConfigService';
import { PlanStore } from '../../src/stores/PlanStore';
import { StorageStore } from '../../src/stores/StorageStore';
import { ManagedReplicationStore } from '../../src/stores/ManagedReplicationStore';
import { configureReplicaScopeResolver } from '../../src/utils/managedReplicationPolicy';
import {
	replicaRepositoryIdentity,
	replicaRepositoryScope,
	replicaScopesOverlap,
	replicaStorageKind,
	requiredReplicaKind,
	sftpRepositoryIdentity,
} from '../../src/utils/managedReplicaIdentity';
import { fixture } from '../integration/persistentRestore.fixture';

const cipher = () => new Cryptr(configService.config.SECRET);
const sftpStorage = (values: Record<string, string> = {}, settings: Record<string, unknown> = {}) =>
	({
		id: 'sftp-01',
		type: 'sftp',
		settings,
		credentials: Object.fromEntries(
			Object.entries({ host: 'SFTP.Example.Internal', user: 'backup', pass: 'synthetic-pass', ...values }).map(
				([key, value]) => [key, cipher().encrypt(value)]
			)
		),
	}) as any;

describe('managed replica identities (S3_PRIMARY_REPLICATION.md 3)', () => {
	it('names the replica kind each primary may use', () => {
		expect(replicaStorageKind('sftp')).toBe('sftp');
		expect(replicaStorageKind('s3')).toBe('s3');
		expect(replicaStorageKind('s3compatible')).toBe('s3');
		expect(replicaStorageKind('ftp')).toBeUndefined();
		expect(requiredReplicaKind('sftp')).toBe('s3');
		expect(requiredReplicaKind('s3compatible')).toBe('sftp');
		expect(requiredReplicaKind('local')).toBeUndefined();
	});

	it('identifies an SFTP replica by account, host, port and normalized folder only', () => {
		const identity = sftpRepositoryIdentity(sftpStorage(), 'replicas//app-01/./');
		expect(identity).toMatchObject({
			authority: 'sftp://backup@sftp.example.internal:22/~',
			prefix: 'replicas/app-01',
		});
		expect(identity.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(identity)).not.toContain('synthetic-pass');
		expect(sftpRepositoryIdentity(sftpStorage({ port: '2222' }), '/srv/replicas/app-01')).toMatchObject({
			authority: 'sftp://backup@sftp.example.internal:2222/',
			prefix: 'srv/replicas/app-01',
		});
		// The port may live in the plain settings of an older storage record.
		expect(sftpRepositoryIdentity(sftpStorage({}, { port: 2200 }), 'replicas/app-01').authority).toBe(
			'sftp://backup@sftp.example.internal:2200/~'
		);
		expect(replicaRepositoryIdentity(sftpStorage(), 'replicas/app-01')).toEqual(
			sftpRepositoryIdentity(sftpStorage(), 'replicas/app-01')
		);
	});

	it('keeps home-relative and absolute folders apart and gives each a distinct fingerprint', () => {
		const relative = sftpRepositoryIdentity(sftpStorage(), 'replicas/app-01');
		const absolute = sftpRepositoryIdentity(sftpStorage(), '/replicas/app-01');
		expect(relative.prefix).toBe(absolute.prefix);
		expect(relative.authority).not.toBe(absolute.authority);
		expect(relative.fingerprint).not.toBe(absolute.fingerprint);
		expect(replicaScopesOverlap(relative, absolute)).toBe(false);
	});

	it.each(['', '/', '.', '../replicas', 'replicas/../other', 'replicas\\app', 'replicas/\napp'])(
		'refuses the unsafe or root SFTP replica folder %j',
		path => {
			expect(() => sftpRepositoryIdentity(sftpStorage(), path)).toThrow(
				expect.objectContaining({ statusCode: 400 })
			);
		}
	);

	it.each([
		[{ host: '' }],
		[{ user: '' }],
		[{ port: '70000' }],
		[{ port: 'ssh' }],
		[{ host: 'a/b.example.internal' }],
	])('refuses an SFTP storage without a usable account %j', values => {
		expect(() => sftpRepositoryIdentity(sftpStorage(values), 'replicas/app-01')).toThrow(
			expect.objectContaining({ statusCode: 400 })
		);
	});

	it('scopes a plan reference so an empty folder owns its whole namespace', () => {
		const root = replicaRepositoryScope(sftpStorage(), '');
		const child = replicaRepositoryScope(sftpStorage(), 'replicas/app-01');
		expect(root).toEqual({ authority: 'sftp://backup@sftp.example.internal:22/~', prefix: '' });
		expect(replicaScopesOverlap(root, child)).toBe(true);
		expect(replicaScopesOverlap(child, replicaRepositoryScope(sftpStorage(), 'replicas/app-010'))).toBe(false);
		expect(replicaScopesOverlap(child, replicaRepositoryScope(sftpStorage(), 'replicas/app-01/sub'))).toBe(true);
	});
});

describe('SFTP replica ownership in the plan and storage write transactions', () => {
	let context: ReturnType<typeof fixture>, store: ManagedReplicationStore;
	const identity = () => sftpRepositoryIdentity(sftpStorage(), 'replicas/app-01');
	beforeEach(() => {
		configureReplicaScopeResolver(replicaRepositoryScope);
		context = fixture();
		const storage = sftpStorage();
		context.sqlite
			.prepare('INSERT INTO storages(id,name,type,credentials,settings) VALUES(?,?,?,?,?)')
			.run('sftp-01', 'SFTP replica', 'sftp', JSON.stringify(storage.credentials), '{}');
		context.sqlite.exec("INSERT INTO devices(id,name) VALUES('main','Synthetic server')");
		store = new ManagedReplicationStore(context.sqlite);
	});
	afterEach(() => {
		configureReplicaScopeResolver(undefined);
		context.sqlite.close();
	});

	it('refuses another plan inside a reserved SFTP replica folder and allows a sibling', async () => {
		store.reserveDestination({
			destinationFingerprint: identity().fingerprint,
			planId: 'plan-01',
			replicationId: 'replica-sftp',
			sourceRepositoryId: 'repo-01',
			destinationStorageId: 'sftp-01',
			destinationStoragePath: 'replicas/app-01',
			destinationAuthority: identity().authority,
			destinationPrefix: identity().prefix,
		});
		const plans = new PlanStore(drizzle(context.sqlite) as any);
		const base: any = {
			id: 'standard-01',
			title: 'Synthetic standard plan',
			sourceId: 'main',
			sourceType: 'device',
			method: 'backup',
			sourceConfig: { includes: ['/srv/example-app'] },
			storageId: 'sftp-01',
			settings: {},
		};
		for (const storagePath of ['replicas/app-01', 'replicas/app-01/child', 'replicas', ''])
			await expect(plans.create({ ...base, storagePath })).rejects.toMatchObject({ statusCode: 409 });
		await plans.create({ ...base, storagePath: 'replicas/app-010' });
		// The same folder through an absolute path is another namespace; the empty-target proof guards it.
		await plans.create({ ...base, id: 'standard-02', storagePath: '/replicas/app-01' });
	});

	it('refuses reserving an SFTP replica inside another plan folder', async () => {
		const plans = new PlanStore(drizzle(context.sqlite) as any);
		await plans.create({
			id: 'standard-01',
			title: 'Synthetic standard plan',
			sourceId: 'main',
			sourceType: 'device',
			method: 'backup',
			sourceConfig: { includes: ['/srv/example-app'] },
			storageId: 'sftp-01',
			storagePath: 'replicas',
			settings: {},
		} as any);
		expect(() =>
			store.reserveDestination({
				destinationFingerprint: identity().fingerprint,
				planId: 'plan-01',
				replicationId: 'replica-sftp',
				sourceRepositoryId: 'repo-01',
				destinationStorageId: 'sftp-01',
				destinationStoragePath: 'replicas/app-01',
				destinationAuthority: identity().authority,
				destinationPrefix: identity().prefix,
			})
		).toThrow(expect.objectContaining({ statusCode: 409 }));
	});

	it('refuses redirecting an SFTP storage bound to a replica to another host or account', async () => {
		store.reserveDestination({
			destinationFingerprint: identity().fingerprint,
			planId: 'plan-01',
			replicationId: 'replica-sftp',
			sourceRepositoryId: 'repo-01',
			destinationStorageId: 'sftp-01',
			destinationStoragePath: 'replicas/app-01',
			destinationAuthority: identity().authority,
			destinationPrefix: identity().prefix,
		});
		const storages = new StorageStore(drizzle(context.sqlite) as any);
		for (const values of [{ host: 'other.example.internal' }, { user: 'other' }, { port: '2222' }])
			await expect(
				storages.update('sftp-01', { credentials: sftpStorage(values).credentials })
			).rejects.toMatchObject({ statusCode: 409 });
		// A new password for the same account keeps the binding.
		await expect(
			storages.update('sftp-01', { credentials: sftpStorage({ pass: 'rotated-pass' }).credentials })
		).resolves.toBeDefined();
	});
});

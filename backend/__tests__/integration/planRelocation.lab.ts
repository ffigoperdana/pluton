/**
 * Disposable plan repository relocation lab: two real `rclone serve sftp`
 * servers on loopback inside a network-none container, real Restic
 * repositories, the production relocation service, store and transfer code.
 * No external endpoint, credential or production identifier is used.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import Cryptr from 'cryptr';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db, sqlite } from '../../src/db';
import { configService } from '../../src/services/ConfigService';
import { PlanStore } from '../../src/stores/PlanStore';
import { StorageStore } from '../../src/stores/StorageStore';
import { RemoteManagedRepositoryStore } from '../../src/stores/RemoteManagedRepositoryStore';
import { PlanRepositoryRelocationStore } from '../../src/stores/PlanRepositoryRelocationStore';
import { PlanRepositoryRelocationService } from '../../src/services/PlanRepositoryRelocationService';
import { RemoteBackupService } from '../../src/services/RemoteBackupService';
import { SftpRepositoryTransfer } from '../../src/utils/relocation/SftpRepositoryTransfer';
import { ManagedSftpRepositorySession } from '../../src/utils/restic/ManagedSftpRepositorySession';
import { restic, rclone, port, ready } from './managedDownloadRecovery.helpers';

const exec = promisify(execFile);
const step = (name: string) => console.log(`PHASE ${name}`);
const secret = configService.config.SECRET;
const root = await fs.mkdtemp('/lab/relocation-');
const serverA = path.join(root, 'sftp-a'),
	serverB = path.join(root, 'sftp-b'),
	sourceData = path.join(root, 'source');
const repositoryA = path.join(serverA, 'managed', 'app-01'),
	repositoryB = path.join(serverB, 'managed', 'app-01');
const password = crypto.randomBytes(32).toString('hex');
const sftpPasswordA = crypto.randomBytes(24).toString('hex'),
	sftpPasswordB = crypto.randomBytes(24).toString('hex');
const portA = await port(),
	portB = await port();
const children: ReturnType<typeof spawn>[] = [];
let serverAProcess: ReturnType<typeof spawn> | undefined;
let serverBProcess: ReturnType<typeof spawn> | undefined;

const resticLocal = async (repository: string, args: string[], cwd?: string) =>
	(
		await exec(restic, ['--no-cache', '-r', repository, ...args], {
			env: { ...process.env, RESTIC_PASSWORD: password },
			cwd,
			encoding: 'utf8',
			timeout: 120_000,
			maxBuffer: 16 * 1024 ** 2,
		})
	).stdout;
const serve = async (directory: string, listen: number, pass: string) => {
	const child = spawn(
		rclone,
		[
			'serve',
			'sftp',
			directory,
			'--addr',
			'127.0.0.1:' + listen,
			'--user',
			'fixture-user',
			'--pass',
			pass,
			'--cache-dir',
			path.join(root, 'cache-' + listen),
		],
		{ stdio: 'ignore' }
	);
	children.push(child);
	await ready(listen);
	return child;
};
const stop = async (child?: ReturnType<typeof spawn>) => {
	if (!child || child.exitCode !== null) return;
	child.kill('SIGTERM');
	await new Promise<void>(resolve => child.once('close', () => resolve()));
};
/**
 * `rclone serve sftp` caches directory listings; a real OpenSSH server does not.
 * Every out-of-band disk edit therefore restarts both loopback servers.
 */
const outOfBand = async (edit: () => Promise<unknown>) => {
	await stop(serverAProcess);
	await stop(serverBProcess);
	await edit();
	serverAProcess = await serve(serverA, portA, sftpPasswordA);
	serverBProcess = await serve(serverB, portB, sftpPasswordB);
};
const listFiles = async (directory: string): Promise<string[]> => {
	const result: string[] = [];
	const walk = async (current: string) => {
		for (const entry of await fs.readdir(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) await walk(full);
			else result.push(path.relative(directory, full).split(path.sep).join('/'));
		}
	};
	await walk(directory);
	return result.sort();
};
const backupInto = async (repository: string, backupId: string) => {
	await fs.writeFile(path.join(sourceData, `${backupId}.bin`), crypto.randomBytes(256 * 1024));
	await resticLocal(repository, [
		'backup',
		sourceData,
		'--tag',
		'pluton-plan-plan-01',
		'--tag',
		`pluton-backup-${backupId}`,
	]);
	const snapshots = JSON.parse(await resticLocal(repository, ['snapshots', '--json'])) as {
		id: string;
		tags: string[];
	}[];
	return snapshots.find(snapshot => snapshot.tags.includes(`pluton-backup-${backupId}`))!.id;
};
const addBackupRow = (backupId: string, snapshotId: string, storageId: string, storagePath: string) =>
	sqlite
		.prepare(
			`INSERT INTO backups(id,plan_id,source_id,source_type,method,storage_id,storage_path,status,in_progress,success,encryption,completion_stats,started_at)
			 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,unixepoch())`
		)
		.run(
			backupId,
			'plan-01',
			'app-01',
			'device',
			'backup',
			storageId,
			storagePath,
			'completed',
			0,
			1,
			1,
			JSON.stringify({ snapshot_id: snapshotId, sourcePaths: [sourceData] })
		);
const binding = () => ({
	plan: sqlite.prepare("SELECT storage_id AS s, storage_path AS p, active FROM plans WHERE id='plan-01'").get(),
	repository: sqlite
		.prepare("SELECT storage_id AS s, storage_path AS p FROM remote_managed_repositories WHERE id='repo-01'")
		.get(),
	backups: sqlite
		.prepare("SELECT id, storage_id AS s FROM backups WHERE plan_id='plan-01' ORDER BY id")
		.all(),
});

try {
	step('prepare');
	migrate(db, { migrationsFolder: '/reviewed/drizzle' });
	await fs.mkdir(path.dirname(repositoryA), { recursive: true });
	await fs.mkdir(path.join(serverB, 'managed'), { recursive: true });
	await fs.mkdir(path.join(serverA, 'managed', 'app-02-unrelated'), { recursive: true });
	await fs.writeFile(path.join(serverA, 'managed', 'app-02-unrelated', 'keep.txt'), 'unrelated\n');
	await fs.mkdir(sourceData, { recursive: true });
	await resticLocal(repositoryA, ['init']);
	const snapshot1 = await backupInto(repositoryA, 'backup-01');
	const snapshot2 = await backupInto(repositoryA, 'backup-02');
	// A stale lock must never be copied.
	await fs.mkdir(path.join(repositoryA, 'locks'), { recursive: true });
	await fs.writeFile(path.join(repositoryA, 'locks', 'f'.repeat(64)), 'stale lock\n');

	const cipher = new Cryptr(secret);
	const storage = (id: string, name: string, listen: number, pass: string) =>
		sqlite
			.prepare('INSERT INTO storages(id,name,type,settings,credentials) VALUES(?,?,?,?,?)')
			.run(
				id,
				name,
				'sftp',
				JSON.stringify({ host: '127.0.0.1', port: String(listen), user: 'fixture-user' }),
				JSON.stringify({ pass: cipher.encrypt(pass) })
			);
	storage('storage-a', 'Fixture SFTP A', portA, sftpPasswordA);
	storage('storage-b', 'Fixture SFTP B', portB, sftpPasswordB);
	sqlite.exec(`
		INSERT INTO devices(id,name) VALUES('app-01','Fixture app');
		INSERT INTO agent_identities(agent_id,device_id,encrypted_secret,hostname,os,architecture,agent_version,capabilities)
		VALUES('agent-01','app-01','synthetic-cipher','app-01','Linux','x86_64','0.7.1','{}');
		INSERT INTO plans(id,title,source_id,source_type,method,storage_id,storage_path,source_config,settings,active)
		VALUES('plan-01','Fixture App','app-01','device','backup','storage-a','managed/app-01','{"includes":["/srv/example-app"]}','{}',1);
	`);
	sqlite
		.prepare(
			'INSERT INTO remote_managed_repositories(id,plan_id,agent_id,storage_id,storage_path,encrypted_password,initialized_at) VALUES(?,?,?,?,?,?,unixepoch())'
		)
		.run('repo-01', 'plan-01', 'agent-01', 'storage-a', 'managed/app-01', cipher.encrypt(password));
	addBackupRow('backup-01', snapshot1, 'storage-a', 'managed/app-01');
	addBackupRow('backup-02', snapshot2, 'storage-a', 'managed/app-01');

	const planStore = new PlanStore(db);
	const storageStore = new StorageStore(db);
	const relocationStore = new PlanRepositoryRelocationStore(sqlite);
	// The production SFTP allowlist/decryption, without constructing scheduler side effects.
	const access = {
		getSftpRecoveryOptions: (storageId: string) =>
			(RemoteBackupService.prototype as any).materializeSftpStorage
				.call({ storageStore, encryptionSecret: secret }, storageId)
				.then((result: { options: Record<string, string> }) => result.options),
	};
	const service = new PlanRepositoryRelocationService(
		relocationStore,
		planStore,
		new RemoteManagedRepositoryStore(db),
		storageStore,
		access,
		{
			pause: async planId => void (await planStore.setActive(planId, false)),
			resume: async planId => void (await planStore.setActive(planId, true)),
		},
		() => false,
		new SftpRepositoryTransfer(),
		secret
	);
	const settle = async (id: string) => {
		await service.idle();
		return service.get(id);
	};
	const start = () =>
		service.start({ planId: 'plan-01', storageId: 'storage-b', storagePath: 'managed/app-01' });
	serverAProcess = await serve(serverA, portA, sftpPasswordA);

	step('destination-unreachable');
	const unreachable = await settle((await start()).id);
	assert.equal(unreachable.status, 'failed');
	assert.equal(unreachable.failureCode, 'network-unavailable');
	assert.deepEqual(binding().plan, { s: 'storage-a', p: 'managed/app-01', active: 1 });

	step('corrupt-existing-copy');
	await fs.cp(repositoryA, repositoryB, { recursive: true });
	await fs.rm(path.join(repositoryB, 'locks'), { recursive: true, force: true });
	const pack = (await listFiles(repositoryB)).find(name => name.startsWith('data/'))!;
	const bytes = await fs.readFile(path.join(repositoryB, pack));
	bytes[Math.floor(bytes.length / 2)] ^= 0xff; // same size, different content
	await fs.chmod(path.join(repositoryB, pack), 0o600); // Restic writes packs read-only
	await fs.writeFile(path.join(repositoryB, pack), bytes);
	serverBProcess = await serve(serverB, portB, sftpPasswordB);
	const corrupt = await settle((await start()).id);
	assert.equal(corrupt.status, 'failed');
	assert.equal(corrupt.failureCode, 'destination-hash-mismatch');
	assert.equal(binding().plan.active, 1);

	step('retry-after-repair');
	await outOfBand(async () => {
		await fs.rm(path.join(repositoryB, pack));
		// An interrupted upload leaves an Rclone temporary; the retry removes only that.
		await fs.writeFile(path.join(repositoryB, 'index', 'e'.repeat(64) + '.a1b2c3.partial'), 'partial');
	});
	const ready1 = await settle((await start()).id);
	assert.equal(ready1.status, 'ready', JSON.stringify({ code: ready1.failureCode, audit: ready1.audit }));
	assert.equal(ready1.evidence!.snapshotCount, 2);
	assert.equal(binding().plan.active, 0);
	assert.equal((await listFiles(repositoryB)).some(name => name.startsWith('locks/')), false);
	assert.equal((await listFiles(repositoryB)).some(name => name.endsWith('.partial')), false);
	assert.deepEqual(
		(await listFiles(repositoryA)).filter(name => !name.startsWith('locks/')),
		await listFiles(repositoryB)
	);

	step('source-changed-before-switch');
	let snapshotOutside = '';
	await outOfBand(async () => {
		// The synthetic stale lock has served its purpose; Restic itself rejects it.
		await fs.rm(path.join(repositoryA, 'locks', 'f'.repeat(64)));
		snapshotOutside = await backupInto(repositoryA, 'outside-writer');
	});
	await service.switch(ready1.id);
	const changed = await settle(ready1.id);
	assert.equal(changed.status, 'failed');
	assert.equal(changed.failureCode, 'source-changed');
	assert.deepEqual(binding().plan, { s: 'storage-a', p: 'managed/app-01', active: 1 });
	// The outside snapshot has no backup record; keep it, it is just repository content.
	assert.match(snapshotOutside, /^[a-f0-9]{64}$/);

	step('copy-delta-and-switch');
	const ready2 = await settle((await start()).id);
	assert.equal(ready2.status, 'ready', JSON.stringify({ code: ready2.failureCode, phase: ready2.phase }));
	assert.equal(ready2.evidence!.snapshotCount, 3);
	// Real Rclone counters: only the delta was transferred, every file was hashed.
	assert.ok(ready2.progress!.copiedBytes! > 0 && ready2.progress!.copiedFiles! > 0);
	assert.ok(ready2.progress!.copiedFiles! < ready2.evidence!.fileCount);
	assert.equal(ready2.progress!.verifiedFiles, ready2.evidence!.fileCount);
	await service.switch(ready2.id);
	const switched = await settle(ready2.id);
	assert.equal(switched.status, 'switched');
	assert.deepEqual(binding(), {
		plan: { s: 'storage-b', p: 'managed/app-01', active: 1 },
		repository: { s: 'storage-b', p: 'managed/app-01' },
		backups: [
			{ id: 'backup-01', s: 'storage-b' },
			{ id: 'backup-02', s: 'storage-b' },
		],
	});

	step('browse-from-new-location');
	const options = await access.getSftpRecoveryOptions('storage-b');
	await new ManagedSftpRepositorySession().withSession(
		{ options, password, repositoryPath: 'managed/app-01' },
		async session => {
			for (const id of [snapshot1, snapshot2]) assert.equal((await session.snapshot(id)).id, id);
			assert.equal(await session.identity!(), ready2.evidence!.repositoryConfigId);
		}
	);

	step('revert-and-move-again');
	await service.revert(switched.id);
	const reverted = await settle(switched.id);
	assert.equal(reverted.status, 'reverted', JSON.stringify(reverted.lastOperationFailure));
	assert.deepEqual(binding().plan, { s: 'storage-a', p: 'managed/app-01', active: 1 });
	const ready3 = await settle((await start()).id);
	assert.equal(ready3.status, 'ready');
	await service.switch(ready3.id);
	assert.equal((await settle(ready3.id)).status, 'switched');

	step('backup-at-new-location');
	let snapshot3 = '';
	await outOfBand(async () => {
		snapshot3 = await backupInto(repositoryB, 'backup-03');
	});
	addBackupRow('backup-03', snapshot3, 'storage-b', 'managed/app-01');
	const afterBackup = await service.get(ready3.id);
	assert.deepEqual(afterBackup.actions, { cancel: false, switch: false, revert: false, deleteSource: true });
	await assert.rejects(service.revert(ready3.id), /successful backup already exists/);

	step('delete-previous-copy-guards');
	await assert.rejects(service.deleteSourceCopy(ready3.id, 'fixture app'), /Type the plan name/);
	await outOfBand(() => fs.writeFile(path.join(repositoryA, 'notes.txt'), 'operator file\n'));
	await service.deleteSourceCopy(ready3.id, 'Fixture App');
	const refused = await settle(ready3.id);
	assert.equal(refused.status, 'switched');
	assert.equal(refused.lastOperationFailure?.code, 'unexpected-repository-file');
	await outOfBand(() => fs.rm(path.join(repositoryA, 'notes.txt')));

	step('delete-previous-copy');
	await service.deleteSourceCopy(ready3.id, 'Fixture App');
	const deleted = await settle(ready3.id);
	assert.equal(deleted.status, 'source-deleted', JSON.stringify(deleted.lastOperationFailure));
	await assert.rejects(fs.stat(repositoryA));
	assert.equal(
		await fs.readFile(path.join(serverA, 'managed', 'app-02-unrelated', 'keep.txt'), 'utf8'),
		'unrelated\n'
	);
	assert.equal(JSON.parse(await resticLocal(repositoryB, ['snapshots', '--json'])).length, 4);

	step('shutdown');
	await service.shutdown();
	console.log('PASS plan repository relocation lab');
} finally {
	for (const child of children) await stop(child);
	await fs.rm(root, { recursive: true, force: true });
}

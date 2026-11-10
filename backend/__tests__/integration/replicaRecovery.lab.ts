import Cryptr from 'cryptr';
import { ManagedRepositoryAccessError } from '../../src/utils/restic/ManagedSftpRepositorySession';
import Database from 'better-sqlite3';
import { AssistedRecoveryStore } from '../../src/stores/AssistedRecoveryStore';
import { AssistedRecoveryService } from '../../src/services/AssistedRecoveryService';
import { RemoteRepositoryRecoveryService } from '../../src/services/RemoteRepositoryRecoveryService';
import { configService } from '../../src/services/ConfigService';
/** Real Restic SFTP -> SigV4 HTTPS S3 copy and read-only staged restore.
 * No external endpoints or credentials; both servers are loopback in network-none Docker. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { replicaFixture } from '../fixtures/replicaRecovery.fixture';
import { ManagedReplicationExecutor } from '../../src/utils/restic/ManagedReplicationExecutor';
import { storageRcloneOptions, trustEnvironment } from '../../src/utils/storageSecurity';
import { restic, rclone, port, ready, hashTree } from './managedDownloadRecovery.helpers';
const exec = promisify(execFile);
assert.equal(process.getuid?.(), 1000);
assert.equal(
	(await fs.readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim(),
	String(4 * 1024 ** 3)
);
const root = await fs.mkdtemp('/lab/replica-'),
	source = path.join(root, 'source'),
	repository = path.join(root, 'sftp', 'application'),
	s3root = path.join(root, 's3');
const password = crypto.randomBytes(32).toString('hex'),
	sftpPassword = crypto.randomBytes(32).toString('hex');
const sftpPort = await port(),
	s3Port = await port();
const signal = AbortSignal.timeout(180_000);
const children: ReturnType<typeof spawn>[] = [];
const command = async (args: string[], cwd?: string) => {
	try {
		return (
			await exec(restic, ['--no-cache', '-r', repository, ...args], {
				env: { ...process.env, RESTIC_PASSWORD: password },
				cwd,
				encoding: 'utf8',
				timeout: 180000,
				maxBuffer: 8 * 1024 ** 2,
			})
		).stdout;
	} catch {
		throw new Error('Disposable Restic command failed.');
	}
};
const start = async (args: string[]) => {
	const child = spawn(rclone, args, { stdio: 'ignore' });
	children.push(child);
	return child;
};
try {
	await fs.copyFile('/test-trust/ca.pem', path.join(root, 'ca.pem'));
	await fs.chmod(path.join(root, 'ca.pem'), 0o444);
	process.env.PLUTON_STORAGE_CA_FILE = path.join(root, 'ca.pem');
	await fs.mkdir(source, { recursive: true });
	await fs.mkdir(repository, { recursive: true });
	await fs.mkdir(path.join(s3root, 'bucket-01'), { recursive: true });
	await fs.mkdir(path.join(source, 'nested'));
	await fs.writeFile(path.join(source, 'file.txt'), 'synthetic replica file\n');
	await fs.writeFile(path.join(source, 'nested', 'data.bin'), crypto.randomBytes(4 * 1024 ** 2));
	await fs.symlink('file.txt', path.join(source, 'safe-link'));
	const workspace = path.join(root, 'job'),
		sqlPath = path.join(workspace, 'pluton', 'database', 'example.sql'),
		sql = 'CREATE TABLE example(value INTEGER);\nINSERT INTO example VALUES(1);\n';
	await fs.mkdir(path.dirname(sqlPath), { recursive: true });
	await fs.writeFile(sqlPath, sql);
	await command(['init']);
	await command(
		[
			'backup',
			source,
			'pluton/database/example.sql',
			'--tag',
			'pluton-plan-plan-01',
			'--tag',
			'pluton-backup-backup-01',
		],
		workspace
	);
	const metadata = JSON.parse(await command(['snapshots', '--json']));
	assert.equal(metadata.length, 1);
	const f = replicaFixture(
		path.join(root, 'indexes'),
		undefined,
		'https://127.0.0.1:' + s3Port,
		password
	);
	f.backup.completionStats.snapshot_id = metadata[0].id;
	f.backup.completionStats.sourcePaths = [source];
	f.backup.completionStats.lifecycle = {
		database: {
			path: '/pluton/database/example.sql',
			bytes: Buffer.byteLength(sql),
			sha256: crypto.createHash('sha256').update(sql).digest('hex'),
		},
	};
	f.refreshBinding();
	const sftp = await start([
		'serve',
		'sftp',
		path.dirname(repository),
		'--addr',
		'127.0.0.1:' + sftpPort,
		'--user',
		'fixture-user',
		'--pass',
		sftpPassword,
		'--cache-dir',
		path.join(root, 'sftp-cache'),
	]);
	await ready(sftpPort);
	await start([
		'serve',
		's3',
		s3root,
		'--addr',
		'127.0.0.1:' + s3Port,
		'--auth-key',
		'synthetic-access-key,synthetic-secret-key',
		'--cert',
		'/test-trust/ca.pem',
		'--key',
		'/test-trust/key.pem',
		'--cache-dir',
		path.join(root, 's3-cache'),
	]);
	await ready(s3Port);
	const executor = new ManagedReplicationExecutor();
	const input = {
		access: {
			options: {
				host: '127.0.0.1',
				port: String(sftpPort),
				user: 'fixture-user',
				pass: sftpPassword,
			},
			repositoryPath: 'application',
			password,
		},
		planId: 'plan-01',
		backupId: 'backup-01',
		snapshotId: metadata[0].id,
		artifacts: [f.backup.completionStats.lifecycle.database],
	};
	console.log('CHECK source repository proof');
	const proof = await executor.inspectSource(input, signal);
	assert.equal(proof.snapshot.id, metadata[0].id);
	let initialized = false,
		bound: string | undefined;
	console.log('CHECK actual Restic replica copy');
	const copied = await executor.copy({
		source: input,
		proof,
		destination: {
			options: { ...storageRcloneOptions(f.storage), force_path_style: 'true' },
			repositoryPath: f.replica.storagePath,
			environment: trustEnvironment(),
		},
		state: { repositoryConfigId: null, initialization: 'uninitialized' },
		beginInitialization: async () => {
			assert.equal(initialized, false);
			initialized = true;
		},
		bindRepository: async id => {
			assert(initialized);
			bound = id;
		},
		signal,
	});
	assert(bound);
	assert.equal(copied.repositoryConfigId, bound);
	assert.notEqual(
		copied.snapshotId,
		input.snapshotId,
		'Restic copy must exercise recorded differing destination ID'
	);
	Object.assign(f.receipt, {
		sourceSnapshotId: input.snapshotId,
		sourceRepositoryConfigId: proof.repositoryConfigId,
		sourceTreeId: proof.snapshot.tree,
		destinationSnapshotId: copied.snapshotId,
	});
	f.destination.actualRepositoryId = bound;
	f.plan.settings.replication.recoveryPolicy = 'assisted';
	const sqlite = new Database(':memory:');
	sqlite.exec(await fs.readFile('/reviewed/drizzle/0022_assisted_recovery.sql', 'utf8'));
	const state = new AssistedRecoveryStore(sqlite);
	const primary = new RemoteRepositoryRecoveryService(
		f.stores.repositories as any,
		f.stores.backups as any,
		f.stores.plans as any,
		{} as any,
		{ getSftpRecoveryOptions: async () => input.access.options },
		f.stores.agents as any,
		undefined,
		configService.config.SECRET,
		path.join(root, 'primary-stage')
	);
	const coordinator = () =>
		new AssistedRecoveryService(
			state,
			f.stores.plans as any,
			primary,
			f.service,
			path.join(root, 'assisted-stage')
		);
	let assisted = coordinator();
	const intent = () => ({
		planId: 'plan-01',
		backupId: 'backup-01',
		requestKey: crypto.randomUUID(),
		mode: 'prefer-primary' as const,
		includes: [],
		excludes: [],
	});
	const healthy = await assisted.start('owner-01', intent());
	await assisted.settled(healthy.id);
	assert.equal(assisted.get('owner-01', healthy.id).status, 'primary-ready');
	console.log('PASS healthy primary uses normal recovery without replica approval');
	const before = await hashTree(s3root);
	const preflight = await f.service.preflight('backup-01', 'plan-01', 'replica-01', signal);
	assert.equal(preflight.sourceSnapshotId, input.snapshotId);
	assert.equal(preflight.destinationSnapshotId, copied.snapshotId);
	console.log(
		'PASS real SFTP-to-HTTPS-S3 Restic copy, private CA, destination mapping and recovery preflight'
	);
	sftp.kill('SIGTERM');
	await new Promise<void>(resolve => sftp.once('close', () => resolve()));
	for (const selection of [
		[],
		[source],
		[path.join(source, 'file.txt')],
		['/pluton/database/example.sql'],
	]) {
		const target = await fs.mkdtemp(path.join(root, 'staged-'));
		const result = await f.service.withReplica(
			'backup-01',
			'plan-01',
			'replica-01',
			signal,
			async recovery =>
				recovery.replicaStage(
					await recovery.testBinding('backup-01', 'plan-01'),
					{ target: '', overwrite: 'never', delete: false, includes: selection, excludes: [] },
					target,
					signal,
					() => {},
					async () => {}
				),
			preflight.fingerprint
		);
		assert.equal(result.integrity, 'sha256-readback-and-restic-restore');
		if (!selection.length || selection[0] === source)
			assert.deepEqual(await hashTree(path.join(target, source.slice(1))), await hashTree(source));
		if (!selection.length || selection[0] === '/pluton/database/example.sql')
			assert.equal(
				await fs.readFile(path.join(target, 'pluton/database/example.sql'), 'utf8'),
				sql
			);
	}
	console.log(
		'PASS primary offline: full, directory, single-file and SQL artifact recovery with SHA256 and safe symlink checks'
	);
	assert.deepEqual(
		await hashTree(s3root),
		before,
		'Recovery must not write lock files or mutate replica'
	);
	console.log('PASS replica contents unchanged after preflight and all restores');
	const pending = await assisted.start('owner-01', intent());
	await assisted.settled(pending.id);
	console.log(
		'CHECK outage verdict',
		JSON.stringify({
			status: assisted.get('owner-01', pending.id).status,
			phase: assisted.get('owner-01', pending.id).phase,
			code: assisted.get('owner-01', pending.id).failureCode,
			candidates: assisted
				.get('owner-01', pending.id)
				.candidates.map(c => ({ state: c.state, code: c.code })),
		})
	);
	assert.equal(assisted.get('owner-01', pending.id).status, 'awaiting-approval');
	assert.equal(assisted.get('owner-01', pending.id).primary?.code, 'network-unavailable');
	assisted = coordinator(); // pending approval survives a new service instance
	assert.equal(assisted.list('owner-02', 'plan-01', 'backup-01').length, 0);
	await assisted.approve('owner-01', pending.id, 'replica-01');
	await assert.rejects(() => assisted.approve('owner-01', pending.id, 'replica-01'));
	await assisted.settled(pending.id);
	assert.equal(assisted.get('owner-01', pending.id).status, 'completed');
	const staged = path.join(root, 'assisted-stage', 'run-' + pending.id, 'files');
	assert.deepEqual(await hashTree(path.join(staged, source.slice(1))), await hashTree(source));
	assert.equal(await fs.readFile(path.join(staged, 'pluton/database/example.sql'), 'utf8'), sql);
	assert.deepEqual(await hashTree(s3root), before);
	await assisted.cancel('owner-01', pending.id);
	await assisted.shutdown();
	await primary.close();
	sqlite.close();
	console.log(
		'PASS real primary-down detection, durable owner approval, replay refusal, replica restore and explicit staging cleanup'
	);

	const encrypted = f.repository.encryptedPassword;
	f.repository.encryptedPassword = new Cryptr(configService.config.SECRET!).encrypt(
		crypto.randomBytes(32).toString('hex')
	);
	try {
		await assert.rejects(
			() => f.service.preflight('backup-01', 'plan-01', 'replica-01', AbortSignal.timeout(15_000)),
			error => error instanceof ManagedRepositoryAccessError && error.code === 'wrong-password'
		);
	} finally {
		f.repository.encryptedPassword = encrypted;
	}
	console.log('PASS wrong Restic encryption password fails closed');
	// A real TLS failure is not a reason to bypass certificate validation.
	const old = process.env.PLUTON_STORAGE_CA_FILE;
	delete process.env.PLUTON_STORAGE_CA_FILE;
	try {
		await assert.rejects(
			() => f.service.preflight('backup-01', 'plan-01', 'replica-01', AbortSignal.timeout(15_000)),
			error => error instanceof ManagedRepositoryAccessError && error.code === 'tls-invalid'
		);
	} finally {
		process.env.PLUTON_STORAGE_CA_FILE = old;
	}
	console.log('PASS untrusted private CA fails closed');
	console.log(
		'PROFILE',
		JSON.stringify({
			nodeRssBytes: process.memoryUsage().rss,
			cgroupPeakBytes: Number((await fs.readFile('/sys/fs/cgroup/memory.peak', 'utf8')).trim()),
			pidLimitEvents: (await fs.readFile('/sys/fs/cgroup/pids.events', 'utf8')).trim(),
		})
	);
} finally {
	for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
	await Promise.all(
		children.map(child =>
			child.exitCode !== null
				? Promise.resolve()
				: new Promise<void>(r => child.once('close', () => r()))
		)
	);
	await fs.rm(root, { recursive: true, force: true });
}

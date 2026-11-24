import Cryptr from 'cryptr';
import { ManagedRepositoryAccessError } from '../../src/utils/restic/ManagedSftpRepositorySession';
import { ManagedS3RecoverySession } from '../../src/utils/restic/ManagedS3RecoverySession';
import Database from 'better-sqlite3';
import { AssistedRecoveryStore } from '../../src/stores/AssistedRecoveryStore';
import { AssistedRecoveryService } from '../../src/services/AssistedRecoveryService';
import { RemoteRepositoryRecoveryService } from '../../src/services/RemoteRepositoryRecoveryService';
import { configService } from '../../src/services/ConfigService';
import { RemoteBackupService } from '../../src/services/RemoteBackupService';
/** Real Restic SFTP -> SigV4 HTTPS S3 copy and read-only staged restore.
 * No external endpoints or credentials; both servers are loopback in network-none Docker. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Writable } from 'node:stream';
import { replicaFixture } from '../fixtures/replicaRecovery.fixture';
import { exerciseReplicaArchiveFaults } from './replicaArchiveFaults.fixture';
import {
	ManagedReplicationError,
	ManagedReplicationExecutor,
} from '../../src/utils/restic/ManagedReplicationExecutor';
import { VerifiedReplicaRecoveryService } from '../../src/services/VerifiedReplicaRecoveryService';
import { sftpRepositoryIdentity } from '../../src/utils/managedReplicaIdentity';
import { replicaSourceBinding } from '../../src/utils/replicaSourceBinding';
import { storageRcloneOptions, trustEnvironment } from '../../src/utils/storageSecurity';
import { restic, rclone, port, ready, hashTree } from './managedDownloadRecovery.helpers';
const exec = promisify(execFile);
assert.equal(process.getuid?.(), 1000);
assert.equal(
	(await fs.readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim(),
	String(4 * 1024 ** 3)
);
const root = await fs.mkdtemp('/lab/replica-'),
	caPath = path.join(root, 'ca.pem'),
	keyPath = path.join(root, 'key.pem'),
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
	assert.deepEqual(await fs.readdir('/test-trust'), ['ca.pem']);
	await fs.copyFile('/test-trust/ca.pem', caPath);
	await fs.chmod(caPath, 0o444);
	// The runner supplies the disposable TLS key through stdin. Keep it on private tmpfs.
	await fs.writeFile(keyPath, readFileSync(0), { flag: 'wx', mode: 0o600 });
	process.env.PLUTON_STORAGE_CA_FILE = caPath;
	await fs.mkdir(source, { recursive: true });
	await fs.mkdir(repository, { recursive: true });
	await fs.mkdir(path.join(s3root, 'bucket-01'), { recursive: true });
	await fs.mkdir(path.join(source, 'nested'));
	await fs.writeFile(path.join(source, 'file.txt'), 'synthetic replica file\n');
	const dense = path.join(source, 'a-entries');
	await fs.mkdir(dense);
	for (let n = 0; n < 4352; n += 32)
		await Promise.all(
			Array.from({ length: 32 }, (_, i) =>
				fs.writeFile(path.join(dense, String(n + i).padStart(4, '0')), '')
			)
		);
	const data = path.join(source, 'nested');
	for (let n = 0; n < 12; n++)
		await fs.writeFile(path.join(data, 'file-' + n), crypto.randomBytes(384 * 1024));
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
		caPath,
		'--key',
		keyPath,
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
	f.plan.settings.replication.recoveryPolicy = 'automatic';
	const healthyAutomatic = await assisted.start('owner-01', intent());
	await assisted.settled(healthyAutomatic.id);
	assert.equal(assisted.get('owner-01', healthyAutomatic.id).status, 'primary-ready');
	assert.equal(assisted.get('owner-01', healthyAutomatic.id).sourceSelection, undefined);
	f.plan.settings.replication.recoveryPolicy = 'assisted';
	console.log('PASS Automatic Failover prefers a healthy real primary without touching any replica');
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
		[data],
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
		if (!selection.length) {
			assert.equal(result.stats.total_files, 4366);
			assert.deepEqual(await hashTree(path.join(target, source.slice(1))), await hashTree(source));
		} else if (selection[0] === data) {
			assert.deepEqual(await hashTree(path.join(target, data.slice(1))), await hashTree(data));
		}
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
	// docs/S3_AGENT_REPOSITORY_DESIGN.md 6.1.3 and 6.6: the same HTTPS S3 repository, bound
	// as an Agent plan's primary. SFTP is already stopped, so every read must use S3.
	console.log('CHECK S3 primary read path');
	const sqlArtifact = {
		databaseId: 'db_example',
		engine: 'mysql' as const,
		database: 'example',
		path: '/pluton/database/example.sql',
		bytes: Buffer.byteLength(sql),
		sha256: crypto.createHash('sha256').update(sql).digest('hex'),
	};
	const s3PrimaryBackup = {
		...f.backup,
		storageId: f.storage.id,
		storagePath: f.replica.storagePath,
		completionStats: {
			...f.backup.completionStats,
			snapshot_id: copied.snapshotId,
			lifecycle: { warnings: [], databases: [sqlArtifact] },
		},
	};
	const s3PrimaryPlan = {
		...f.plan,
		storageId: f.storage.id,
		storagePath: f.replica.storagePath,
		settings: { replication: { enabled: false, concurrent: false, storages: [] } },
	};
	const s3PrimaryRepository = {
		...f.repository,
		storageId: f.storage.id,
		storagePath: f.replica.storagePath,
	};
	// The production read-option method, without constructing scheduler side effects.
	const s3Remote = Object.assign(Object.create(RemoteBackupService.prototype), {
		storageStore: { getById: async (id: string) => (id === f.storage.id ? f.storage : null) },
		encryptionSecret: configService.config.SECRET,
	}) as RemoteBackupService;
	await fs.mkdir(path.join(root, 's3-primary'));
	const s3PrimarySignal = AbortSignal.timeout(120_000);
	const s3PrimaryRecovery = new RemoteRepositoryRecoveryService(
		{ getByPlanId: async () => s3PrimaryRepository } as any,
		{ getById: async () => s3PrimaryBackup } as any,
		{ getById: async () => s3PrimaryPlan } as any,
		{} as any,
		s3Remote,
		f.stores.agents as any,
		undefined,
		configService.config.SECRET,
		path.join(root, 's3-primary', 'stage')
	);
	try {
		const listing = await s3PrimaryRecovery.browse('backup-01');
		assert(listing.some(file => file.path === path.join(source, 'file.txt')));
		assert(listing.some(file => file.path === '/pluton/database/example.sql'));
		const binding = await s3PrimaryRecovery.testBinding('backup-01', 'plan-01');
		assert.equal(binding.snapshotId, copied.snapshotId);
		const metadata = await s3PrimaryRecovery.testMetadata('backup-01', 'plan-01', copied.snapshotId);
		assert.deepEqual(
			metadata.databases.map(entry => entry.path),
			['/pluton/database/example.sql']
		);
		const restored = await fs.mkdtemp(path.join(root, 's3-primary-restore-'));
		const result = await s3PrimaryRecovery.testRestore(
			binding,
			restored,
			s3PrimarySignal,
			() => {},
			async () => {}
		);
		assert.equal(result.sourceTrees, 1);
		assert.deepEqual(await hashTree(path.join(restored, source.slice(1))), await hashTree(source));
		const artifactTarget = await fs.mkdtemp(path.join(root, 's3-primary-sql-'));
		const entry = await s3PrimaryRecovery.databaseRestoreArtifact(
			{ ...binding, databaseId: sqlArtifact.databaseId, sha256: sqlArtifact.sha256 },
			artifactTarget,
			s3PrimarySignal,
			async () => {}
		);
		assert.equal(entry.path, sqlArtifact.path);
		assert.equal(
			await fs.readFile(path.join(artifactTarget, 'pluton/database/example.sql'), 'utf8'),
			sql
		);
	} finally {
		await s3PrimaryRecovery.close();
	}
	assert.deepEqual(await hashTree(s3root), before, 'S3 primary reads must not mutate the repository');
	console.log(
		'PASS S3 primary: browse, staged restore and SQL artifact read through the routed S3 session with SFTP stopped'
	);
	const abortedRead = new AbortController();
	const sessionRoot = await fs.mkdtemp(path.join(root, 'cancelled-session-'));
	const blocked = new Writable({
		highWaterMark: 1,
		write() {
			abortedRead.abort();
		},
	});
	const provider = new ManagedS3RecoverySession(trustEnvironment());
	await assert.rejects(
		provider.withSession(
			{
				options: { ...storageRcloneOptions(f.storage), force_path_style: 'true' },
				repositoryPath: f.replica.storagePath,
				password,
			},
			session => session.archive(copied.snapshotId, blocked),
			AbortSignal.any([signal, abortedRead.signal]),
			{ restoreTimeoutMs: 60 * 60_000, temporaryRoot: sessionRoot }
		),
		error =>
			error instanceof ManagedRepositoryAccessError &&
			error.code === 'cancelled' &&
			error.diagnostic?.operation === 'archive-readback' &&
			!error.diagnostic.timeoutCategory
	);
	assert.equal(abortedRead.signal.aborted, true);
	assert.equal(blocked.destroyed, true);
	assert.deepEqual(await fs.readdir(sessionRoot), []);
	assert.deepEqual(await hashTree(s3root), before);
	console.log(
		'PASS real native archive cancellation releases backpressure and private credentials'
	);
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
	// Automatic Failover on the same real outage: the operator's start is the only action; the
	// server selects the first verified replica and verifies staging without a second approval.
	f.plan.settings.replication.recoveryPolicy = 'automatic';
	const automaticJob = await assisted.start('owner-01', intent());
	await assisted.settled(automaticJob.id);
	const automatic = assisted.get('owner-01', automaticJob.id);
	assert.equal(automatic.status, 'completed');
	assert.equal(automatic.phase, 'integrity-verified');
	assert.equal(automatic.policy, 'automatic');
	assert.equal(automatic.primary?.code, 'network-unavailable');
	assert.equal(automatic.selected, 'replica-01');
	assert.equal(automatic.sourceSelection?.mode, 'automatic');
	assert.equal(automatic.sourceSelection?.reason, 'network-unavailable');
	assert.ok(automatic.audit.some(event => event.event === 'automatic-source-selected'));
	assert.ok(!automatic.audit.some(event => event.event === 'operator-approved'));
	const automaticStaged = path.join(root, 'assisted-stage', 'run-' + automaticJob.id, 'files');
	assert.deepEqual(
		await hashTree(path.join(automaticStaged, source.slice(1))),
		await hashTree(source)
	);
	assert.equal(
		await fs.readFile(path.join(automaticStaged, 'pluton/database/example.sql'), 'utf8'),
		sql
	);
	assert.deepEqual(await hashTree(s3root), before, 'Automatic Failover must not mutate the replica');
	await assisted.cancel('owner-01', automaticJob.id);
	assert.equal(assisted.get('owner-01', automaticJob.id).cleanupPending, false);
	await assert.rejects(fs.stat(path.join(root, 'assisted-stage', 'run-' + automaticJob.id)));
	f.plan.settings.replication.recoveryPolicy = 'assisted';
	console.log(
		'PASS real Automatic Failover: primary outage, automatic verified replica selection, staged SHA256 integrity and explicit cleanup',
		{ files: automatic.stats?.files, bytes: automatic.stats?.bytes }
	);
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
	await exerciseReplicaArchiveFaults({
		root,
		packRoot: path.join(s3root, f.replica.storagePath, 'data'),
		port: s3Port,
		caPath,
		keyPath,
		access: {
			options: { ...storageRcloneOptions(f.storage), force_path_style: 'true' },
			repositoryPath: f.replica.storagePath,
			password,
		},
		snapshotId: copied.snapshotId,
		signal,
	});
	assert.deepEqual(await hashTree(s3root), before);
	// docs/S3_PRIMARY_REPLICATION.md (stage 2): an S3 primary written directly by Restic, as the
	// Agent writes it, copied by the server to an SFTP replica and recovered from that replica.
	// Its own S3 and SFTP servers keep every earlier repository and hash assertion untouched.
	console.log('CHECK stage 2: S3 primary to SFTP replica');
	const stage2Signal = AbortSignal.timeout(150_000);
	const stage2S3Root = path.join(root, 'stage2-s3'),
		stage2SftpRoot = path.join(root, 'stage2-sftp');
	await fs.mkdir(path.join(stage2S3Root, 'bucket-01'), { recursive: true });
	await fs.mkdir(path.join(stage2SftpRoot, 'occupied'), { recursive: true });
	await fs.writeFile(path.join(stage2SftpRoot, 'occupied', 'foreign.txt'), 'not a repository\n');
	const stage2S3Port = await port(),
		stage2SftpPort = await port(),
		stage2SftpPassword = crypto.randomBytes(32).toString('hex');
	await start([
		'serve',
		's3',
		stage2S3Root,
		'--addr',
		'127.0.0.1:' + stage2S3Port,
		'--auth-key',
		'synthetic-access-key,synthetic-secret-key',
		'--cert',
		caPath,
		'--key',
		keyPath,
		'--cache-dir',
		path.join(root, 'stage2-s3-cache'),
	]);
	await ready(stage2S3Port);
	await start([
		'serve',
		'sftp',
		stage2SftpRoot,
		'--addr',
		'127.0.0.1:' + stage2SftpPort,
		'--user',
		'replica-user',
		'--pass',
		stage2SftpPassword,
		'--cache-dir',
		path.join(root, 'stage2-sftp-cache'),
	]);
	await ready(stage2SftpPort);
	const stage2Storage = {
		...f.storage,
		id: 'stage2-s3',
		settings: { ...f.storage.settings, endpoint: 'https://127.0.0.1:' + stage2S3Port },
	};
	const stage2Prefix = 'bucket-01/agents/stage2';
	const primaryEnv: NodeJS.ProcessEnv = {
		...process.env,
		RESTIC_PASSWORD: password,
		RCLONE_CONFIG: '/dev/null',
		...trustEnvironment(),
	};
	for (const [key, value] of Object.entries({
		...storageRcloneOptions(stage2Storage),
		force_path_style: 'true',
	}))
		primaryEnv['RCLONE_CONFIG_PRIMARY_' + key.toUpperCase()] = value;
	const primaryRestic = async (args: string[]) => {
		try {
			return (
				await exec(
					restic,
					['--no-cache', '-r', 'rclone:primary:' + stage2Prefix, '-o', 'rclone.program=' + rclone, ...args],
					{ env: primaryEnv, cwd: workspace, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 ** 2 }
				)
			).stdout;
		} catch {
			throw new Error('Disposable stage 2 Restic command failed.');
		}
	};
	await primaryRestic(['init']);
	await primaryRestic([
		'backup',
		source,
		'pluton/database/example.sql',
		'--tag',
		'pluton-plan-plan-01',
		'--tag',
		'pluton-backup-backup-01',
	]);
	const stage2Snapshots = JSON.parse(await primaryRestic(['snapshots', '--json']));
	assert.equal(stage2Snapshots.length, 1);
	assert.equal(stage2Snapshots[0].original, undefined, 'the stage 2 primary snapshot is an original backup');
	const stage2Remote = Object.assign(Object.create(RemoteBackupService.prototype), {
		storageStore: { getById: async (id: string) => (id === stage2Storage.id ? stage2Storage : null) },
		encryptionSecret: configService.config.SECRET,
	}) as RemoteBackupService;
	const sftpReplicaOptions = {
		host: '127.0.0.1',
		port: String(stage2SftpPort),
		user: 'replica-user',
		pass: stage2SftpPassword,
	};
	const stage2Source = {
		access: {
			options: await stage2Remote.getRepositoryAccessOptions(stage2Storage.id),
			repositoryPath: stage2Prefix,
			password,
		},
		environment: trustEnvironment(),
		planId: 'plan-01',
		backupId: 'backup-01',
		snapshotId: stage2Snapshots[0].id as string,
		artifacts: [f.backup.completionStats.lifecycle.database],
	};
	const stage2Proof = await executor.inspectSource(stage2Source, stage2Signal);
	assert.equal(stage2Proof.snapshot.id, stage2Snapshots[0].id);
	const uninitialized = { repositoryConfigId: null, initialization: 'uninitialized' as const };
	await assert.rejects(
		executor.copy({
			source: stage2Source,
			proof: stage2Proof,
			destination: { options: sftpReplicaOptions, repositoryPath: 'occupied' },
			state: uninitialized,
			beginInitialization: async () => assert.fail('an occupied SFTP folder must never be initialized'),
			bindRepository: async () => assert.fail('an occupied SFTP folder must never be bound'),
			stage2Signal,
		}),
		error => error instanceof ManagedReplicationError && error.code === 'destination-not-empty'
	);
	assert.deepEqual(await fs.readdir(path.join(stage2SftpRoot, 'occupied')), ['foreign.txt']);
	console.log('PASS stage 2 refuses an occupied SFTP folder before any write');
	let stage2Initialized = false,
		stage2Bound: string | undefined;
	const stage2Copy = await executor.copy({
		source: stage2Source,
		proof: stage2Proof,
		destination: { options: sftpReplicaOptions, repositoryPath: 'replicas/plan-01' },
		state: uninitialized,
		beginInitialization: async () => {
			stage2Initialized = true;
		},
		bindRepository: async id => {
			assert(stage2Initialized);
			stage2Bound = id;
		},
		stage2Signal,
	});
	assert(stage2Bound);
	assert.equal(stage2Copy.repositoryConfigId, stage2Bound);
	assert.notEqual(stage2Copy.snapshotId, stage2Source.snapshotId);
	const again = await executor.copy({
		source: stage2Source,
		proof: stage2Proof,
		destination: { options: sftpReplicaOptions, repositoryPath: 'replicas/plan-01' },
		state: { repositoryConfigId: stage2Bound, initialization: 'ready' },
		beginInitialization: async () => assert.fail('a ready replica is not initialized again'),
		bindRepository: async () => assert.fail('a ready replica is not bound again'),
		stage2Signal,
	});
	assert.equal(again.snapshotId, stage2Copy.snapshotId, 'a repeated copy keeps one replica snapshot');
	console.log(
		'PASS real Restic S3-to-SFTP copy: absent folder initialized, SQL artifact verified, repeat is idempotent'
	);
	const sftpReplicaStorage: any = {
		id: 'stage2-sftp',
		type: 'sftp',
		settings: {},
		credentials: Object.fromEntries(
			Object.entries(sftpReplicaOptions).map(([key, value]) => [
				key,
				new Cryptr(configService.config.SECRET!).encrypt(value),
			])
		),
	};
	const sftpReplica = {
		replicationId: 'replica-sftp',
		storageId: sftpReplicaStorage.id,
		storagePath: 'replicas/plan-01',
		storageName: 'SFTP replica',
		storageType: 'sftp',
		addedAt: 1,
	};
	const stage2Backup = {
		...s3PrimaryBackup,
		storageId: stage2Storage.id,
		storagePath: stage2Prefix,
		completionStats: { ...s3PrimaryBackup.completionStats, snapshot_id: stage2Source.snapshotId },
	};
	const stage2Plan = {
		...s3PrimaryPlan,
		storageId: stage2Storage.id,
		storagePath: stage2Prefix,
		settings: {
			replication: { enabled: true, concurrent: false, recoveryPolicy: 'assisted', storages: [sftpReplica] },
		},
	};
	const stage2Repository = { ...s3PrimaryRepository, storageId: stage2Storage.id, storagePath: stage2Prefix };
	const replicaIdentity = sftpRepositoryIdentity(sftpReplicaStorage, sftpReplica.storagePath);
	const stage2Receipt = {
		...f.receipt,
		id: 'receipt-stage2',
		repositoryId: stage2Repository.id,
		sourceStorageId: stage2Storage.id,
		sourceStoragePath: stage2Prefix,
		sourceSnapshotId: stage2Source.snapshotId,
		sourceRepositoryConfigId: stage2Proof.repositoryConfigId,
		sourceTreeId: stage2Proof.snapshot.tree,
		sourceBindingHash: replicaSourceBinding(stage2Backup as any),
		replicationId: sftpReplica.replicationId,
		destinationStorageId: sftpReplicaStorage.id,
		destinationStoragePath: sftpReplica.storagePath,
		destinationFingerprint: replicaIdentity.fingerprint,
		destinationSnapshotId: stage2Copy.snapshotId,
	};
	const stage2Destination = {
		...f.destination,
		fingerprint: replicaIdentity.fingerprint,
		replicationId: sftpReplica.replicationId,
		sourceRepositoryId: stage2Repository.id,
		destinationStorageId: sftpReplicaStorage.id,
		destinationStoragePath: sftpReplica.storagePath,
		destinationAuthority: replicaIdentity.authority,
		destinationPrefix: replicaIdentity.prefix,
		actualRepositoryId: stage2Bound,
	};
	const stage2Replicas = new VerifiedReplicaRecoveryService(
		{ listByBackup: () => [stage2Receipt], getDestination: () => stage2Destination } as any,
		{ getById: async () => stage2Backup } as any,
		{ getById: async () => stage2Plan } as any,
		{ getByPlanId: async () => stage2Repository } as any,
		f.stores.agents as any,
		{
			getById: async (id: string) =>
				id === stage2Storage.id ? stage2Storage : id === sftpReplicaStorage.id ? sftpReplicaStorage : null,
		} as any,
		path.join(root, 'stage2-indexes'),
		configService.config.SECRET!,
		undefined,
		async () => sftpReplicaOptions
	);
	const replicaBefore = await hashTree(path.join(stage2SftpRoot, 'replicas'));
	const stage2Preflight = await stage2Replicas.preflight('backup-01', 'plan-01', 'replica-sftp', stage2Signal);
	assert.equal(stage2Preflight.destinationSnapshotId, stage2Copy.snapshotId);
	const stage2Target = await fs.mkdtemp(path.join(root, 'stage2-staged-'));
	const stage2Result = await stage2Replicas.withReplica(
		'backup-01',
		'plan-01',
		'replica-sftp',
		stage2Signal,
		async recovery =>
			recovery.replicaStage(
				await recovery.testBinding('backup-01', 'plan-01'),
				{ target: '', overwrite: 'never', delete: false, includes: [], excludes: [] },
				stage2Target,
				stage2Signal,
				() => {},
				async () => {}
			),
		stage2Preflight.fingerprint
	);
	assert.equal(stage2Result.integrity, 'sha256-readback-and-restic-restore');
	assert.deepEqual(await hashTree(path.join(stage2Target, source.slice(1))), await hashTree(source));
	assert.equal(await fs.readFile(path.join(stage2Target, 'pluton/database/example.sql'), 'utf8'), sql);
	assert.deepEqual(
		await hashTree(path.join(stage2SftpRoot, 'replicas')),
		replicaBefore,
		'SFTP replica reads must not mutate it'
	);
	console.log(
		'PASS stage 2 recovery from the verified SFTP replica: full staged restore and SQL artifact with SHA256'
	);
	// docs/BACKUP_FAILOVER.md (stage 3): while the S3 primary is unreachable the Agent writes the
	// next backup straight into the verified SFTP replica. The server verifies it there, copies it
	// back to the primary, and replica recovery still proves the replica original afterwards.
	console.log('CHECK stage 3: failover backup into the SFTP replica, copy-back and replica recovery');
	const stage3Signal = AbortSignal.timeout(150_000);
	const obscuredReplicaPassword = (
		await exec(rclone, ['obscure', stage2SftpPassword], {
			env: { ...process.env, RCLONE_CONFIG: '/dev/null' },
			encoding: 'utf8',
		})
	).stdout.trim();
	// The Agent's version 5 SFTP remote: host, port and user plain, the password from the sealed field.
	const agentEnv: NodeJS.ProcessEnv = {
		...process.env,
		RESTIC_PASSWORD: password,
		RCLONE_CONFIG: '/dev/null',
		RCLONE_CONFIG_PLUTON_TYPE: 'sftp',
		RCLONE_CONFIG_PLUTON_HOST: '127.0.0.1',
		RCLONE_CONFIG_PLUTON_PORT: String(stage2SftpPort),
		RCLONE_CONFIG_PLUTON_USER: 'replica-user',
		RCLONE_CONFIG_PLUTON_PASS: obscuredReplicaPassword,
	};
	const agentRestic = async (args: string[]) => {
		try {
			return (
				await exec(
					restic,
					['--no-cache', '-r', 'rclone:pluton:replicas/plan-01', '-o', 'rclone.program=' + rclone, ...args],
					{ env: agentEnv, cwd: workspace, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 ** 2 }
				)
			).stdout;
		} catch {
			throw new Error('Disposable stage 3 Restic command failed.');
		}
	};
	await agentRestic([
		'backup',
		source,
		'pluton/database/example.sql',
		'--tag',
		'pluton-plan-plan-01',
		'--tag',
		'pluton-backup-backup-02',
	]);
	const failoverSnapshots = JSON.parse(
		await agentRestic(['snapshots', '--json', '--tag', 'pluton-backup-backup-02'])
	);
	assert.equal(failoverSnapshots.length, 1);
	assert.equal(failoverSnapshots[0].original, undefined, 'a failover snapshot is an original');
	const failoverSnapshotId = failoverSnapshots[0].id as string;
	const replicaAsSource = {
		access: { options: sftpReplicaOptions, repositoryPath: 'replicas/plan-01', password },
		planId: 'plan-01',
		backupId: 'backup-02',
		snapshotId: failoverSnapshotId,
		artifacts: [f.backup.completionStats.lifecycle.database],
	};
	const failoverProof = await executor.inspectSource(replicaAsSource, stage3Signal);
	assert.equal(failoverProof.repositoryConfigId, stage2Bound, 'written into the bound replica repository');
	assert.equal(failoverProof.snapshot.original, undefined);
	console.log('PASS failover backup written into the replica and verified there with the SQL artifact SHA-256');

	const primaryDestination = {
		options: { ...storageRcloneOptions(stage2Storage), force_path_style: 'true' },
		repositoryPath: stage2Prefix,
		environment: trustEnvironment(),
	};
	const copyBack = () =>
		executor.copy({
			source: replicaAsSource,
			proof: failoverProof,
			destination: primaryDestination,
			state: { repositoryConfigId: stage2Proof.repositoryConfigId, initialization: 'ready' },
			beginInitialization: async () => assert.fail('copy-back never initializes the primary'),
			bindRepository: async () => assert.fail('copy-back never binds the primary'),
			signal: stage3Signal,
		});
	const copiedBack = await copyBack();
	assert.equal(copiedBack.repositoryConfigId, stage2Proof.repositoryConfigId);
	const backInPrimary = (JSON.parse(await primaryRestic(['snapshots', '--json'])) as any[]).filter(
		snapshot => snapshot.original === failoverSnapshotId
	);
	assert.equal(backInPrimary.length, 1);
	assert.equal(backInPrimary[0].id, copiedBack.snapshotId);
	assert.equal((await copyBack()).snapshotId, copiedBack.snapshotId, 'a repeated copy-back is idempotent');
	await primaryRestic(['check']);
	await agentRestic(['check']);
	console.log('PASS copy-back from the SFTP replica into the S3 primary: one copy, repeat idempotent, both repositories check');

	const stage3Backup = {
		...stage2Backup,
		id: 'backup-02',
		completionStats: { ...stage2Backup.completionStats, snapshot_id: copiedBack.snapshotId },
	};
	const stage3Receipt = {
		...stage2Receipt,
		id: 'receipt-stage3',
		backupId: 'backup-02',
		sourceSnapshotId: copiedBack.snapshotId,
		sourceTreeId: failoverProof.snapshot.tree,
		sourceBindingHash: replicaSourceBinding(stage3Backup as any),
		destinationSnapshotId: failoverSnapshotId,
	};
	const stage3Replicas = (
		copiedBackFailover?: (
			backupId: string
		) => { replicaSnapshotId: string; primarySnapshotId: string } | undefined
	) =>
		new VerifiedReplicaRecoveryService(
			{ listByBackup: () => [stage3Receipt], getDestination: () => stage2Destination } as any,
			{ getById: async () => stage3Backup } as any,
			{ getById: async () => stage2Plan } as any,
			{ getByPlanId: async () => stage2Repository } as any,
			f.stores.agents as any,
			{
				getById: async (id: string) =>
					id === stage2Storage.id ? stage2Storage : id === sftpReplicaStorage.id ? sftpReplicaStorage : null,
			} as any,
			path.join(root, 'stage3-indexes'),
			configService.config.SECRET!,
			undefined,
			async () => sftpReplicaOptions,
			copiedBackFailover
		);
	// The replica original alone does not prove the primary copy; only the failover record does.
	await assert.rejects(stage3Replicas().preflight('backup-02', 'plan-01', 'replica-sftp', stage3Signal), error =>
		String((error as { code?: string }).code || (error as Error).message).includes('snapshot-identity-mismatch')
	);
	const copiedBackReplicas = stage3Replicas(id =>
		id === 'backup-02'
			? { replicaSnapshotId: failoverSnapshotId, primarySnapshotId: copiedBack.snapshotId }
			: undefined
	);
	const stage3Preflight = await copiedBackReplicas.preflight(
		'backup-02',
		'plan-01',
		'replica-sftp',
		stage3Signal
	);
	assert.equal(stage3Preflight.destinationSnapshotId, failoverSnapshotId);
	const stage3Target = await fs.mkdtemp(path.join(root, 'stage3-staged-'));
	const stage3Result = await copiedBackReplicas.withReplica(
		'backup-02',
		'plan-01',
		'replica-sftp',
		stage3Signal,
		async recovery =>
			recovery.replicaStage(
				await recovery.testBinding('backup-02', 'plan-01'),
				{ target: '', overwrite: 'never', delete: false, includes: [], excludes: [] },
				stage3Target,
				stage3Signal,
				() => {},
				async () => {}
			),
		stage3Preflight.fingerprint
	);
	assert.equal(stage3Result.integrity, 'sha256-readback-and-restic-restore');
	assert.deepEqual(await hashTree(path.join(stage3Target, source.slice(1))), await hashTree(source));
	assert.equal(await fs.readFile(path.join(stage3Target, 'pluton/database/example.sql'), 'utf8'), sql);
	console.log(
		'PASS stage 3 recovery of a copied-back failover backup from its replica original: full staged restore with SHA256'
	);
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

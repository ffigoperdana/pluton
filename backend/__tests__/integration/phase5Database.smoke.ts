/** Opt-in disposable Linux DB -> real agent -> real SFTP/Restic -> recovery.
 * No production DB/repository, no host network, credentials generated and discarded.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Writable } from 'node:stream';
import Cryptr from 'cryptr';
import { executeFilesystemBackup } from '../../../agent/dist/backupFilesystem.js';
import { RemoteBackupService } from '../../src/services/RemoteBackupService';
import { RemoteRepositoryRecoveryService } from '../../src/services/RemoteRepositoryRecoveryService';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'phase5-db-smoke-'));
const executeFile = promisify(execFile);
async function execute(binary: string, args: string[], input?: string) {
	try {
		const operation = executeFile(binary, args, {
			maxBuffer: 4 * 1024 ** 2,
			env: { ...process.env, LC_ALL: 'C' },
		});
		if (input !== undefined) operation.child.stdin?.end(input);
		return (await operation).stdout;
	} catch {
		throw new Error(`Disposable fixture operation failed (${path.basename(binary)}).`);
	}
}
async function port() {
	const server = net.createServer();
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const value = (server.address() as net.AddressInfo).port;
	await new Promise<void>(resolve => server.close(() => resolve()));
	return value;
}
async function waitPort(value: number) {
	for (let i = 0; i < 200; i++) {
		const ready = await new Promise<boolean>(resolve => {
			const socket = net.createConnection({ host: '127.0.0.1', port: value });
			socket.once('connect', () => {
				socket.destroy();
				resolve(true);
			});
			socket.once('error', () => {
				socket.destroy();
				resolve(false);
			});
		});
		if (ready) return;
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	throw new Error('Disposable fixture listener did not start.');
}
const hash = (value: Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const children: ReturnType<typeof spawn>[] = [];
try {
	assert.notEqual(process.getuid?.(), 0);
	const dbDirectory = path.join(scratch, 'mysql');
	const socket = path.join(scratch, 'mysql.sock');
	await execute('/usr/bin/mariadb-install-db', [
		'--no-defaults',
		`--datadir=${dbDirectory}`,
		'--auth-root-authentication-method=normal',
		'--skip-test-db',
		`--tmpdir=${scratch}`,
	]);
	const dbPort = await port();
	const sftpPort = await port();
	children.push(
		spawn(
			'/usr/bin/mariadbd',
			[
				'--no-defaults',
				`--datadir=${dbDirectory}`,
				`--socket=${socket}`,
				`--port=${dbPort}`,
				'--bind-address=127.0.0.1',
				`--pid-file=${path.join(scratch, 'mysql.pid')}`,
				`--log-error=${path.join(scratch, 'mysql.log')}`,
				'--skip-log-bin',
				'--skip-name-resolve',
				'--innodb-buffer-pool-size=64M',
				`--tmpdir=${scratch}`,
			],
			{ stdio: 'ignore' }
		)
	);
	await waitPort(dbPort);
	const dbPassword = crypto.randomBytes(24).toString('base64url');
	await execute(
		'/usr/bin/mariadb',
		['--no-defaults', `--socket=${socket}`, '-u', 'root'],
		`CREATE DATABASE example_db; CREATE TABLE example_db.example (id INT PRIMARY KEY, value VARCHAR(32)) ENGINE=InnoDB; INSERT INTO example_db.example VALUES (1, 'synthetic-fixture');
CREATE USER 'backup_reader'@'127.0.0.1' IDENTIFIED BY '${dbPassword}'; GRANT SELECT, SHOW VIEW, TRIGGER ON example_db.* TO 'backup_reader'@'127.0.0.1';`
	);
	const source = path.join(scratch, 'source', 'app-01');
	await fs.mkdir(source, { recursive: true, mode: 0o700 });
	await fs.writeFile(path.join(source, 'app.txt'), 'synthetic application file\n', { mode: 0o600 });
	const sourceBefore = hash(await fs.readFile(path.join(source, 'app.txt')));
	const state = path.join(scratch, 'agent');
	await fs.mkdir(state, { mode: 0o700 });
	const sftpRoot = path.join(scratch, 'sftp');
	await fs.mkdir(sftpRoot, { mode: 0o700 });
	const sftpPassword = crypto.randomBytes(24).toString('base64url');
	const repositoryPassword = crypto.randomBytes(32).toString('base64url');
	children.push(
		spawn(
			'/usr/local/bin/rclone',
			[
				'serve',
				'sftp',
				sftpRoot,
				'--addr',
				`127.0.0.1:${sftpPort}`,
				'--user',
				'fixture-user',
				'--pass',
				sftpPassword,
				'--cache-dir',
				path.join(scratch, 'rclone-cache'),
			],
			{ stdio: 'ignore' }
		)
	);
	await waitPort(sftpPort);
	const planId = 'plan-01';
	const backupId = 'backup-01';
	const database = {
		engine: 'mariadb' as const,
		host: '127.0.0.1',
		port: dbPort,
		tls: 'local' as const,
		database: 'example_db',
		username: 'backup_reader',
		password: dbPassword,
		dumpFilename: 'app.sql',
		timeoutSeconds: 60,
		maxDumpBytes: 4 * 1024 ** 2,
		includeRoutines: false,
		includeEvents: false,
	};
	const result = await executeFilesystemBackup({
		payload: {
			version: 2,
			backupId,
			planId,
			sourcePath: source,
			excludes: [],
			repository: { remoteName: 'pluton', path: 'managed/app-01', initialize: true },
			repositoryPassword,
			rclone: {
				type: 'sftp',
				options: {
					host: '127.0.0.1',
					port: String(sftpPort),
					user: 'fixture-user',
					pass: sftpPassword,
				},
			},
			lifecycle: { version: 1, database },
		},
		config: {
			dataDir: state,
			binDir: '/usr/local/bin',
			serverUrl: new URL('https://example.invalid'),
			allowInsecureHttp: false,
			allowedRoots: [source],
		},
		allowedRoots: [source],
		shouldCancel: async () => false,
		onEvent: async () => {},
	});
	assert.match(result.snapshotId, /^[a-f0-9]{64}$/);
	assert.deepEqual(result.lifecycle?.warnings, []);
	assert.deepEqual(await fs.readdir(path.join(state, 'jobs')), []);
	assert.equal(sourceBefore, hash(await fs.readFile(path.join(source, 'app.txt'))));
	const secret = crypto.randomBytes(32).toString('base64url');
	const crypt = new Cryptr(secret);
	const plan = {
		id: planId,
		sourceId: 'agent-device-01',
		sourceType: 'device',
		method: 'backup',
		storageId: 'sftp-01',
		storagePath: 'managed/app-01',
		sourceConfig: { includes: [source], excludes: [] },
		settings: { encryption: true },
		stats: { size: 0, snapshots: [result.snapshotId] },
	} as any;
	const backup = {
		id: backupId,
		planId,
		sourceId: plan.sourceId,
		sourceType: 'device',
		method: 'backup',
		storageId: plan.storageId,
		storagePath: plan.storagePath,
		status: 'completed',
		inProgress: false,
		success: true,
		completionStats: result.summary,
	} as any;
	const repository = {
		id: 'repo-01',
		planId,
		agentId: 'agent-01',
		storageId: plan.storageId,
		storagePath: plan.storagePath,
		encryptedPassword: crypt.encrypt(repositoryPassword),
		initializedAt: new Date(),
	} as any;
	const repositories = { getByPlanId: async () => repository } as any;
	const plans = { getById: async () => plan } as any;
	const backups = { getById: async () => backup } as any;
	const agents = {
		getAgentById: async () => ({
			agentId: repository.agentId,
			deviceId: plan.sourceId,
			revokedAt: null,
		}),
	} as any;
	const storage = {
		getById: async () => ({
			id: plan.storageId,
			type: 'sftp',
			settings: {},
			credentials: Object.fromEntries(
				Object.entries({
					host: '127.0.0.1',
					port: String(sftpPort),
					user: 'fixture-user',
					pass: sftpPassword,
				}).map(([key, value]) => [key, crypt.encrypt(value)])
			),
		}),
	} as any;
	const remote = new RemoteBackupService(repositories, agents, plans, backups, storage, secret);
	const rows = new Map<string, any>();
	const restores = {
		isRestoreRunning: async () => false,
		create: async (row: any) => {
			rows.set(row.id, row);
			return row;
		},
		getById: async (id: string) => rows.get(id) || null,
		update: async (id: string, patch: any) => {
			const row = { ...rows.get(id), ...patch };
			rows.set(id, row);
			return row;
		},
	} as any;
	const recovery = new RemoteRepositoryRecoveryService(
		repositories,
		backups,
		plans,
		restores,
		remote,
		agents,
		undefined,
		secret,
		path.join(scratch, 'recovery')
	);
	const browse = await recovery.browse(backupId);
	assert.ok(browse.some(node => node.path === '/pluton/database/app.sql' && node.type === 'file'));
	const download = await recovery.download(backupId);
	const archiveChunks: Buffer[] = [];
	const consumer = new Writable({
		write(chunk: Buffer, _encoding, callback) {
			archiveChunks.push(Buffer.from(chunk));
			callback();
		},
	});
	await download.streamTo(consumer, new AbortController().signal, () => {});
	const tar = path.join(scratch, 'snapshot.tar');
	await fs.writeFile(tar, Buffer.concat(archiveChunks), { mode: 0o600 });
	const extracted = path.join(scratch, 'extracted');
	await fs.mkdir(extracted, { mode: 0o700 });
	await execute('/bin/tar', ['-xf', tar, '-C', extracted]);
	const sql = await fs.readFile(path.join(extracted, 'pluton/database/app.sql'));
	assert.equal(hash(sql), result.lifecycle!.database!.sha256);
	assert.match(sql.toString(), /synthetic-fixture/);
	const restoreId = await recovery.restore(
		backupId,
		{ target: '', includes: [], excludes: [], overwrite: 'never', delete: false },
		planId
	);
	for (let i = 0; i < 600; i++) {
		if (!rows.get(restoreId)?.inProgress) break;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	const restored = rows.get(restoreId);
	assert.equal(restored.status, 'completed');
	// Service-owned restore workspace layout: restore-<id>/files.
	const restoredSql = await fs.readFile(
		path.join(restored.config.target, 'pluton/database/app.sql')
	);
	assert.equal(hash(restoredSql), hash(sql));
	assert.equal(sourceBefore, hash(await fs.readFile(path.join(source, 'app.txt'))));
	console.log(
		'PASS: disposable MariaDB -> private dump -> same real SFTP/Restic snapshot -> Browse/Download/staged Restore -> SQL hash verified; workspace removed; application unchanged.'
	);
} finally {
	for (const child of children) {
		if (child.exitCode === null) {
			child.kill('SIGTERM');
			await new Promise<void>(resolve => child.once('close', () => resolve()));
		}
	}
	await fs.rm(scratch, { recursive: true, force: true });
}

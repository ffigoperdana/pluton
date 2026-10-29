/** Fresh synthetic fixtures only. Real read-only SFTP, authenticated controller,
 * encrypted private S3, hard process restarts and curl byte-range reconstruction. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import jwt from 'jsonwebtoken';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
	S3Client,
	CreateBucketCommand,
	PutBucketVersioningCommand,
	PutObjectCommand,
	GetObjectCommand,
	ListMultipartUploadsCommand,
	ListObjectVersionsCommand,
	PutBucketPolicyCommand,
	DeleteBucketPolicyCommand,
	DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { configService } from '../../src/services/ConfigService';
import { exportConfiguration } from '../../src/utils/managedExport/ExportPolicy';
import type { LinkFixtureConfig } from './managedSymlinkRecovery.runtime';
import {
	fixture,
	hashTree,
	restic,
	rclone,
	port,
	ready,
	run,
	checkTar,
	measureProcesses,
} from './managedDownloadRecovery.helpers';

const mode = process.argv[2] || 'small',
	sizes: Record<string, number> = {
		small: 120000000,
		large: 1230000000,
		combined: 3170000000,
		four: 4000000000,
		metadata: 1024,
	};
assert(mode in sizes);
assert.equal(process.getuid?.(), 1000);
assert.equal(
	(await fs.readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim(),
	String(4 * 1024 ** 3)
);
assert.equal((await fs.readFile('/sys/fs/cgroup/memory.swap.max', 'utf8')).trim(), '0');
const [cpu, period] = (await fs.readFile('/sys/fs/cgroup/cpu.max', 'utf8'))
	.trim()
	.split(/\s+/)
	.map(Number);
assert.equal(cpu / period, 2);
const resourceStarted = performance.now();
const cpuCounters = (text: string) =>
	Object.fromEntries(
		text
			.trim()
			.split('\n')
			.map(line => {
				const [key, value] = line.trim().split(/\s+/);
				return [key, Number(value)];
			})
	);
const initialCpu = cpuCounters(await fs.readFile('/sys/fs/cgroup/cpu.stat', 'utf8'));
const root = await fs.mkdtemp('/lab/r-'),
	source = path.join(root, 'source', 'app-01'),
	repository = path.join(root, 'sftp', 'application'),
	stateFile = path.join(root, 'export-state', 'jobs.sqlite'),
	clientFile = path.join(root, 'client.tar');
const config = exportConfiguration()!;
const replicaCount = mode === 'small' ? 5 : 1;
const alternateReplicaCredential = {
	accessKeyId: crypto.randomBytes(16).toString('hex'),
	secretAccessKey: crypto.randomBytes(32).toString('hex'),
};
let replicaBefore: unknown;
async function replicaManifest() {
	const manifest: any[] = [];
	for (let index = 0; index < replicaCount; index++) {
		let keyMarker: string | undefined, versionMarker: string | undefined;
		for (let page = 0; page < 64; page++) {
			const listing = await admin.send(
				new ListObjectVersionsCommand({
					Bucket: config.bucket,
					Prefix: `repositories/plan-${index}/`,
					KeyMarker: keyMarker,
					VersionIdMarker: versionMarker,
				})
			);
			assert.equal(listing.DeleteMarkers?.length || 0, 0);
			for (const object of listing.Versions || []) {
				const response = await admin.send(
					new GetObjectCommand({
						Bucket: config.bucket,
						Key: object.Key,
						VersionId: object.VersionId,
					})
				);
				const hash = crypto.createHash('sha256');
				let bytes = 0;
				for await (const chunk of response.Body as any) {
					hash.update(chunk);
					bytes += chunk.length;
				}
				manifest.push({
					key: object.Key,
					version: object.VersionId,
					bytes,
					sha256: hash.digest('hex'),
				});
			}
			if (!listing.IsTruncated) break;
			assert(page < 63 && listing.NextKeyMarker);
			keyMarker = listing.NextKeyMarker;
			versionMarker = listing.NextVersionIdMarker;
		}
	}
	return manifest.sort((a, b) => `${a.key}/${a.version}`.localeCompare(`${b.key}/${b.version}`));
}
assert.equal(new URL(config.endpoint).hostname, 'minio');
assert.equal(config.bucket, 'example-private-exports');
const admin = new S3Client({
	endpoint: config.endpoint,
	region: config.region,
	forcePathStyle: true,
	maxAttempts: 1,
	credentials: {
		accessKeyId: process.env.FIXTURE_ADMIN_ACCESS!,
		secretAccessKey: process.env.FIXTURE_ADMIN_SECRET!,
	},
	requestHandler: new NodeHttpHandler({
		httpsAgent: new https.Agent({ ca: config.ca, rejectUnauthorized: true }),
	}),
});
const restricted = new S3Client({
	endpoint: config.endpoint,
	region: config.region,
	forcePathStyle: true,
	maxAttempts: 1,
	credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
	requestHandler: new NodeHttpHandler({
		httpsAgent: new https.Agent({ ca: config.ca, rejectUnauthorized: true }),
	}),
});
const monitor = measureProcesses(),
	snapshots: Record<string, string> = {},
	password = crypto.randomBytes(32).toString('hex'),
	sftpPassword = crypto.randomBytes(32).toString('hex');
let child: ChildProcess | undefined,
	sftp: ChildProcess | undefined,
	base = '',
	phase = 'storage',
	fault = '',
	held = false,
	appConfig: LinkFixtureConfig;
const inbox: any[] = [],
	results: Record<string, any> = {
		fixture: mode,
		sourceBytes: sizes[mode],
		serverTemporaryTarBytes: 0,
		applicationPartBytes: 16 * 1024 ** 2,
		exportConcurrency: 1,
		orphanParts: 0,
		orphanObjects: 0,
	};
const headers = {
	'Cookie': `token=${jwt.sign({ user: 'fixture-admin' }, configService.config.SECRET!, { expiresIn: '6h' })}`,
	'Content-Type': 'application/json',
};
function stage(value: string) {
	phase = value;
	console.log(JSON.stringify({ event: 'managed_resumable_progress', fixture: mode, phase }));
}
async function until(check: () => boolean | Promise<boolean>, ms = 30 * 60_000) {
	const end = Date.now() + ms;
	while (!(await check())) {
		assert(Date.now() < end, 'Fixture state deadline exceeded.');
		await new Promise(r => setTimeout(r, 25));
	}
}
async function event(name: string) {
	let value: any;
	await until(() => {
		const index = inbox.findIndex(x => x.event === name || x.event === 'fixture-error');
		if (index < 0) return false;
		value = inbox.splice(index, 1)[0];
		assert(value.event !== 'fixture-error', 'Child fixture operation failed.');
		return true;
	}, 60_000);
	return value;
}
async function start(failure = '') {
	fault = failure;
	held = false;
	inbox.length = 0;
	const environment = { ...process.env };
	for (const key of ['FIXTURE_ADMIN_ACCESS', 'FIXTURE_ADMIN_SECRET', 'MC_HOST_fixture'])
		delete environment[key];
	child = fork(
		fileURLToPath(new URL('./managedResumableRecovery.process.ts', import.meta.url)),
		[],
		{ env: environment, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
	);
	child.on('message', (message: any) => {
		if (message.event === 'held') held = true;
		else inbox.push(message);
	});
	child.send({
		action: 'start',
		config: appConfig,
		file: stateFile,
		fault: failure,
		replicaCount,
		alternateReplicaCredential,
	});
	base = (await event('started')).base;
}
async function stop(hard = false) {
	if (!child) return;
	const current = child;
	const closed = new Promise<void>(resolve => current.once('exit', () => resolve()));
	if (hard) current.kill('SIGKILL');
	else {
		current.send({ action: 'stop' });
		await event('stopped');
	}
	await closed;
	child = undefined;
}
async function stats() {
	child!.send({ action: 'stats' });
	return event('stats');
}
async function json(response: Response) {
	assert.match(response.headers.get('Content-Type') || '', /application\/json/);
	return response.json() as Promise<any>;
}
async function admit(backup = 'backup-01', exportMode: 'full' | 'regular-files' = 'full') {
	const at = performance.now(),
		response = await fetch(`${base}/${backup}/exports`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ mode: exportMode }),
		});
	assert.equal(response.status, 202);
	results.maxAdmissionMs = Math.max(
		results.maxAdmissionMs || 0,
		Math.round(performance.now() - at)
	);
	assert(results.maxAdmissionMs < 4000);
	return (await json(response)).result.id as string;
}
async function status(id: string, backup = 'backup-01') {
	const response = await fetch(`${base}/${backup}/exports/${id}`, { headers });
	assert.equal(response.status, 200);
	return (await json(response)).result;
}
async function terminal(id: string, expected = 'ready', backup = 'backup-01') {
	let job: any;
	await until(async () => {
		job = await status(id, backup);
		return ['ready', 'failed', 'cancelled', 'expired'].includes(job.state);
	});
	if (job.state !== expected) {
		console.log(JSON.stringify({ event: 'fixture_safe_diagnostics', ...(await stats()) }));
		console.log(
			JSON.stringify({
				event: 'managed_resumable_refusal',
				fixture: mode,
				phase,
				state: job.state,
				reason: /^[a-z-]{1,80}$/.test(job.failure || '') ? job.failure : 'unclassified',
			})
		);
	}
	assert.equal(job.state, expected);
	return job;
}
async function grant(id: string) {
	const response = await fetch(`${base}/backup-01/exports/${id}/authorization`, {
		method: 'POST',
		headers,
		body: '{}',
	});
	assert.equal(response.status, 200);
	return (await json(response)).result;
}
async function cancel(id: string, backup = 'backup-01') {
	const response = await fetch(`${base}/${backup}/exports/${id}`, { method: 'DELETE', headers });
	assert.equal(response.status, 200);
	await until(async () => !(await status(id, backup)).cleanupPending);
}
async function clean() {
	const parts = await admin.send(
			new ListMultipartUploadsCommand({ Bucket: config.bucket, Prefix: config.prefix })
		),
		objects = await admin.send(
			new ListObjectVersionsCommand({ Bucket: config.bucket, Prefix: config.prefix })
		);
	assert.equal(parts.Uploads?.length || 0, 0);
	assert.equal(objects.Versions?.length || 0, 0);
	assert.equal(objects.DeleteMarkers?.length || 0, 0);
}
async function sha(file: string) {
	const hash = crypto.createHash('sha256');
	for await (const chunk of createReadStream(file)) hash.update(chunk);
	return hash.digest('hex');
}
async function serverMetadataBytes() {
	let bytes = 0;
	async function walk(directory: string) {
		for await (const item of await fs
			.opendir(directory)
			.catch(() => ({ async *[Symbol.asyncIterator]() {} }) as any)) {
			const name = path.join(directory, item.name),
				stat = await fs.lstat(name).catch(() => undefined);
			if (!stat) continue;
			assert(!stat.isSymbolicLink(), 'Unexpected server metadata link.');
			if (stat.isDirectory()) await walk(name);
			else {
				assert(
					!name.endsWith('.tar') && stat.size <= 256 * 1024 ** 2,
					'Unexpected server archive staging.'
				);
				bytes += stat.size;
			}
		}
	}
	for (const name of [
		path.dirname(stateFile),
		path.join(root, 'managed-snapshot-indexes'),
		appConfig.staging,
	])
		await walk(name);
	return bytes;
}
async function request(url: string, extra: Record<string, string> = {}) {
	return new Promise<http.IncomingMessage>((resolve, reject) => {
		const parsed = new URL(url),
			get = parsed.protocol === 'https:' ? https.get : http.get;
		const req = get(parsed, { headers: extra, ca: config.ca, rejectUnauthorized: true }, resolve);
		req.on('error', () => reject(new Error('Disposable HTTP request failed.')));
	});
}
async function partial(
	url: string,
	file: string,
	target: number,
	total: number,
	etag: string,
	extra: Record<string, string> = {},
	rate = 0
) {
	const offset = (await fs.stat(file).catch(() => ({ size: 0 }))).size;
	const response = await request(url, {
		...extra,
		...(offset ? { 'Range': `bytes=${offset}-`, 'If-Range': etag } : {}),
	});
	assert.equal(response.statusCode, offset ? 206 : 200);
	assert.equal(response.headers.etag, etag);
	if (offset)
		assert.equal(response.headers['content-range'], `bytes ${offset}-${total - 1}/${total}`);
	const handle = await fs.open(file, offset ? 'a' : 'wx', 0o600);
	let bytes = offset;
	const started = performance.now();
	try {
		for await (const raw of response) {
			const chunk = raw as Buffer,
				n = Math.min(chunk.length, target - bytes);
			if (n > 0) {
				await handle.write(chunk.subarray(0, n));
				bytes += n;
			}
			if (bytes >= target) {
				response.destroy();
				break;
			}
			if (rate) {
				const due = ((bytes - offset) / rate) * 1000 - (performance.now() - started);
				if (due > 0) await new Promise(r => setTimeout(r, due));
			}
		}
	} finally {
		response.destroy();
		await handle.close();
	}
	assert.equal(bytes, target);
	return { offset, bytes, elapsedMs: Math.round(performance.now() - started) };
}
async function curlResume(url: string, file: string, total: number, extra: string[] = []) {
	const offset = (await fs.stat(file)).size,
		headerFile = file + '.headers',
		at = performance.now();
	const output = await run('/usr/bin/curl', [
		'--silent',
		'--show-error',
		'--fail',
		'--cacert',
		process.env.MANAGED_EXPORT_CA_FILE!,
		'--continue-at',
		'-',
		'--header',
		`If-Range: ${extra.length ? '"sha256-' + results.archiveSha256 + '"' : results.objectEtag}`,
		'--output',
		file,
		'--dump-header',
		headerFile,
		'--write-out',
		'%{http_code}',
		...extra,
		'--url',
		url,
	]);
	assert.equal(output.toString(), '206');
	const text = await fs.readFile(headerFile, 'utf8');
	assert(text.length < 16384);
	assert.match(text, new RegExp(`content-range: bytes ${offset}-${total - 1}/${total}`, 'i'));
	assert.equal((await fs.stat(file)).size, total);
	await fs.unlink(headerFile);
	return { offset, elapsedMs: Math.round(performance.now() - at) };
}
function equalInventory(a: unknown, b: unknown) {
	try {
		assert.deepEqual(a, b);
	} catch {
		throw new Error('Disposable historical inventory comparison failed.');
	}
}
async function extract(expected: Awaited<ReturnType<typeof hashTree>>) {
	const tar = await checkTar(createReadStream(clientFile), true);
	results.tarEntries = tar.files + tar.directories + tar.links;
	const target = path.join(root, 'client-extracted');
	await fs.mkdir(target, { mode: 0o700 });
	await run('/bin/tar', [
		'--extract',
		'--file',
		clientFile,
		'--directory',
		target,
		'--no-same-owner',
		'--no-same-permissions',
		'--keep-old-files',
	]);
	equalInventory(await hashTree(path.join(target, source.slice(1))), expected);
	await fs.rm(target, { recursive: true, force: true });
}
try {
	assert(
		(await fs.statfs(root)).bavail * (await fs.statfs(root)).bsize >= 32 * 1024 ** 3,
		'Disposable lab requires 32 GiB free.'
	);
	await until(async () => {
		try {
			await admin.send(new CreateBucketCommand({ Bucket: config.bucket }));
			return true;
		} catch (error) {
			return (error as any)?.name === 'BucketAlreadyOwnedByYou';
		}
	}, 30_000);
	await admin.send(
		new PutBucketVersioningCommand({
			Bucket: config.bucket,
			VersioningConfiguration: { Status: 'Enabled' },
		})
	);
	process.env.SSL_CERT_FILE = process.env.MANAGED_EXPORT_CA_FILE;
	const mcUrl = new URL(config.endpoint);
	mcUrl.username = process.env.FIXTURE_ADMIN_ACCESS!;
	mcUrl.password = process.env.FIXTURE_ADMIN_SECRET!;
	process.env.MC_HOST_fixture = mcUrl.href;
	process.env.MC_CONFIG_DIR = path.join(root, 'mc');
	const sharedPrefixes = config.allowSharedNamespace ? ['repositories/*'] : [];
	const policy = {
		Version: '2012-10-17',
		Statement: [
			{
				Effect: 'Allow',
				Action: [
					's3:GetBucketVersioning',
					's3:GetBucketLocation',
					's3:ListBucketMultipartUploads',
					's3:GetBucketPolicy',
				],
				Resource: [`arn:aws:s3:::${config.bucket}`],
			},
			{
				Effect: 'Allow',
				Action: ['s3:ListBucket', 's3:ListBucketVersions'],
				Resource: [`arn:aws:s3:::${config.bucket}`],
				Condition: { StringLike: { 's3:prefix': [`${config.prefix}/*`, ...sharedPrefixes] } },
			},
			{
				Effect: 'Allow',
				Action: [
					's3:GetObject',
					's3:GetObjectVersion',
					's3:PutObject',
					's3:DeleteObject',
					's3:DeleteObjectVersion',
					's3:AbortMultipartUpload',
					's3:ListMultipartUploadParts',
				],
				Resource: [
					`arn:aws:s3:::${config.bucket}/${config.prefix}/*`,
					...sharedPrefixes.map(prefix => `arn:aws:s3:::${config.bucket}/${prefix}`),
				],
			},
		],
	};
	const policyFile = path.join(root, 'export-policy.json');
	await fs.writeFile(policyFile, JSON.stringify(policy), { mode: 0o600 });
	stage('scoped-user');
	await run('/usr/local/bin/mc', [
		'admin',
		'user',
		'add',
		'fixture',
		config.accessKeyId,
		config.secretAccessKey,
	]);
	stage('scoped-policy');
	try {
		await promisify(execFile)(
			'/usr/local/bin/mc',
			['--json', 'admin', 'policy', 'create', 'fixture', 'synthetic-export-only', policyFile],
			{ maxBuffer: 65536 }
		);
	} catch (e) {
		const output = String((e as any).stdout) + String((e as any).stderr);
		console.log(
			JSON.stringify({
				event: 'fixture_policy_refusal',
				tags: [
					'invalid',
					'Invalid',
					'condition',
					'Condition',
					'MalformedPolicy',
					'AccessDenied',
					...policy.Statement.flatMap(s => s.Action),
				].filter(s => output.includes(s)),
			})
		);
		throw new Error('Synthetic policy was refused.');
	}
	stage('scoped-policy-attachment');
	await run('/usr/local/bin/mc', [
		'admin',
		'policy',
		'attach',
		'fixture',
		'synthetic-export-only',
		'--user',
		config.accessKeyId,
	]);
	for (const command of [
		new PutBucketPolicyCommand({
			Bucket: config.bucket,
			Policy: JSON.stringify({ Version: '2012-10-17', Statement: [] }),
		}),
		new PutObjectCommand({
			Bucket: config.bucket,
			Key: 'outside-export-prefix/denied',
			Body: Buffer.from('synthetic'),
		}),
	]) {
		let denied = false;
		try {
			await restricted.send(command);
		} catch (error) {
			denied = (error as any)?.$metadata?.httpStatusCode === 403;
		}
		assert(denied, 'Scoped fixture credentials must deny unrelated access.');
	}
	results.leastPrivilege = 'PASS';
	if (config.allowSharedNamespace && mode === 'small') {
		await run('/usr/local/bin/mc', [
			'admin',
			'user',
			'add',
			'fixture',
			alternateReplicaCredential.accessKeyId,
			alternateReplicaCredential.secretAccessKey,
		]);
		await run('/usr/local/bin/mc', [
			'admin',
			'policy',
			'attach',
			'fixture',
			'synthetic-export-only',
			'--user',
			alternateReplicaCredential.accessKeyId,
		]);
	}
	const sentinel = crypto.randomBytes(32);
	await admin.send(
		new PutObjectCommand({ Bucket: config.bucket, Key: 'ownership-sentinel', Body: sentinel })
	);
	stage('historical-fixture');
	await fs.mkdir(repository, { recursive: true });
	await fixture(
		source,
		mode === 'metadata' ? 'metadata' : mode === 'combined' ? 'combined' : 'small',
		sizes[mode]
	);
	if (mode === 'small') await fs.symlink('nested/selected.txt', path.join(source, 'internal-link'));
	const historical = await hashTree(source);
	results.sourceEntries = Object.keys(historical.entries).length;
	const command = async (args: string[]) =>
		(await run(restic, ['--no-cache', '-r', repository, ...args], password)).toString();
	await command(['init']);
	for (const id of ['backup-01', 'backup-02']) {
		const result = await command([
			'--json',
			'backup',
			source,
			'--tag',
			'pluton-plan-plan-01',
			'--tag',
			`pluton-backup-${id}`,
		]);
		snapshots[id] = JSON.parse(result.trim().split('\n').at(-1)!).snapshot_id;
		if (id === 'backup-01')
			await fs.writeFile(path.join(source, 'nested', 'selected.txt'), 'newer live contents\n', {
				mode: 0o600,
			});
	}
	const before = await hashTree(repository),
		current = await hashTree(source),
		sftpPort = await port();
	if (config.allowSharedNamespace) {
		stage('shared-repository-replicas');
		Object.assign(process.env, {
			RCLONE_CONFIG_SHARED_TYPE: 's3',
			RCLONE_CONFIG_SHARED_PROVIDER: 'Other',
			RCLONE_CONFIG_SHARED_ENDPOINT: config.endpoint,
			RCLONE_CONFIG_SHARED_REGION: config.region,
			RCLONE_CONFIG_SHARED_ACCESS_KEY_ID: config.accessKeyId,
			RCLONE_CONFIG_SHARED_SECRET_ACCESS_KEY: config.secretAccessKey,
			RCLONE_CONFIG_SHARED_NO_CHECK_BUCKET: 'true',
			RCLONE_CONFIG_SHARED_FORCE_PATH_STYLE: 'true',
			RCLONE_CONFIG_SHARED_SERVER_SIDE_ENCRYPTION: 'AES256',
			AWS_ACCESS_KEY_ID: config.accessKeyId,
			AWS_SECRET_ACCESS_KEY: config.secretAccessKey,
		});
		for (let index = 0; index < replicaCount; index++) {
			if (index === 4) {
				process.env.RCLONE_CONFIG_SHARED_ACCESS_KEY_ID = alternateReplicaCredential.accessKeyId;
				process.env.RCLONE_CONFIG_SHARED_SECRET_ACCESS_KEY =
					alternateReplicaCredential.secretAccessKey;
				process.env.AWS_ACCESS_KEY_ID = alternateReplicaCredential.accessKeyId;
				process.env.AWS_SECRET_ACCESS_KEY = alternateReplicaCredential.secretAccessKey;
			}
			await run(rclone, [
				'copy',
				repository,
				`shared:${config.bucket}/repositories/plan-${index}`,
				'--ca-cert',
				process.env.MANAGED_EXPORT_CA_FILE!,
				'--transfers',
				'1',
				'--checkers',
				'1',
				'--s3-upload-concurrency',
				'1',
			]);
			const listing = await run(
				restic,
				[
					'--no-cache',
					'--no-lock',
					'--cacert',
					process.env.MANAGED_EXPORT_CA_FILE!,
					'-r',
					`s3:${config.endpoint}/${config.bucket}/repositories/plan-${index}`,
					'snapshots',
					'--json',
				],
				password
			);
			assert.deepEqual(
				JSON.parse(listing.toString())
					.map((row: any) => row.id)
					.sort(),
				Object.values(snapshots).sort()
			);
		}
		replicaBefore = await replicaManifest();
		results.sharedNamespaceReplicas = replicaCount;
		results.sharedCredentials = 'PASS';
		if (mode === 'small') results.differentReplicaCredentials = 'PASS';
	}
	sftp = spawn(
		rclone,
		[
			'serve',
			'sftp',
			path.dirname(repository),
			'--addr',
			`127.0.0.1:${sftpPort}`,
			'--user',
			'fixture-user',
			'--pass',
			sftpPassword,
			'--read-only',
			'--cache-dir',
			path.join(root, 'rclone-cache'),
		],
		{ stdio: 'ignore' }
	);
	await ready(sftpPort);
	appConfig = {
		snapshots,
		source,
		secret: crypto.randomBytes(32).toString('hex'),
		password,
		sftpPassword,
		port: sftpPort,
		staging: path.join(root, 'staging'),
	};
	await start();
	if (mode === 'small') {
		stage('operator-only-preflight');
		const operatorBase = base.replace('/api/backups', '/api/managed-exports');
		const configuration = await json(await fetch(operatorBase + '/configuration', { headers }));
		assert.equal(configuration.result.configured, true);
		assert.equal(configuration.result.destinationFingerprint, config.fingerprint);
		assert.equal(configuration.result.credentialsConfigured, true);
		assert.equal(configuration.result.privateCaConfigured, true);
		assert.equal(configuration.result.sharedNamespaceEnabled, !!config.allowSharedNamespace);
		if (config.allowSharedNamespace) {
			stage('readonly-reserved-prefix-inventory');
			const response = await fetch(operatorBase + '/inventory-checks', {
				method: 'POST',
				headers,
				body: '{}',
			});
			assert.equal(response.status, 202);
			const id = (await json(response)).result.id;
			let inventory: any;
			await until(async () => {
				inventory = (await json(await fetch(operatorBase + '/inventory-checks/' + id, { headers })))
					.result;
				return ['ready', 'failed'].includes(inventory.state);
			});
			assert.equal(inventory.state, 'ready');
			assert.deepEqual(inventory.inventory, { objects: 0, uploads: 0, exclusive: true });
			assert.equal((await stats()).archiveReads, 0);
			await clean();
			results.readOnlyInventory = 'PASS';
		}
		const response = await fetch(operatorBase + '/preflights', {
			method: 'POST',
			headers,
			body: '{}',
		});
		assert.equal(response.status, 202);
		const preflightId = (await json(response)).result.id;
		let preflight: any;
		await until(async () => {
			preflight = (
				await json(await fetch(operatorBase + '/preflights/' + preflightId, { headers }))
			).result;
			return ['ready', 'failed'].includes(preflight.state);
		});
		if (preflight.state !== 'ready')
			console.log(
				JSON.stringify({
					event: 'operator_preflight_refused',
					capability: preflight.failureCapability,
					category: preflight.failureCategory,
					status: preflight.failureHttpStatus,
				})
			);
		assert.equal(preflight.state, 'ready');
		assert.equal(preflight.cleanupPending, false);
		assert.deepEqual(
			preflight.preflightChecks.sort(),
			[
				'destination-isolation',
				'https',
				'versioning',
				'sse-s3',
				'private-acl',
				'anonymous-denial',
				'immutable-version',
				'range-resume',
				'version-enumeration',
				'presigned-get',
				'multipart-upload',
				'multipart-enumeration',
				'conditional-completion',
				'multipart-completion',
				'cleanup',
			].sort()
		);
		assert.equal((await stats()).archiveReads, 0);
		await clean();
		results.operatorPreflightWithoutBackupRead = 'PASS';
		results.actualProcessConfiguration = 'PASS';
		if (config.allowSharedNamespace) {
			stage('foreign-reserved-prefix-object-refused-and-preserved');
			const key = `${config.prefix}/${preflightId}.tar`,
				bytes = crypto.randomBytes(32);
			const foreign = await admin.send(
				new PutObjectCommand({
					Bucket: config.bucket,
					Key: key,
					Body: bytes,
					ServerSideEncryption: 'AES256',
					Metadata: { 'pluton-export-job': preflightId, 'pluton-export-binding': 'f'.repeat(64) },
				})
			);
			const response = await fetch(operatorBase + '/inventory-checks', {
				method: 'POST',
				headers,
				body: '{}',
			});
			const id = (await json(response)).result.id;
			let inventory: any;
			await until(async () => {
				inventory = (await json(await fetch(operatorBase + '/inventory-checks/' + id, { headers })))
					.result;
				return ['ready', 'failed'].includes(inventory.state);
			});
			assert.equal(inventory.state, 'failed');
			assert.equal(inventory.failureCapability, 'destination-isolation');
			const preserved = await admin.send(
				new GetObjectCommand({ Bucket: config.bucket, Key: key, VersionId: foreign.VersionId })
			);
			assert(Buffer.from(await preserved.Body!.transformToByteArray()).equals(bytes));
			await admin.send(
				new DeleteObjectCommand({ Bucket: config.bucket, Key: key, VersionId: foreign.VersionId })
			);
			assert.equal((await stats()).archiveReads, 0);
			await clean();
			results.foreignPrefixObjectPreserved = 'PASS';
		}
	}
	assert.equal(
		(
			await fetch(`${base}/backup-01/exports`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: '{}',
			})
		).status,
		401
	);
	stage('export-and-verify');
	if (mode === 'small') {
		stage('unsupported-versioning');
		await admin.send(
			new PutBucketVersioningCommand({
				Bucket: config.bucket,
				VersioningConfiguration: { Status: 'Suspended' },
			})
		);
		const refused = await admit();
		assert.equal((await terminal(refused, 'failed')).failure, 'security-capability-missing');
		await until(async () => !(await status(refused)).cleanupPending);
		await clean();
		await admin.send(
			new PutBucketVersioningCommand({
				Bucket: config.bucket,
				VersioningConfiguration: { Status: 'Enabled' },
			})
		);
		stage('public-destination-refused');
		await admin.send(
			new PutBucketPolicyCommand({
				Bucket: config.bucket,
				Policy: JSON.stringify({
					Version: '2012-10-17',
					Statement: [
						{
							Effect: 'Allow',
							Principal: '*',
							Action: ['s3:GetObject', 's3:GetObjectVersion'],
							Resource: [`arn:aws:s3:::${config.bucket}/${config.prefix}/*`],
						},
					],
				}),
			})
		);
		const publicJob = await admit();
		assert.equal((await terminal(publicJob, 'failed')).failure, 'security-capability-missing');
		await until(async () => !(await status(publicJob)).cleanupPending);
		await admin.send(new DeleteBucketPolicyCommand({ Bucket: config.bucket }));
		await clean();
		stage('anonymous-bucket-listing-refused');
		await admin.send(
			new PutBucketPolicyCommand({
				Bucket: config.bucket,
				Policy: JSON.stringify({
					Version: '2012-10-17',
					Statement: [
						{
							Effect: 'Allow',
							Principal: '*',
							Action: ['s3:ListBucket'],
							Resource: [`arn:aws:s3:::${config.bucket}`],
						},
					],
				}),
			})
		);
		const publicListing = await admit();
		assert.equal((await terminal(publicListing, 'failed')).failureCapability, 'anonymous-denial');
		await until(async () => !(await status(publicListing)).cleanupPending);
		await admin.send(new DeleteBucketPolicyCommand({ Bucket: config.bucket }));
		await clean();
		assert.equal((await stats()).archiveReads, 0);
		results.unsupportedStorageAndPrivacy = 'PASS';
		stage('export-and-verify');
	}
	const started = performance.now(),
		id = await admit();
	assert.equal(await admit(), id);
	if (mode === 'small') {
		await until(() => inbox.some(m => m.event === 'source-archive'));
		sftp!.kill('SIGSTOP');
		const paused = performance.now();
		await new Promise(r => setTimeout(r, 750));
		sftp!.kill('SIGCONT');
		results.sftpPauseMs = Math.round(performance.now() - paused);
	}
	const job = await terminal(id);
	results.exportMs = Math.round(performance.now() - started);
	results.archiveBytes = job.totalBytes;
	results.archiveSha256 = job.summary.archiveSha256;
	assert.equal(job.summary.binding.snapshotId, snapshots['backup-01']);
	assert.equal(job.integrity, 'verified');
	const initialStats = await stats();
	results.indexAllocation = initialStats.sourceIndex;
	results.archiveReads = initialStats.archiveReads;
	results.pipelineTimingsMs = initialStats.timings;
	results.storageReadConnectionRetries = initialStats.storageDiagnostics.reduce(
		(n: number, s: any) => n + s.readConnectionRetries,
		0
	);
	results.serverMetadataDiskBytes = await serverMetadataBytes();
	assert(initialStats.archiveReads <= 2);
	const authorized = await grant(id);
	results.objectEtag = authorized.etag;
	stage('interrupted-real-client');
	const offsets: number[] = [];
	let at = performance.now();
	for (const fraction of mode === 'small' ? [0.1, 0.5, 0.9] : [0.1]) {
		const transfer = await partial(
			(await grant(id)).url,
			clientFile,
			Math.floor(job.totalBytes * fraction),
			job.totalBytes,
			authorized.etag
		);
		offsets.push(transfer.bytes);
	}
	if (mode === 'small') {
		stage('ready-object-hard-restart');
		await stop(true);
		await start();
		const durable = await status(id);
		assert.equal(durable.state, 'ready');
		assert.equal(durable.summary.archiveSha256, results.archiveSha256);
		assert.equal((await stats()).archiveReads, 0);
	}
	const resumed = await curlResume((await grant(id)).url, clientFile, job.totalBytes);
	results.clientResumeMs = resumed.elapsedMs;
	results.clientResumeOffset = resumed.offset;
	results.interruptionOffsets = offsets;
	results.clientTransferMs = Math.round(performance.now() - at);
	assert.equal(await sha(clientFile), results.archiveSha256);
	await extract(historical);
	results.integrity = 'PASS';
	results.historicalSnapshot = 'PASS';
	stage('standard-stream-comparison');
	at = performance.now();
	const prepResponse = await fetch(`${base}/backup-01/action/download`, {
		method: 'POST',
		headers,
	});
	assert.equal(prepResponse.status, 202);
	const prepId = (await json(prepResponse)).result.preparation.id;
	let prep: any;
	await until(async () => {
		prep = (
			await json(await fetch(`${base}/backup-01/download-preparations/${prepId}`, { headers }))
		).result;
		assert(!['failed', 'expired', 'cancelled'].includes(prep.state));
		return prep.state === 'ready';
	});
	const stream = await fetch(`${base}/backup-01/action/download?preparationId=${prepId}`, {
		headers,
	});
	assert.equal(stream.status, 200);
	assert.equal(stream.headers.get('Accept-Ranges'), 'none');
	const hash = crypto.createHash('sha256');
	let standardBytes = 0;
	for await (const chunk of stream.body as any) {
		hash.update(chunk);
		standardBytes += chunk.length;
	}
	assert.equal(standardBytes, job.totalBytes);
	assert.equal(hash.digest('hex'), results.archiveSha256);
	results.standardPrepareAndTransferMs = Math.round(performance.now() - at);
	if (mode === 'small') {
		stage('proxy-interruption-and-slow-client');
		const proxyFile = path.join(root, 'proxy-client.tar');
		const slow = await partial(
			`${base}/backup-01/exports/${id}/content`,
			proxyFile,
			2 * 1024 ** 2,
			job.totalBytes,
			`"sha256-${results.archiveSha256}"`,
			{ Cookie: headers.Cookie },
			500 * 1024
		);
		results.slowClientWindow = slow;
		assert(slow.elapsedMs >= 3500);
		const proxyResume = await curlResume(
			`${base}/backup-01/exports/${id}/content`,
			proxyFile,
			job.totalBytes,
			['--header', `Cookie: ${headers.Cookie}`]
		);
		assert.equal(await sha(proxyFile), results.archiveSha256);
		results.proxyResumeMs = proxyResume.elapsedMs;
		await fs.unlink(proxyFile);
		child!.send({ action: 'short-authorization', id });
		const short = (await event('short-authorization')).url;
		await new Promise(r => setTimeout(r, 2100));
		const expired = await request(short, { Range: 'bytes=0-0' });
		assert.equal(expired.statusCode, 403);
		expired.resume();
		const renewed = await request((await grant(id)).url, { Range: 'bytes=0-0' });
		assert.equal(renewed.statusCode, 206);
		renewed.resume();
		results.expiredAuthorizationAndRenewal = 'PASS';
	}
	stage('expiry');
	child!.send({ action: 'expire', id });
	await event('expired');
	await until(async () => !(await status(id)).cleanupPending);
	assert.equal((await status(id)).state, 'expired');
	await clean();
	if (mode === 'small') {
		stage('regular-files-only-artifact');
		const partialId = await admit('backup-01', 'regular-files'),
			partialJob = await terminal(partialId);
		assert.equal(partialJob.summary.mode, 'regular-files');
		assert.equal(partialJob.summary.excludedByType.symlink, 1);
		const partialGrant = await grant(partialId);
		await fs.unlink(clientFile);
		await partial(
			partialGrant.url,
			clientFile,
			partialJob.totalBytes,
			partialJob.totalBytes,
			partialGrant.etag
		);
		assert.equal(await sha(clientFile), partialJob.summary.archiveSha256);
		const expected = { ...historical, entries: { ...historical.entries } };
		delete expected.entries['internal-link'];
		const fullEntries = results.tarEntries;
		await extract(expected);
		results.tarEntries = fullEntries;
		await cancel(partialId);
		await clean();
		results.regularFilesOnly = 'PASS';
		for (const scenario of ['hold-upload', 'hold-verify']) {
			stage(`hard-restart-${scenario}`);
			await stop();
			await start(scenario);
			const interrupted = await admit();
			await until(() => held);
			assert.notEqual((await status(interrupted)).state, 'ready');
			await stop(true);
			await start();
			const failed = await terminal(interrupted, 'failed');
			assert.equal(failed.failure, 'interrupted');
			await until(async () => !(await status(interrupted)).cleanupPending);
			await clean();
		}
		stage('multipart-error-and-safe-retry');
		await stop();
		await start('upload-error');
		const failed = await admit();
		await terminal(failed, 'failed');
		await until(async () => !(await status(failed)).cleanupPending);
		await clean();
		await stop();
		await start('hold-upload');
		const active = await admit();
		await until(() => held);
		const queued = await admit('backup-02');
		assert.equal((await status(queued, 'backup-02')).state, 'queued');
		await cancel(queued, 'backup-02');
		await cancel(active);
		await clean();
		results.cancelQueueAndRestartCleanup = 'PASS';
	}
	const sentinelRead = await admin.send(
		new GetObjectCommand({ Bucket: config.bucket, Key: 'ownership-sentinel' })
	);
	assert(Buffer.from(await sentinelRead.Body!.transformToByteArray()).equals(sentinel));
	equalInventory(await hashTree(repository), before);
	if (config.allowSharedNamespace) {
		stage('replica-object-version-checksum-invariance');
		assert.deepEqual(await replicaManifest(), replicaBefore);
		for (let index = 0; index < replicaCount; index++)
			await run(
				restic,
				[
					'--no-cache',
					'--no-lock',
					'--cacert',
					process.env.MANAGED_EXPORT_CA_FILE!,
					'-r',
					`s3:${config.endpoint}/${config.bucket}/repositories/plan-${index}`,
					'check',
					'--read-data',
				],
				password
			);
		assert.deepEqual(await replicaManifest(), replicaBefore);
		results.sharedReplicaManifestUnchanged = 'PASS';
		results.replicaResticReadDataCheck = 'PASS';
	}
	equalInventory(await hashTree(source), current);
	results.repositoryReadOnly = 'PASS';
	results.serverNodePeakRssBytes = (await stats()).nodePeakRssBytes;
	const cgroupPeak = Number((await fs.readFile('/sys/fs/cgroup/memory.peak', 'utf8')).trim()),
		events = await fs.readFile('/sys/fs/cgroup/memory.events', 'utf8');
	assert.match(events, /^oom_kill 0$/m);
	results.cgroupPeakBytes = cgroupPeak;
	results.oomEvents = Number(/^oom (\d+)$/m.exec(events)?.[1]);
	results.oomKills = Number(/^oom_kill (\d+)$/m.exec(events)?.[1]);
	assert.equal(results.oomEvents, 0);
	const finalCpu = cpuCounters(await fs.readFile('/sys/fs/cgroup/cpu.stat', 'utf8'));
	results.cgroupCpuDelta = Object.fromEntries(
		['usage_usec', 'user_usec', 'system_usec', 'nr_throttled', 'throttled_usec'].map(key => [
			key,
			finalCpu[key] - initialCpu[key],
		])
	);
	results.cgroupCpuPercentOfTwoCpus = +(
		((finalCpu.usage_usec - initialCpu.usage_usec) /
			((performance.now() - resourceStarted) * 1000 * 2)) *
		100
	).toFixed(2);
	results.cpuUsageMicroseconds = process.cpuUsage();
	Object.assign(results, monitor.result());
	results.httpRangeResume = 'PASS';
	results.provider = 'local MinIO only';
	results.s3DownloadMiBPerSecond = +(
		job.totalBytes /
		1024 ** 2 /
		(results.clientTransferMs / 1000)
	).toFixed(2);
	console.log(JSON.stringify({ event: 'managed_resumable_lab', ...results }));
} catch (error) {
	const e = error as any;
	console.log(
		JSON.stringify({
			event: 'managed_resumable_failure',
			fixture: mode,
			phase,
			kind: error instanceof assert.AssertionError ? 'assertion' : 'fixture-error',
			httpStatus: Number.isInteger(e.$metadata?.httpStatusCode)
				? e.$metadata.httpStatusCode
				: undefined,
			code: [
				'ERR_TLS_CERT_ALTNAME_INVALID',
				'DEPTH_ZERO_SELF_SIGNED_CERT',
				'CERT_HAS_EXPIRED',
				'AccessDenied',
				'InvalidAccessKeyId',
				'InvalidRequest',
			].includes(e.code || e.name)
				? e.code || e.name
				: undefined,
		})
	);
	throw new Error('Disposable resumable export acceptance failed; see bounded phase diagnostic.');
} finally {
	monitor.stop();
	await stop().catch(() => child?.kill('SIGKILL'));
	sftp?.kill('SIGTERM');
	admin.destroy();
	restricted.destroy();
	assert(path.dirname(root) === '/lab' && /^r-[A-Za-z0-9]{6}$/.test(path.basename(root)));
	await fs.rm(root, { recursive: true, force: true });
	console.log(JSON.stringify({ event: 'managed_resumable_cleanup', fixture: mode, removed: true }));
}

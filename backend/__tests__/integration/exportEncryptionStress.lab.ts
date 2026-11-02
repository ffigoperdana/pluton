/** Synthetic large-file crypto/backpressure benchmark. No S3, backup, archive
 * files or network; native TAR/extraction acceptance is a separate fixture. */
import '../env-setup';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
	ExportCipher,
	EXPORT_CHUNK_BYTES,
	encryptedBytes,
} from '../../src/utils/managedExport/ExportEncryption';
import { exportConfiguration, type ExportJob } from '../../src/utils/managedExport/ExportPolicy';
import type { ManagedArchiveDownload } from '../../src/services/RemoteRepositoryRecoveryService';

const gib = Number(process.argv[2] || 20);
assert([20, 80].includes(gib));
assert.equal(process.getuid?.(), 1000);
assert.equal(
	(await fs.readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim(),
	String(4 * 1024 ** 3)
);
assert.equal((await fs.readFile('/sys/fs/cgroup/memory.swap.max', 'utf8')).trim(), '0');
const [quota, period] = (await fs.readFile('/sys/fs/cgroup/cpu.max', 'utf8'))
	.trim()
	.split(/\s+/)
	.map(Number);
assert.equal(quota / period, 2);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pluton-aead-stress-'));
const keyring = path.join(root, 'keyring.json');
await fs.writeFile(
	keyring,
	JSON.stringify({
		version: 1,
		active: 'fixture-key',
		keys: { 'fixture-key': crypto.randomBytes(32).toString('base64') },
	}),
	{ mode: 0o600 }
);
const config = exportConfiguration({
	MANAGED_EXPORT_ENABLED: 'true',
	MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE: 'true',
	MANAGED_EXPORT_MODE: 'application-encrypted-hcp',
	MANAGED_EXPORT_KEYRING_FILE: keyring,
	MANAGED_EXPORT_ENDPOINT: 'https://s3.example.internal',
	MANAGED_EXPORT_BUCKET: 'example-exports',
	MANAGED_EXPORT_ACCESS_KEY_ID: crypto.randomBytes(16).toString('hex'),
	MANAGED_EXPORT_SECRET_ACCESS_KEY: crypto.randomBytes(32).toString('hex'),
})!;
const bytes = gib * 1024 ** 3,
	block = crypto.randomBytes(EXPORT_CHUNK_BYTES),
	count = bytes / block.length;
// Workload-derived bound at 32 MiB/s (below the measured 20 GiB throughput),
// plus one minute. This bounds the benchmark, never a production deadline.
const signal = AbortSignal.timeout(60_000 + Math.ceil(bytes / (32 * 1024 ** 2)) * 1000),
	cpu = process.cpuUsage(),
	started = performance.now();
const expected = crypto.createHash('sha256');
for (let i = 0; i < count; i++) {
	signal.throwIfAborted();
	expected.update(block);
}
const digest = expected.digest('hex'),
	id = crypto.randomUUID();
const job = {
	id,
	owner: 'fixture-owner',
	destination: config.fingerprint,
	key: `${config.prefix}/${id}.tar`,
	binding: {
		backupId: 'backup-01',
		planId: 'plan-01',
		sourceId: 'app-01',
		repositoryId: 'repository-01',
		snapshotId: 'a'.repeat(64),
		mode: 'full',
	},
	summary: { archiveBytes: bytes, archiveSha256: digest },
	integrityMode: 'application-encrypted-hcp',
} as ExportJob;
const cipher = ExportCipher.create(job, config, bytes, digest);
job.encryption = cipher.value;
const reader = ExportCipher.open(job, config),
	wire = new PassThrough({ highWaterMark: 64 * 1024 });
const received = crypto.createHash('sha256');
let plaintextBytes = 0;
const plain = new Writable({
	write(chunk, _e, done) {
		plaintextBytes += chunk.length;
		received.update(chunk);
		done();
	},
});
let failure: unknown;
const decoding = pipeline(
	Readable.from(reader.decrypt(wire, 0, bytes - 1, signal), {
		objectMode: false,
		highWaterMark: 64 * 1024,
	}),
	plain,
	{ signal }
).catch(e => {
	failure = e;
	wire.destroy(e);
});
const archive = {
	export: job.summary,
	streamTo: (dest: Writable, stop: AbortSignal) =>
		pipeline(
			Readable.from(
				(function* () {
					for (let i = 0; i < count; i++) yield block;
				})(),
				{ objectMode: false, highWaterMark: 64 * 1024 }
			),
			dest,
			{ end: false, signal: stop }
		),
} as ManagedArchiveDownload;
try {
	await cipher
		.archive(archive, sha => {
			job.encryption!.ciphertextSha256 = sha;
		})
		.streamTo(wire, signal, () => {});
	wire.end();
	await decoding;
	if (failure) throw failure;
	assert.equal(plaintextBytes, bytes);
	assert.equal(received.digest('hex'), digest);
	const elapsedMs = Math.round(performance.now() - started),
		events = await fs.readFile('/sys/fs/cgroup/memory.events', 'utf8');
	assert.match(events, /^oom 0$/m);
	assert.match(events, /^oom_kill 0$/m);
	console.log(
		JSON.stringify({
			event: 'export_encryption_stress',
			gib,
			plaintextBytes,
			ciphertextBytes: encryptedBytes(bytes),
			frames: count,
			integrity: 'PASS',
			elapsedMs,
			throughputMiBPerSecond: +(bytes / 1024 ** 2 / (elapsedMs / 1000)).toFixed(2),
			cpuMicroseconds: process.cpuUsage(cpu),
			peakRssBytes: process.resourceUsage().maxRSS * 1024,
			cgroupPeakBytes: Number((await fs.readFile('/sys/fs/cgroup/memory.peak', 'utf8')).trim()),
			temporaryArchiveBytes: 0,
			oomKills: 0,
		})
	);
} finally {
	wire.destroy();
	await decoding;
	cipher.close();
	reader.close();
	block.fill(0);
	assert(
		path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('pluton-aead-stress-')
	);
	await fs.rm(root, { recursive: true, force: true });
}

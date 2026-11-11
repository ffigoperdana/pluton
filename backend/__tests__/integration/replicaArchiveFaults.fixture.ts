import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer, request } from 'node:https';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { processManager } from '../../src/managers/ProcessManager';
import { ManagedS3RecoverySession } from '../../src/utils/restic/ManagedS3RecoverySession';
import {
	ManagedRepositoryAccessError,
	type ManagedSftpAccess,
} from '../../src/utils/restic/ManagedSftpRepositorySession';

const TEST_IDLE_MS = 2000;

async function descendants(pid: number) {
	const root = '/proc/' + pid + '/task';
	const tasks = await fs.readdir(root);
	const children = await Promise.all(
		tasks.map(task => fs.readFile(path.join(root, task, 'children'), 'utf8').catch(() => ''))
	);
	return [...new Set(children.join(' ').trim().split(/\s+/).filter(Boolean).map(Number))];
}

async function assertReaped(pids: number[]) {
	const deadline = performance.now() + 5000;
	for (const pid of pids) {
		for (;;) {
			const present = await fs.stat('/proc/' + pid).then(
				() => true,
				(error: NodeJS.ErrnoException) => {
					if (error.code === 'ENOENT') return false;
					throw error;
				}
			);
			if (!present) break;
			assert.ok(performance.now() < deadline, 'native fixture process was not reaped');
			await delay(20);
		}
	}
}

/** Faults only the encrypted data-pack bodies in an isolated HTTPS fixture.
 * Requests keep their original Host and SigV4 headers. No request details are logged. */
export async function exerciseReplicaArchiveFaults(input: {
	root: string;
	packRoot: string;
	port: number;
	caPath: string;
	keyPath: string;
	access: ManagedSftpAccess;
	snapshotId: string;
	signal: AbortSignal;
}) {
	const cert = await fs.readFile(input.caPath);
	const packs = new Set<string>();
	for (const directory of await fs.readdir(input.packRoot)) {
		const packDirectory = path.join(input.packRoot, directory);
		for (const file of await fs.readdir(packDirectory)) {
			// Dense empty entries produce a much smaller metadata pack. The larger
			// packs contain the independent file blobs read after those entries.
			if ((await fs.stat(path.join(packDirectory, file))).size > 128 * 1024) packs.add(file);
		}
	}
	assert.ok(packs.size > 0, 'fixture must contain a data pack');
	let mode: 'plain' | 'slow' | 'stall' = 'plain';
	let selectedReads = 0;
	let announceHold: (() => void) | undefined;
	const proxy = createServer({ cert, key: await fs.readFile(input.keyPath) }, (req, res) => {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			res.writeHead(405).end();
			return;
		}
		const target = req.url || '/';
		const object = path.posix.basename(target.split('?')[0]);
		const upstream = request(
			{
				hostname: '127.0.0.1',
				port: input.port,
				method: req.method,
				path: target,
				headers: req.headers,
				ca: cert,
				agent: false,
			},
			source => {
				res.writeHead(source.statusCode || 502, source.headers);
				if (
					req.method === 'GET' &&
					packs.has(object) &&
					mode !== 'plain' &&
					source.statusCode! < 300
				) {
					selectedReads++;
					if (mode === 'stall') {
						res.flushHeaders();
						announceHold?.();
						return;
					}
					void pipeline(
						source,
						async function* (chunks, { signal }) {
							for await (const chunk of chunks) {
								await delay(45, undefined, { signal });
								yield chunk;
							}
						},
						res
					).catch(() => res.destroy());
					return;
				}
				void pipeline(source, res).catch(() => res.destroy());
			}
		);
		upstream.on('error', () => res.destroy());
		res.on('close', () => upstream.destroy());
		upstream.end();
	});
	proxy.listen(0, '127.0.0.1');
	await once(proxy, 'listening');
	const address = proxy.address();
	assert.ok(address && typeof address !== 'string');
	const repository = {
		...input.access,
		options: { ...input.access.options, endpoint: 'https://127.0.0.1:' + address.port },
	};
	const provider = new ManagedS3RecoverySession({
		RCLONE_CA_CERT: input.caPath,
		SSL_CERT_FILE: input.caPath,
	});
	const temporaryRoot = await fs.mkdtemp(path.join(input.root, 'archive-fault-sessions-'));
	const sentinel = path.join(temporaryRoot, 'keep-fixture.txt');
	await fs.writeFile(sentinel, 'not a session workspace');
	const fixtureAbort = new AbortController();
	const reads = new Set<Promise<void>>();
	const read = (
		sink: Writable,
		options: { signal?: AbortSignal; first?: () => void; wrongPassword?: boolean } = {}
	) => {
		const signal = AbortSignal.any([
			input.signal,
			fixtureAbort.signal,
			...(options.signal ? [options.signal] : []),
		]);
		const access = options.wrongPassword
			? { ...repository, password: repository.password + '-wrong' }
			: repository;
		const work = provider
			.withSession(
				access,
				session => session.archive(input.snapshotId, sink, options.first),
				signal,
				{ temporaryRoot, restoreTimeoutMs: 60 * 60_000 }
			)
			.finally(() => reads.delete(work));
		reads.add(work);
		return work;
	};
	const assertScratch = async () => {
		assert.deepEqual(await fs.readdir(temporaryRoot), ['keep-fixture.txt']);
		assert.equal(await fs.readFile(sentinel, 'utf8'), 'not a session workspace');
	};
	const sink = (accept?: (chunk: Buffer) => void) =>
		new Writable({
			write(chunk, _encoding, done) {
				accept?.(chunk);
				done();
			},
		});
	const nativeTimeout = globalThis.setTimeout;
	// Reduce only the inactivity watchdog in this disposable process. Production
	// durations, the first-output guard and native Rclone timeouts are untouched.
	globalThis.setTimeout = ((
		callback: (...args: unknown[]) => void,
		ms?: number,
		...args: unknown[]
	) =>
		nativeTimeout(callback, ms === 10 * 60_000 ? TEST_IDLE_MS : ms, ...args)) as typeof setTimeout;
	const track = processManager.trackProcess;
	let child: ChildProcess | undefined;
	processManager.trackProcess = function (id, proc) {
		if (id.startsWith('managed-download-')) child = proc;
		return track.call(this, id, proc);
	};
	try {
		mode = 'slow';
		let bytes = 0;
		const slowStarted = performance.now();
		await read(
			sink(chunk => {
				bytes += chunk.length;
			})
		);
		assert.ok(selectedReads > 1 && bytes > 4 * 1024 ** 2);
		const slowMs = Math.round(performance.now() - slowStarted);
		assert.ok(slowMs > TEST_IDLE_MS, 'slow read must outlive one idle window');
		await assertScratch();
		console.log(
			'PASS real slow S3 data-pack reads keep making archive progress past one idle window',
			{ slowMs, bytes, selectedReads }
		);

		mode = 'stall';
		for (const cancel of [false, true]) {
			let announceFirst!: () => void;
			const firstOutput = new Promise<void>(resolve => {
				announceFirst = resolve;
			});
			const held = new Promise<void>(resolve => {
				announceHold = resolve;
			});
			const controller = new AbortController();
			child = undefined;
			const work = read(sink(), { signal: controller.signal, first: announceFirst }).then(
				() => undefined,
				error => error
			);
			const pid = await Promise.race([
				Promise.all([held, firstOutput]).then(() => child?.pid),
				work.then(() => {
					throw new Error('native fixture did not reach the held S3 response');
				}),
			]);
			assert.ok(pid, 'fixture must observe the Restic child');
			const rcloneChildren = await descendants(pid);
			assert.ok(rcloneChildren.length > 0, 'fixture must observe the Rclone descendant');
			if (cancel) controller.abort();
			const failure: unknown = await work;
			assert.ok(failure instanceof ManagedRepositoryAccessError);
			assert.equal(failure.code, cancel ? 'cancelled' : 'timeout');
			assert.equal(failure.diagnostic?.timeoutCategory, cancel ? undefined : 'archive-output-idle');
			const observation = failure.diagnostic?.archive;
			assert.ok(observation && observation.bytesReceived > 0);
			assert.equal(observation.consumerPending, false);
			assert.equal(observation.processAtStop, 'running');
			assert.equal(observation.completion, 'signalled');
			if (!cancel) assert.ok(observation.lastOutputAgeMs! >= TEST_IDLE_MS - 30);
			await assertReaped([pid, ...rcloneChildren]);
			await assertScratch();
			console.log(
				cancel
					? 'PASS cancellation reaps Restic and Rclone and removes only the owned session directory'
					: 'PASS real S3 data-pack response stall after first TAR output is classified as output idle',
				observation
			);
		}

		mode = 'plain';
		let received = 0;
		const heldTail = new Writable({
			highWaterMark: 1024 * 1024,
			write(chunk, _encoding, done) {
				received += chunk.length;
				if (received < bytes) done();
			},
		});
		await assert.rejects(read(heldTail), (error: unknown) => {
			if (!(error instanceof ManagedRepositoryAccessError)) return false;
			const diagnostic = error.diagnostic;
			return (
				error.code === 'timeout' &&
				diagnostic?.timeoutCategory === 'archive-consumer-idle' &&
				diagnostic.archive?.bytesReceived === bytes &&
				diagnostic.archive.consumerPending &&
				!diagnostic.archive.consumerBackpressured &&
				diagnostic.archive.stdoutEnded &&
				diagnostic.archive.completion === 'clean-exit'
			);
		});
		assert.equal(received, bytes);
		assert.equal(heldTail.destroyed, true);
		await assertScratch();
		console.log('PASS real Restic EOF waits for the last consumer write below the high water mark');

		await assert.rejects(
			read(sink(), { wrongPassword: true }),
			(error: unknown) =>
				error instanceof ManagedRepositoryAccessError &&
				error.code === 'wrong-password' &&
				error.diagnostic?.archive?.completion === 'nonzero-exit'
		);
		await assertScratch();
		console.log('PASS real nonzero Restic exit is classified without returning native output');
	} finally {
		fixtureAbort.abort();
		await Promise.allSettled(reads);
		processManager.trackProcess = track;
		globalThis.setTimeout = nativeTimeout;
		proxy.closeAllConnections();
		await new Promise<void>(resolve => proxy.close(() => resolve()));
	}
}

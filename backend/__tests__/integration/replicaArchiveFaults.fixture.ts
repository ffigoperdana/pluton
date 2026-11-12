import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { createServer, request } from 'node:https';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { processManager } from '../../src/managers/ProcessManager';
import { ManagedS3RecoverySession } from '../../src/utils/restic/ManagedS3RecoverySession';
import {
	ManagedRepositoryAccessError,
	type ArchiveActivityObserver,
	type ManagedSftpAccess,
} from '../../src/utils/restic/ManagedSftpRepositorySession';

const TEST_IDLE_MS = 2000;

/** Pluton before the gzip fix: Rclone's default Accept-Encoding: gzip on downloads. */
class GzipRequestingSession extends ManagedS3RecoverySession {
	protected async connectionConfiguration(access: ManagedSftpAccess) {
		const configuration = await super.connectionConfiguration(access);
		const contents = configuration.contents.replace(
			'use_accept_encoding_gzip = false',
			'use_accept_encoding_gzip = true'
		);
		assert.notEqual(contents, configuration.contents, 'fixture must re-enable gzip requests');
		return { ...configuration, contents };
	}
}

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
	let mode: 'plain' | 'slow' | 'stall' | 'gzip-range' = 'plain';
	let selectedReads = 0;
	let gzipResponses = 0;
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
				if (
					mode === 'gzip-range' &&
					req.method === 'GET' &&
					packs.has(object) &&
					req.headers.range &&
					/\bgzip\b/i.test(String(req.headers['accept-encoding'] || '')) &&
					source.statusCode! < 300
				) {
					// As observed on HCP: a Range GET that accepts gzip gets a gzip body for that range.
					const chunks: Buffer[] = [];
					source.on('data', chunk => chunks.push(chunk));
					source.on('error', () => res.destroy());
					source.on('end', () => {
						const body = gzipSync(Buffer.concat(chunks));
						gzipResponses++;
						res
							.writeHead(source.statusCode!, {
								...source.headers,
								'content-encoding': 'gzip',
								'content-length': String(body.length),
							})
							.end(body);
					});
					return;
				}
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
	const trust = { RCLONE_CA_CERT: input.caPath, SSL_CERT_FILE: input.caPath };
	const provider = new ManagedS3RecoverySession(trust);
	const gzipRequesting = new GzipRequestingSession(trust);
	const temporaryRoot = await fs.mkdtemp(path.join(input.root, 'archive-fault-sessions-'));
	const sentinel = path.join(temporaryRoot, 'keep-fixture.txt');
	await fs.writeFile(sentinel, 'not a session workspace');
	const fixtureAbort = new AbortController();
	const reads = new Set<Promise<void>>();
	const read = (
		sink: Writable,
		options: {
			signal?: AbortSignal;
			onActivity?: ArchiveActivityObserver;
			wrongPassword?: boolean;
			session?: ManagedS3RecoverySession;
		} = {}
	) => {
		const signal = AbortSignal.any([
			input.signal,
			fixtureAbort.signal,
			...(options.signal ? [options.signal] : []),
		]);
		const access = options.wrongPassword
			? { ...repository, password: repository.password + '-wrong' }
			: repository;
		const work = (options.session || provider)
			.withSession(
				access,
				session => session.archive(input.snapshotId, sink, options.onActivity),
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
		nativeTimeout(
			callback,
			ms === 10 * 60_000 ? TEST_IDLE_MS : ms === 30_000 ? 250 : ms === 5_000 ? 200 : ms,
			...args
		)) as typeof setTimeout;
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

		mode = 'gzip-range';
		gzipResponses = 0;
		const gzipFailure: unknown = await read(sink(), { session: gzipRequesting }).then(
			() => undefined,
			error => error
		);
		assert.ok(gzipFailure instanceof ManagedRepositoryAccessError);
		assert.equal(gzipFailure.code, 'timeout');
		const gzipArchive = gzipFailure.diagnostic?.archive;
		assert.ok(gzipArchive && gzipArchive.processAtStop === 'running' && gzipArchive.bytesReceived < bytes);
		assert.ok(gzipResponses > 0, 'gzip-requesting Rclone must receive gzip Range bodies');
		// Restic's stderr retries now surface as a closed summary and a distinct category.
		assert.equal(gzipFailure.diagnostic?.timeoutCategory, 'archive-backend-retrying');
		const backendRetries = gzipArchive.backendRetries;
		assert.ok(backendRetries && backendRetries.retryCount > 0, 'Restic retries must be summarized');
		// The gzip body is longer than the declared range: a wrong-size response, not "other".
		assert.ok((backendRetries.errorClasses['partial-read'] ?? 0) > 0, 'gzip ranges must classify as wrong-size');
		assert.ok(
			backendRetries.loads.some(
				load => load.objectType === 'data' && [...packs].some(name => name.startsWith(load.packPrefix))
			),
			'the summary must name a gzip-faulted data pack'
		);
		assert.doesNotMatch(JSON.stringify(gzipFailure.diagnostic), /127\.0\.0\.1|https?:|password|secret/i);
		await assertScratch();
		console.log(
			'PASS gzip Range bodies requested by default Rclone settings leave Restic retrying until the watchdog',
			{ gzipResponses, backendRetries }
		);
		gzipResponses = 0;
		let exact = 0;
		await read(
			sink(chunk => {
				exact += chunk.length;
			})
		);
		assert.equal(exact, bytes);
		assert.equal(gzipResponses, 0, 'managed sessions must not request gzip Range bodies');
		await assertScratch();
		console.log(
			'PASS managed S3 recovery sessions never request gzip, so the same server returns exact Range bytes',
			{ bytes: exact }
		);

		mode = 'stall';
		for (const outcome of ['timeout', 'cancel', 'exit'] as const) {
			let announceFirst!: () => void;
			const firstOutput = new Promise<void>(resolve => {
				announceFirst = resolve;
			});
			const held = new Promise<void>(resolve => {
				announceHold = resolve;
			});
			const controller = new AbortController();
			child = undefined;
			const activities: string[] = [];
			const work = read(sink(), {
				signal: controller.signal,
				onActivity: activity => {
					activities.push(activity);
					announceFirst();
				},
			}).then(
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
			if (outcome === 'cancel') controller.abort();
			if (outcome === 'exit') assert.ok((child as ChildProcess | undefined)?.kill('SIGKILL'));
			const failure: unknown = await work;
			assert.ok(failure instanceof ManagedRepositoryAccessError);
			assert.equal(
				failure.code,
				outcome === 'cancel' ? 'cancelled' : outcome === 'exit' ? 'archive-failed' : 'timeout'
			);
			assert.equal(
				failure.diagnostic?.timeoutCategory,
				outcome === 'timeout' ? 'archive-output-idle' : undefined
			);
			const observation = failure.diagnostic?.archive;
			assert.ok(
				observation &&
					observation.bytesReceived >= 2 * 1024 ** 2 &&
					observation.bytesReceived <= 2.5 * 1024 ** 2
			);
			assert.equal(observation.consumerPending, false);
			assert.equal(observation.processAtStop, outcome === 'exit' ? 'exited' : 'running');
			assert.equal(observation.completion, 'signalled');
			if (outcome === 'timeout') {
				assert.ok(observation.lastOutputAgeMs! >= TEST_IDLE_MS - 30);
				assert.deepEqual(activities, ['validating-archive-output', 'archive-output-paused']);
				assert.ok(observation.nativeIo?.restic && observation.nativeIo.rclone);
				assert.ok(
					observation.nativeIo.windowMs > 0 && observation.nativeIo.sampleAgeMs < TEST_IDLE_MS
				);
				assert.equal(observation.nativeIo.rclone.readBytes, 0);
				assert.equal(observation.nativeIo.rclone.writtenBytes, 0);
			}
			await assertReaped([pid, ...rcloneChildren]);
			await assertScratch();
			console.log(
				outcome === 'cancel'
					? 'PASS cancellation reaps Restic and Rclone and removes only the owned session directory'
					: outcome === 'exit'
						? 'PASS unexpected Restic exit after partial TAR closes the read and reaps Rclone'
						: 'PASS real S3 data-pack response stall after roughly two MiB of TAR output',
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

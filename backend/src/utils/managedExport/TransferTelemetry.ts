import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import type { Response } from 'express';
import { Writable } from 'stream';
import { planLogger } from '../logger';

const safeReasons = new Set([
	'timeout',
	'cancelled',
	'stream-interrupted',
	'execution-failed',
	'repository-unavailable',
	'wrong-password',
	'object-mismatch',
	'storage-unavailable',
	'expired',
	'queue-full',
	'range-invalid',
]);
export function transferReason(error: unknown) {
	const e = error as { reason?: string; code?: string };
	return safeReasons.has(e?.reason || '')
		? e.reason!
		: safeReasons.has(e?.code || '')
			? e.code!
			: 'archive-interrupted';
}
function pressure() {
	try {
		const bytes = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
		return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
	} catch {
		return undefined;
	}
}

/** Socket acceptance counters never claim client receipt or verification.
 * Six time buckets, no per-chunk history, paths, arguments or provider text. */
export function observeTransfer(
	response: Response,
	delivery: 'standard' | 'reliable-proxy',
	emit: (record: Record<string, unknown>) => void = record => {
		try {
			planLogger('download').info(record, 'Managed HTTP transfer.');
		} catch {
			/* Diagnostics are best effort. */
		}
	},
	now = () => performance.now()
) {
	const id = crypto.randomUUID(),
		start = now(),
		buckets = Array.from({ length: 6 }, () => ({ second: -1, bytes: 0 }));
	let bytes = 0,
		first: number | undefined,
		last = start,
		blocked = 0,
		ended = false;
	const snapshot = (stage: string, reason?: string) => {
		const at = now(),
			seconds = Math.floor(at / 1000);
		emit({
			event: 'managed_transfer',
			id,
			delivery,
			stage,
			reason,
			elapsedMs: at - start,
			timeToFirstByteMs: first === undefined ? null : first - start,
			originAcceptedBytes: bytes,
			averageBytesPerSecond: Math.round((bytes * 1000) / Math.max(1, at - start)),
			rollingBytesPerSecond: Math.round(
				buckets.filter(b => b.second > seconds - 5).reduce((n, b) => n + b.bytes, 0) /
					Math.min(5, Math.max(0.001, (at - start) / 1000))
			),
			lastWriteAgeMs: at - last,
			backpressureMs: blocked,
			nodeRssBytes: process.memoryUsage().rss,
			cgroupCurrentBytes: pressure(),
			hostFreeBytes: os.freemem(),
			load1: os.loadavg()[0],
			httpStatus: response.statusCode,
		});
	};
	const output = new Writable({
		highWaterMark: 64 * 1024,
		write(chunk: Buffer, _encoding, done) {
			const before = now();
			let backpressure = false;
			try {
				backpressure = !response.write(chunk, error => {
					if (error) {
						done(error);
						return;
					}
					const at = now();
					bytes += chunk.length;
					first ??= at;
					last = at;
					if (backpressure) blocked += at - before;
					const second = Math.floor(at / 1000),
						bucket = buckets[second % 6];
					if (bucket.second !== second) {
						bucket.second = second;
						bucket.bytes = 0;
					}
					bucket.bytes += chunk.length;
					done();
				});
			} catch (error) {
				done(error as Error);
			}
		},
	});
	output.on('error', () => undefined);
	const close = () => {
		if (!ended && !response.writableFinished) output.destroy(new Error('peer-closed'));
	};
	response.on('close', close);
	const timer = setInterval(() => snapshot('progress'), 15_000);
	timer.unref();
	return {
		output,
		finish(reason: string) {
			if (ended) return;
			ended = true;
			clearInterval(timer);
			response.removeListener('close', close);
			snapshot('terminal', reason);
			output.destroy();
		},
	};
}

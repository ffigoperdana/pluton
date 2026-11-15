import { readProcessCounters } from './archiveProcessObservation';
import fs from 'fs/promises';

/** One process of a managed command, identified by PID and start time so a reused PID never counts. */
export type ProcessTreeSample = { key: string; bytes: number; cpuTicks: number }[];
export type ProgressState = 'unobservable' | 'active' | 'stalled';

/**
 * Limits for long replication commands (copy, init, SQL artifact reads).
 *
 * A first copy of a large plan legitimately runs for hours, so a fixed limit cannot tell a slow
 * copy from a stuck one. Progress is the I/O (`rchar` + `wchar`) and CPU time of Restic and its
 * Rclone backends. A command that moves less than `progressBytes` and uses less than
 * `progressCpuTicks` within `stallMs` is stopped. `limitMs` still bounds a job that keeps moving,
 * because replication has a single slot for the whole server. Where the counters cannot be read,
 * the previous fixed `legacyLimitMs` applies unchanged.
 */
export const REPLICATION_PROGRESS = {
	sampleMs: 15_000,
	stallMs: 10 * 60_000,
	progressBytes: 1024 * 1024,
	/** `/proc` reports CPU time in USER_HZ, which is 100 per second on Linux. */
	progressCpuTicks: 30 * 100,
	legacyLimitMs: 30 * 60_000,
	limitMs: 24 * 60 * 60_000,
};

export type ReplicationProgressLimits = typeof REPLICATION_PROGRESS;

export function createProgressTracker(
	startedAt: number,
	limits: Pick<
		ReplicationProgressLimits,
		'stallMs' | 'progressBytes' | 'progressCpuTicks'
	> = REPLICATION_PROGRESS
) {
	let last = new Map<string, { bytes: number; cpuTicks: number }>();
	let observed = false;
	let progressAt = startedAt;
	let bytes = 0;
	let cpuTicks = 0;
	return {
		observe(sample: ProcessTreeSample | undefined, now: number): ProgressState {
			if (sample?.length) {
				observed = true;
				const next = new Map<string, { bytes: number; cpuTicks: number }>();
				for (const item of sample) {
					const before = last.get(item.key);
					if (before && item.bytes >= before.bytes && item.cpuTicks >= before.cpuTicks) {
						bytes += item.bytes - before.bytes;
						cpuTicks += item.cpuTicks - before.cpuTicks;
					}
					next.set(item.key, { bytes: item.bytes, cpuTicks: item.cpuTicks });
				}
				last = next;
				if (bytes >= limits.progressBytes || cpuTicks >= limits.progressCpuTicks) {
					progressAt = now;
					bytes = 0;
					cpuTicks = 0;
				}
			}
			if (!observed) return 'unobservable';
			return now - progressAt >= limits.stallMs ? 'stalled' : 'active';
		},
	};
}

/**
 * Counters of the managed process and its direct Rclone children. Used for progress detection
 * only; nothing here is logged or returned to a client.
 */
export async function sampleProcessTree(
	pid: number,
	name: string
): Promise<ProcessTreeSample | undefined> {
	if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return;
	const root = await readProcessCounters(pid, name);
	if (!root) return;
	const entry = (counters: NonNullable<typeof root>) => ({
		key: `${counters.pid}:${counters.start}`,
		bytes: counters.readBytes + counters.writtenBytes,
		cpuTicks: counters.cpuTicks,
	});
	const sample = [entry(root)];
	try {
		// Go can spawn Rclone on any thread; inspect a bounded number of threads and children.
		const tasks = await fs.opendir('/proc/' + pid + '/task');
		let threads = 32;
		for await (const task of tasks) {
			if (!threads-- || sample.length > 8) break;
			if (!/^\d+$/.test(task.name)) continue;
			const children = await fs
				.readFile('/proc/' + pid + '/task/' + task.name + '/children', 'utf8')
				.catch(() => '');
			for (const child of children.trim().split(/\s+/, 8)) {
				if (!/^[1-9]\d*$/.test(child)) continue;
				const rclone = await readProcessCounters(Number(child), 'rclone', pid);
				if (rclone && !sample.some(item => item.key === `${rclone.pid}:${rclone.start}`))
					sample.push(entry(rclone));
			}
		}
	} catch {
		// The managed process alone still describes this sample.
	}
	return sample;
}

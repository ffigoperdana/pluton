import { spawn } from 'child_process';
import {
	REPLICATION_PROGRESS,
	createProgressTracker,
	sampleProcessTree,
} from '../../src/utils/restic/replicationProgress';

const MiB = 1024 * 1024;
const minute = 60_000;
const proc = (key: string, bytes: number, cpuTicks = 0) => ({ key, bytes, cpuTicks });

describe('replication progress tracker', () => {
	it('stays unobservable while process counters cannot be read', () => {
		const tracker = createProgressTracker(0);
		expect(tracker.observe(undefined, minute)).toBe('unobservable');
		expect(tracker.observe(undefined, 40 * minute)).toBe('unobservable');
	});

	it('keeps a slow but moving copy active far beyond thirty minutes', () => {
		const tracker = createProgressTracker(0);
		let state = '';
		// 2 MiB every 15 s is about 0.13 MiB/s, slower than the production HCP uplink.
		for (let at = 0, bytes = 0; at <= 6 * 60 * minute; at += 15_000, bytes += 2 * MiB)
			state = tracker.observe([proc('100:1', bytes)], at);
		expect(state).toBe('active');
	});

	it('reports a stall after the window passes without meaningful I/O or CPU', () => {
		const tracker = createProgressTracker(0);
		expect(tracker.observe([proc('100:1', 50 * MiB, 500)], 15_000)).toBe('active');
		// A lock refresh writes a few hundred bytes; that is not progress.
		expect(tracker.observe([proc('100:1', 50 * MiB + 400, 501)], 5 * minute)).toBe('active');
		expect(
			tracker.observe([proc('100:1', 50 * MiB + 800, 502)], REPLICATION_PROGRESS.stallMs - 1)
		).toBe('active');
		expect(
			tracker.observe([proc('100:1', 50 * MiB + 800, 502)], REPLICATION_PROGRESS.stallMs)
		).toBe('stalled');
	});

	it('restarts the stall window whenever enough bytes have moved', () => {
		const tracker = createProgressTracker(0);
		tracker.observe([proc('100:1', 0)], 15_000);
		expect(tracker.observe([proc('100:1', 2 * MiB)], 9 * minute)).toBe('active');
		expect(tracker.observe([proc('100:1', 2 * MiB)], 18 * minute)).toBe('active');
		expect(tracker.observe([proc('100:1', 2 * MiB)], 19 * minute)).toBe('stalled');
	});

	it('counts sustained CPU work as progress', () => {
		const tracker = createProgressTracker(0);
		tracker.observe([proc('100:1', 0, 0)], 15_000);
		expect(
			tracker.observe([proc('100:1', 0, REPLICATION_PROGRESS.progressCpuTicks)], 9 * minute)
		).toBe('active');
		expect(
			tracker.observe([proc('100:1', 0, REPLICATION_PROGRESS.progressCpuTicks)], 18 * minute)
		).toBe('active');
	});

	it('counts I/O of child processes such as the Rclone backends', () => {
		const tracker = createProgressTracker(0);
		tracker.observe([proc('100:1', 10), proc('101:2', 0)], 15_000);
		expect(tracker.observe([proc('100:1', 10), proc('101:2', 4 * MiB)], 9 * minute)).toBe('active');
		expect(tracker.observe([proc('100:1', 10), proc('101:2', 4 * MiB)], 18 * minute)).toBe(
			'active'
		);
	});

	it('never counts the totals of a process that replaced another one as progress', () => {
		const tracker = createProgressTracker(0);
		tracker.observe([proc('100:1', 0)], 15_000);
		// Same PID, different start time: a new process, not 900 MiB of progress.
		tracker.observe([proc('100:7', 900 * MiB)], 5 * minute);
		expect(tracker.observe([proc('100:7', 900 * MiB)], REPLICATION_PROGRESS.stallMs)).toBe(
			'stalled'
		);
	});
});

describe('process tree sampling', () => {
	(process.platform === 'linux' ? it : it.skip)(
		'reads the I/O and CPU counters of a live process',
		async () => {
			// Node renames its main thread to MainThread, so a plain `sleep` child is used instead.
			const child = spawn('sleep', ['5'], { stdio: 'ignore' });
			try {
				await new Promise(resolve => setTimeout(resolve, 200));
				const sample = await sampleProcessTree(child.pid!, 'sleep');
				expect(sample?.[0]).toMatchObject({
					key: expect.stringMatching(new RegExp(`^${child.pid}:\\d+$`)),
				});
				expect(Number.isSafeInteger(sample![0].bytes)).toBe(true);
				expect(await sampleProcessTree(child.pid!, 'restic')).toBeUndefined();
			} finally {
				child.kill('SIGKILL');
			}
		}
	);
	(process.platform === 'linux' ? it.skip : it)(
		'is unobservable where /proc counters do not exist',
		async () => {
			expect(await sampleProcessTree(process.pid, 'node')).toBeUndefined();
		}
	);
});

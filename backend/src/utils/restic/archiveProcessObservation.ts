import fs from 'fs/promises';

type ProcessCounters = {
	pid: number;
	start: string;
	readBytes: number;
	writtenBytes: number;
	cpuTicks: number;
};
type ProcessSample = { at: number; restic: ProcessCounters; rclone?: ProcessCounters };
type CounterDelta = Pick<ProcessCounters, 'readBytes' | 'writtenBytes' | 'cpuTicks'>;
export type ArchiveProcessWindow = {
	windowMs: number;
	sampleAgeMs: number;
	restic?: CounterDelta;
	rclone?: CounterDelta;
};

async function counters(pid: number, name: 'restic' | 'rclone', parent?: number) {
	try {
		const stat = await fs.readFile('/proc/' + pid + '/stat', 'utf8');
		const end = stat.lastIndexOf(')');
		if (stat.slice(stat.indexOf('(') + 1, end) !== name) return undefined;
		const fields = stat.slice(end + 2).split(' ');
		if (parent !== undefined && Number(fields[1]) !== parent) return undefined;
		const cpuTicks = Number(fields[11]) + Number(fields[12]);
		const io = await fs.readFile('/proc/' + pid + '/io', 'utf8');
		const readBytes = Number(/^rchar:\s*(\d+)$/m.exec(io)?.[1]);
		const writtenBytes = Number(/^wchar:\s*(\d+)$/m.exec(io)?.[1]);
		if (
			!/^\d+$/.test(fields[19] || '') ||
			![cpuTicks, readBytes, writtenBytes].every(value => Number.isSafeInteger(value) && value >= 0)
		)
			return undefined;
		return { pid, start: fields[19], readBytes, writtenBytes, cpuTicks };
	} catch {
		return undefined; // Process exit or host policy can make these counters unavailable.
	}
}

export async function sampleArchiveProcesses(pid: number): Promise<ProcessSample | undefined> {
	if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return;
	const restic = await counters(pid, 'restic');
	if (!restic) return;
	try {
		// Go can spawn Rclone on a non-main thread. Only inspect a bounded
		// number of threads and exact direct children of this managed process.
		const tasks = await fs.opendir('/proc/' + pid + '/task');
		let remaining = 32;
		for await (const task of tasks) {
			if (!remaining--) break;
			if (!/^\d+$/.test(task.name)) continue;
			const children = await fs
				.readFile('/proc/' + pid + '/task/' + task.name + '/children', 'utf8')
				.catch(() => '');
			for (const child of children.trim().split(/\s+/, 8)) {
				if (!/^[1-9]\d*$/.test(child)) continue;
				const rclone = await counters(Number(child), 'rclone', pid);
				if (rclone) return { at: performance.now(), restic, rclone };
			}
		}
	} catch {
		// The available Restic counters still describe this sample.
	}
	return { at: performance.now(), restic };
}

function delta(before?: ProcessCounters, after?: ProcessCounters): CounterDelta | undefined {
	if (!before || !after || before.pid !== after.pid || before.start !== after.start) return;
	const readBytes = after.readBytes - before.readBytes;
	const writtenBytes = after.writtenBytes - before.writtenBytes;
	const cpuTicks = after.cpuTicks - before.cpuTicks;
	if (readBytes < 0 || writtenBytes < 0 || cpuTicks < 0) return;
	return { readBytes, writtenBytes, cpuTicks };
}

export function archiveProcessWindow(before: ProcessSample, after: ProcessSample) {
	const restic = delta(before.restic, after.restic);
	const rclone = delta(before.rclone, after.rclone);
	if (!restic && !rclone) return undefined;
	return { at: after.at, windowMs: Math.round(after.at - before.at), restic, rclone };
}

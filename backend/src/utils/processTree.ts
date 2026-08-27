import { ChildProcess, execFile } from 'child_process';

export type KillableProcess = ChildProcess & { __plutonKilled?: boolean };

/**
 * Kills a child process and every process it spawned (e.g. restic's rclone
 * child that holds the repository lock). A plain child.kill() reaches only the
 * direct child and leaves the tree alive.
 */
export function killProcessTree(
	child: KillableProcess | undefined | null,
	signal: NodeJS.Signals = 'SIGTERM'
): void {
	if (!child || child.pid === undefined) {
		return;
	}
	const pid = child.pid;
	child.__plutonKilled = true;

	if (process.platform === 'win32') {
		// /T reaches the child tree; /F is required because a console program
		// ignores the WM_CLOSE that /T sends on its own.
		execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {
			// Ignore taskkill errors: the process may already be gone.
		});
		try {
			child.kill();
		} catch {
			// Process may have already exited.
		}
		return;
	}

	// POSIX: a negative pid targets the whole process group. This needs the
	// child to be spawned detached (setsid) so restic and rclone share a group.
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// Process may have already exited.
		}
	}

	const sigkillTimer = setTimeout(() => {
		try {
			process.kill(-pid, 'SIGKILL');
		} catch {
			// Already dead: kill throws ESRCH.
		}
	}, 1500);
	sigkillTimer.unref();
}

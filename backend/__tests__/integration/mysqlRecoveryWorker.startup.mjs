// Read-only fixture probe: fixed paths, numeric stat data and closed categories only.
import fs from 'node:fs';
const socket = '/run/pluton-mysql-worker/worker.sock';
export function inspectLayout() {
	const stat = file => {
		try {
			const value = fs.lstatSync(file);
			return {
				uid: value.uid,
				gid: value.gid,
				mode: value.mode & 0o777,
				kind: value.isSymbolicLink()
					? 'symlink'
					: value.isDirectory()
						? 'directory'
						: value.isSocket()
							? 'socket'
							: value.isFile()
								? 'file'
								: 'other',
			};
		} catch {
			return { kind: 'unavailable' };
		}
	};
	const ipc = stat('/run/pluton-mysql-worker'),
		endpoint = stat(socket);
	const config = stat('/run/pluton-mysql-config/target.json'),
		trust = stat('/run/pluton-mysql-config/ca.pem');
	const identity = process.getuid?.() === 10001 && process.getgid?.() === 10001;
	let stage = 'waiting';
	if (!identity) stage = 'identity';
	else if (ipc.kind !== 'directory' || ipc.uid !== 10001 || ipc.gid !== 10001 || ipc.mode !== 0o700)
		stage = 'ipc-directory';
	else if (config.kind !== 'file' || config.uid !== 0 || config.mode & 0o022)
		stage = 'configuration';
	else if (trust.kind !== 'file' || trust.uid !== 0 || trust.mode & 0o022) stage = 'trust';
	else if (
		endpoint.kind === 'socket' &&
		endpoint.uid === 10001 &&
		endpoint.gid === 10001 &&
		endpoint.mode === 0o700
	)
		stage = 'binding';
	else if (
		endpoint.kind !== 'unavailable' &&
		(endpoint.kind !== 'socket' ||
			endpoint.uid !== 10001 ||
			endpoint.gid !== 10001 ||
			endpoint.mode !== 0o600)
	)
		stage = 'ipc-socket';
	else if (endpoint.kind === 'socket') stage = 'socket-present';
	return { stage, identity, ipc, endpoint, config, trust };
}
if (process.argv[1]?.endsWith('/mysqlRecoveryWorker.startup.mjs')) {
	const report = inspectLayout();
	process.stdout.write(JSON.stringify(report) + '\n');
}

import { ManagedReplicationExecutor, unclassifiedFailureCode } from '../../src/utils/restic/ManagedReplicationExecutor';

// The real process boundary runs a disposable Node child, never Restic/storage.
jest.mock('../../src/utils/binaryPathResolver', () => ({ getBinaryPath: () => process.execPath }));

describe('Managed replication child process security', () => {
	it('retains stdout only and classifies provider errors without stderr secrets', async () => {
		const executor = new ManagedReplicationExecutor() as any;
		await expect(executor.command('rclone', ['-e', "process.stderr.write('synthetic-secret://private');process.exit(12)"], {})).rejects.toMatchObject({ code: 'wrong-password', message: 'Managed replication failed (wrong-password).' });
	});
	it.each([
		['SignatureDoesNotMatch synthetic-private-secret', 'storage-authentication-failed'],
		['InvalidAccessKeyId synthetic-private-secret', 'storage-authentication-failed'],
		['HTTP status 403 AccessDenied synthetic-private-secret', 'storage-access-denied'],
		['x509: certificate signed by unknown authority synthetic-private-secret', 'storage-tls-failed'],
		['Delete denied by retention policy synthetic-private-secret', 'retention-denied'],
	])('classifies sanitized provider failure %s', async (diagnostic, expected) => {
		const executor = new ManagedReplicationExecutor() as any;
		await expect(executor.command('rclone', ['-e', `process.stderr.write(${JSON.stringify(diagnostic)});process.exit(1)`], {})).rejects.toMatchObject({ code: expected, message: `Managed replication failed (${expected}).` });
	});
	it.each([
		['Fatal: write /tmp/restic-temp-pack-123456: no space left on device', 'no-space-left'],
		['Fatal: cannot dump file: path "/pluton/database/app-01.sql" not found in snapshot', 'snapshot-path-missing'],
		['Fatal: unable to open repository: dial tcp 192.0.2.10:22: connect: connection refused', 'storage-unreachable'],
		['Fatal: unable to open repository: dial tcp: lookup sftp.example.internal: no such host', 'storage-dns-failed'],
		['Load(<data/0123456789>, 4096, 0) failed: unexpected HTTP response (503): 503 Service Unavailable', 'storage-server-error'],
		['Load(<data/0123456789>, 4096, 0) failed: unexpected HTTP response (400): 400 Bad Request', 'storage-request-rejected'],
		['Fatal: unable to save snapshot: read tcp 192.0.2.10:443: i/o timeout', 'storage-timeout'],
		['Fatal: unable to refresh lock: synthetic', 'lock-refresh-failed'],
		['Fatal: unknown flag: --synthetic', 'restic-arguments-rejected'],
		['Fatal: synthetic unrecognised failure', 'execution-failed'],
	])('classifies an unrecognised Restic failure "%s" without keeping its text', async (diagnostic, expected) => {
		const executor = new ManagedReplicationExecutor() as any;
		const error = await executor.command('rclone', ['-e', `process.stderr.write(${JSON.stringify(diagnostic)});process.exit(1)`], {}).catch((caught: Error) => caught);
		expect(error).toMatchObject({ code: expected, detail: { exitCode: 1 } });
		expect(JSON.stringify({ message: error.message, detail: error.detail })).not.toMatch(/192\.0\.2\.10|example\.internal|app-01|restic-temp-pack|synthetic/);
	});
	it('summarises backend retry lines as counts and closed classes only', async () => {
		const executor = new ManagedReplicationExecutor() as any;
		const lines = 'Load(<data/0123456789>, 4096, 0) returned error, retrying after 1.5s: unexpected HTTP response (503): synthetic\nLoad(<data/0123456789>, 4096, 0) failed: unexpected HTTP response (503): synthetic\n';
		const error = await executor.command('rclone', ['-e', `process.stderr.write(${JSON.stringify(lines)});process.exit(1)`], {}).catch((caught: Error) => caught);
		expect(error).toMatchObject({ code: 'storage-server-error', detail: { backend: { retryCount: 1, gaveUpCount: 1, httpStatus: 503 } } });
		expect(JSON.stringify(error.detail)).not.toContain('synthetic');
	});
	(process.platform === 'win32' ? it.skip : it)('reports a child killed by a signal it did not receive from Pluton', async () => {
		const executor = new ManagedReplicationExecutor() as any;
		await expect(executor.command('rclone', ['-e', "process.kill(process.pid, 'SIGKILL')"], {})).rejects.toMatchObject({ code: 'process-killed', detail: { exitCode: null, signal: 'SIGKILL' } });
	});
	it('falls back to the generic code only when nothing is recognised', () => {
		expect(unclassifiedFailureCode(1, 'no space left on device')).toBe('no-space-left');
		expect(unclassifiedFailureCode(null, '', 'SIGTERM')).toBe('process-killed');
		expect(unclassifiedFailureCode(1, '')).toBe('execution-failed');
	});
	it('bounds captured output without retaining arbitrary large provider data', async () => {
		const executor = new ManagedReplicationExecutor() as any;
		await expect(executor.command('rclone', ['-e', "process.stdout.write('x'.repeat(5*1024*1024))"], {})).rejects.toMatchObject({ code: process.platform === 'win32' ? 'execution-uncertain' : 'output-limit' });
	});
	it('waits for child shutdown on cancellation and does not claim a known Windows tree outcome', async () => {
		const executor = new ManagedReplicationExecutor() as any;
		const controller = new AbortController();
		const pending = executor.command('rclone', ['-e', 'setInterval(()=>{},1000)'], {}, controller.signal);
		const timer = setTimeout(() => controller.abort(), 100);
		try { await expect(pending).rejects.toMatchObject({ code: process.platform === 'win32' ? 'execution-uncertain' : 'cancelled' }); }
		finally { clearTimeout(timer); }
	});
	it('uses only the supplied environment, without inherited application secrets', async () => {
		const executor = new ManagedReplicationExecutor() as any;
		const original = process.env.PLUTON_TEST_PRIVATE_SECRET;
		process.env.PLUTON_TEST_PRIVATE_SECRET = 'synthetic-parent-secret';
		try {
			await expect(executor.command('rclone', ['-e', 'process.stdout.write(String(process.env.PLUTON_TEST_PRIVATE_SECRET === undefined))'], {})).resolves.toBe('true');
		} finally {
			if (original === undefined) delete process.env.PLUTON_TEST_PRIVATE_SECRET; else process.env.PLUTON_TEST_PRIVATE_SECRET = original;
		}
	});
	it('retains uncertainty when process group termination cannot be proved', async () => {
		const executor = new ManagedReplicationExecutor() as any;
		const kill = jest.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('unavailable'), { code: 'EPERM' }); });
		try { await expect(executor.stopDescendants(123)).resolves.toBe(false); }
		finally { kill.mockRestore(); }
	});
	it('accepts only confirmed absence of the process group', async () => {
		const executor = new ManagedReplicationExecutor() as any;
		const kill = jest.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
		try { await expect(executor.stopDescendants(123)).resolves.toBe(true); }
		finally { kill.mockRestore(); }
	});
});

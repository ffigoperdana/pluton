import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { getBinaryPath } from '../../../src/utils/binaryPathResolver';
import { ManagedSftpRepositorySession } from '../../../src/utils/restic/ManagedSftpRepositorySession';

jest.mock('child_process');
jest.mock('../../../src/utils/binaryPathResolver');
jest.mock('../../../src/utils/processTree', () => ({ killProcessTree: jest.fn() }));

const access = {
	options: {
		host: '192.0.2.10',
		user: 'fixture-user',
		pass: 'synthetic-sftp-password',
		port: '22',
	},
	repositoryPath: 'application',
	password: 'synthetic-repository-password',
};
const id = 'a'.repeat(64);
const snapshot = {
	id,
	tags: ['pluton-plan-plan-01', 'pluton-backup-backup-01'],
	paths: ['/srv/example-app'],
};
const node = {
	struct_type: 'node',
	path: '/srv/example-app/index.txt',
	name: 'index.txt',
	type: 'file',
	size: 7,
	mtime: '2026-01-01T00:00:00Z',
	mode: 420,
};

describe('ManagedSftpRepositorySession credential/operation boundary', () => {
	let responses: Array<{ stdout?: string; code?: number; error?: boolean }>;
	let children: any[];
	beforeEach(() => {
		jest.clearAllMocks();
		responses = [{ stdout: 'Obscured_synthetic-value\n', code: 0 }];
		children = [];
		(getBinaryPath as jest.Mock).mockImplementation(name =>
			path.resolve('synthetic-tools', process.platform === 'win32' ? `${name}.exe` : name)
		);
		(spawn as jest.Mock).mockImplementation(() => {
			const response = responses.shift() || { stdout: '', code: 0 };
			const child = Object.assign(new EventEmitter(), {
				stdout: Object.assign(new EventEmitter(), { setEncoding: jest.fn() }),
				stderr: new EventEmitter(),
				stdin: Object.assign(new EventEmitter(), { end: jest.fn() }),
				kill: jest.fn(),
			});
			children.push(child);
			setImmediate(() => {
				child.stderr.emit(
					'data',
					Buffer.from(`${access.options.pass} ${access.password} raw provider config`)
				);
				if (response.error) child.emit('error', new Error(`${access.password} spawn failed`));
				if (response.stdout) child.stdout.emit('data', response.stdout);
				child.emit('close', response.code ?? 0);
			});
			return child;
		});
	});

	it('uses private config 0600/directory 0700, obscures plaintext on stdin and cleans after browse', async () => {
		responses.push(
			{ stdout: JSON.stringify([snapshot]) },
			{
				stdout: `${JSON.stringify({ struct_type: 'snapshot', ...snapshot })}\n${JSON.stringify(node)}\n`,
			}
		);
		let configPath = '';
		const provider = new ManagedSftpRepositorySession();
		const files = await provider.withSession(access, async session => {
			await expect(session.snapshot(id)).resolves.toEqual(snapshot);
			configPath = (spawn as jest.Mock).mock.calls[1][2].env.RCLONE_CONFIG;
			const content = await fs.readFile(configPath, 'utf8');
			expect(content).toContain('[pluton]\ntype = sftp\n');
			expect(content).toContain('pass = Obscured_synthetic-value');
			expect(content).not.toContain(access.options.pass);
			expect(content).not.toContain(access.password);
			if (process.platform !== 'win32') {
				expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
				expect((await fs.stat(path.dirname(configPath))).mode & 0o777).toBe(0o700);
			}
			return session.files(id);
		});
		expect(files).toEqual([node]);
		expect(children[0].stdin.end).toHaveBeenCalledWith(`${access.options.pass}\n`);
		expect((spawn as jest.Mock).mock.calls[0][1]).toEqual(['obscure', '-']);
		for (const [binary, args, options] of (spawn as jest.Mock).mock.calls) {
			expect(path.isAbsolute(binary)).toBe(true);
			expect(options.shell).toBe(false);
			expect(args.join(' ')).not.toContain(access.password);
			expect(args.join(' ')).not.toContain(access.options.pass);
		}
		const args = (spawn as jest.Mock).mock.calls[1][1];
		expect(args).toEqual(
			expect.arrayContaining([
				'--no-lock',
				'--no-cache',
				'--json',
				'--repo',
				'rclone:pluton:application',
				'snapshots',
				id,
			])
		);
		const env = (spawn as jest.Mock).mock.calls[1][2].env;
		expect(env.RESTIC_PASSWORD).toBe(access.password);
		expect(env).not.toHaveProperty('ENCRYPTION_KEY');
		expect(env).not.toHaveProperty('SECRET');
		await expect(fs.stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(fs.stat(path.dirname(configPath))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('exposes only fixed read/staging-write operations and never repo mutation/locks', async () => {
		responses.push({
			stdout: JSON.stringify({ message_type: 'summary', files_restored: 1, bytes_restored: 7 }),
		});
		await new ManagedSftpRepositorySession().withSession(access, async session => {
			expect(Object.keys(session).sort()).toEqual(['files', 'restore', 'snapshot']);
			await expect(
				session.restore(id, ['/srv/example-app/index.txt'], path.resolve('synthetic-staging'))
			).resolves.toEqual({ files_restored: 1, bytes_restored: 7 });
		});
		const args = (spawn as jest.Mock).mock.calls[1][1];
		expect(args).toEqual(
			expect.arrayContaining([
				'restore',
				id,
				'--overwrite',
				'never',
				'--include',
				'/srv/example-app/index.txt',
			])
		);
		expect(args).not.toEqual(
			expect.arrayContaining(['init', 'backup', 'forget', 'prune', 'unlock', 'repair', '--delete'])
		);
	});
	it.each([
		['auth/transport', 1, 'execution-failed'],
		['password', 12, 'wrong-password'],
		['unavailable', 10, 'repository-unavailable'],
	])('sanitizes %s failure and cleans config', async (_, code, category) => {
		responses.push({ code: Number(code) });
		let configPath = '';
		await expect(
			new ManagedSftpRepositorySession().withSession(access, async session => {
				try {
					return await session.files(id);
				} finally {
					configPath = (spawn as jest.Mock).mock.calls[1][2].env.RCLONE_CONFIG;
				}
			})
		).rejects.toMatchObject({
			code: category,
			message: `Managed repository access failed (${category}).`,
		});
		await expect(fs.stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
	});
	it('cleans configuration after callback throws and does not expose raw exception', async () => {
		responses.push({ stdout: JSON.stringify([snapshot]) });
		let configPath = '';
		await expect(
			new ManagedSftpRepositorySession().withSession(access, async session => {
				await session.snapshot(id);
				configPath = (spawn as jest.Mock).mock.calls[1][2].env.RCLONE_CONFIG;
				throw new Error(`${access.password} ${access.options.pass}`);
			})
		).rejects.toMatchObject({ code: 'credentials-unavailable' });
		await expect(fs.stat(path.dirname(configPath))).rejects.toMatchObject({ code: 'ENOENT' });
	});
	it.each(['latest', 'aaaaaaaa', '../snapshot'])(
		'refuses malformed/ambiguous snapshot selector %s before Restic',
		async invalid => {
			await expect(
				new ManagedSftpRepositorySession().withSession(access, session => session.snapshot(invalid))
			).rejects.toMatchObject({ code: 'configuration-invalid' });
			expect(spawn).toHaveBeenCalledTimes(1); // password obscure only
		}
	);
	it('refuses a different or ambiguous returned snapshot', async () => {
		responses.push({ stdout: JSON.stringify([{ ...snapshot, id: 'b'.repeat(64) }]) });
		await expect(
			new ManagedSftpRepositorySession().withSession(access, session => session.snapshot(id))
		).rejects.toMatchObject({ statusCode: 404 });
	});
	it('refuses malformed Restic output without returning raw fields', async () => {
		responses.push({ stdout: JSON.stringify({ password: access.password }) });
		await expect(
			new ManagedSftpRepositorySession().withSession(access, session => session.snapshot(id))
		).rejects.toMatchObject({ code: 'invalid-output' });
	});
	it.each([
		{ options: { ...access.options, ssh: 'arbitrary-command' } },
		{ options: { ...access.options, pass: 'synthetic\ninjection = true' } },
		{ repositoryPath: '../outside' },
		{ repositoryPath: 'application\ncommand' },
	])('refuses arbitrary SFTP/config/path options %p', async invalid => {
		await expect(
			new ManagedSftpRepositorySession().withSession({ ...access, ...invalid }, session =>
				session.snapshot(id)
			)
		).rejects.toMatchObject({ code: 'configuration-invalid' });
		expect(spawn).not.toHaveBeenCalled();
	});
	it('refuses fallback binaries rather than running unpinned PATH tools', async () => {
		(getBinaryPath as jest.Mock).mockReturnValue('restic');
		await expect(
			new ManagedSftpRepositorySession().withSession(access, session => session.snapshot(id))
		).rejects.toMatchObject({ code: 'execution-failed' });
		expect(spawn).not.toHaveBeenCalled();
	});
	it('does not inherit malicious repository/provider/password command environment', async () => {
		const previous = process.env.RESTIC_PASSWORD_COMMAND;
		process.env.RESTIC_PASSWORD_COMMAND = 'arbitrary-command';
		responses.push({ stdout: JSON.stringify([snapshot]) });
		try {
			await new ManagedSftpRepositorySession().withSession(access, session => session.snapshot(id));
			expect((spawn as jest.Mock).mock.calls[1][2].env).not.toHaveProperty(
				'RESTIC_PASSWORD_COMMAND'
			);
		} finally {
			if (previous === undefined) delete process.env.RESTIC_PASSWORD_COMMAND;
			else process.env.RESTIC_PASSWORD_COMMAND = previous;
		}
	});
	it('honors pre-spawn cancellation without starting a process', async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			new ManagedSftpRepositorySession().withSession(
				access,
				session => session.snapshot(id),
				controller.signal
			)
		).rejects.toMatchObject({ code: 'cancelled' });
		expect(spawn).not.toHaveBeenCalled();
	});
});

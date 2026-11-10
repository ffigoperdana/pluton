import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { ManagedS3RecoverySession } from '../../../src/utils/restic/ManagedS3RecoverySession';
import { getBinaryPath } from '../../../src/utils/binaryPathResolver';
jest.mock('child_process');
jest.mock('../../../src/utils/binaryPathResolver');
const options = {
	type: 's3',
	provider: 'Other',
	access_key_id: 'synthetic-key',
	secret_access_key: 'synthetic-secret',
	endpoint: 'https://s3.example.internal',
	force_path_style: 'true',
	env_auth: 'false',
	no_check_bucket: 'true',
};
const access = {
	options,
	repositoryPath: 'bucket-01/managed/plan-01',
	password: 'synthetic-restic-pass',
};
describe('S3 read/staging-only credential and command boundary', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		jest.mocked(getBinaryPath).mockImplementation(name => path.resolve('synthetic-tools', name));
	});
	it.each([
		'http',
		'credentials-file',
		'tls-bypass',
		'url-override',
		'logging',
		'control',
		'root',
		'escape',
		'backslash',
		'path-style',
	])('rejects unsafe %s configuration before spawn', async kind => {
		const input = { ...access, options: { ...options } };
		if (kind === 'http') input.options.endpoint = 'http://s3.example.internal';
		if (kind === 'credentials-file')
			(input.options as any).shared_credentials_file = '/operator/creds';
		if (kind === 'tls-bypass') (input.options as any).no_check_certificate = 'true';
		if (kind === 'url-override')
			(input.options as any).download_url = 'https://other.example.internal';
		if (kind === 'logging') (input.options as any).sdk_log_mode = 'Signing';
		if (kind === 'control') input.options.secret_access_key = 'synthetic\nsecret';
		if (kind === 'root') input.repositoryPath = '';
		if (kind === 'escape') input.repositoryPath = 'bucket-01/../other';
		if (kind === 'backslash')
			input.repositoryPath = 'bucket-01' + String.fromCharCode(92) + 'managed';
		if (kind === 'path-style') input.options.force_path_style = 'false';
		await expect(
			new ManagedS3RecoverySession().withSession(input, async () => {})
		).rejects.toMatchObject({ code: 'configuration-invalid' });
		expect(spawn).not.toHaveBeenCalled();
	});
	it('uses protected credentials in a private config, no-lock config identity, bounded resources and trusted CA only', async () => {
		jest.mocked(spawn).mockImplementation(((_binary, args, opts) => {
			const child: any = Object.assign(new EventEmitter(), {
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				stdin: Object.assign(new EventEmitter(), { end: jest.fn() }),
				pid: undefined,
			});
			setImmediate(() => {
				child.stdout.end(JSON.stringify({ id: 'a'.repeat(64) }));
				child.emit('close', 0);
			});
			return child;
		}) as any);
		let file = '';
		await new ManagedS3RecoverySession({
			RCLONE_CA_CERT: path.resolve('synthetic-ca.pem'),
		}).withSession(access, async session => {
			expect(Object.keys(session).sort()).toEqual([
				'archive',
				'diff',
				'dump',
				'files',
				'identity',
				'probe',
				'restore',
				'snapshot',
				'streamFiles',
			]);
			await expect(session.identity!()).resolves.toBe('a'.repeat(64));
			const [binary, args, opts] = jest.mocked(spawn).mock.calls[0] as any;
			expect(path.isAbsolute(binary)).toBe(true);
			expect(opts.shell).toBe(false);
			expect(args).toEqual(expect.arrayContaining(['--no-lock', '--no-cache', 'cat', 'config']));
			expect(args.join(' ')).not.toMatch(/synthetic-(key|secret|restic-pass)/);
			expect(opts.env).toMatchObject({
				RCLONE_CA_CERT: path.resolve('synthetic-ca.pem'),
				GOMAXPROCS: '2',
				GOMEMLIMIT: '256MiB',
			});
			file = opts.env.RCLONE_CONFIG;
			expect(await fs.readFile(file, 'utf8')).toContain('secret_access_key = synthetic-secret');
			if (process.platform !== 'win32') {
				expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
				expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
			}
		});
		await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
	});
	it('rejects arbitrary environment or relative trust path without starting a child', async () => {
		for (const trust of [
			{ NODE_OPTIONS: '--inspect' },
			{ RCLONE_CA_CERT: 'relative.pem' },
			{ RCLONE_CA_CERT: path.resolve('file.pem') + '\n' },
		])
			await expect(
				new ManagedS3RecoverySession(trust).withSession(access, async () => {})
			).rejects.toMatchObject({ code: 'configuration-invalid' });
		expect(spawn).not.toHaveBeenCalled();
	});
});

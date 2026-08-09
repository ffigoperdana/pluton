import { providers } from '../../src/utils/providers';

describe('providers setup()', () => {
	const base = { host: 'example.com', user: 'bob', pass: 'secret' };
	const baseArgs = ['host', 'example.com', 'user', 'bob', 'pass', 'secret'];

	describe('sftp', () => {
		it('sends the port when one is given', () => {
			expect(providers.sftp.setup({ ...base, port: '2222' })).toEqual([
				...baseArgs,
				'port',
				'2222',
			]);
		});

		it('omits the port when it is blank', () => {
			expect(providers.sftp.setup({ ...base, port: '' })).toEqual(baseArgs);
		});

		it('omits the port when it is absent', () => {
			expect(providers.sftp.setup(base)).toEqual(baseArgs);
		});
	});

	describe('ftp', () => {
		it('sends the port and both TLS switches', () => {
			expect(
				providers.ftp.setup({ ...base, port: '2121', tls: 'true', explicit_tls: 'false' })
			).toEqual([...baseArgs, 'port', '2121', 'tls', 'true', 'explicit_tls', 'false']);
		});

		it('omits the switches that are absent', () => {
			expect(providers.ftp.setup({ ...base, explicit_tls: 'true' })).toEqual([
				...baseArgs,
				'explicit_tls',
				'true',
			]);
		});

		it('converts a boolean switch to a string, because spawn rejects other types', () => {
			const creds = { ...base, port: 2121, tls: true } as unknown as Record<string, string>;
			const args = providers.ftp.setup(creds) as string[];

			expect(args).toEqual([...baseArgs, 'port', '2121', 'tls', 'true']);
			args.forEach(arg => expect(typeof arg).toBe('string'));
		});

		it('keeps a switch that is explicitly false', () => {
			const creds = { ...base, tls: false } as unknown as Record<string, string>;
			expect(providers.ftp.setup(creds)).toEqual([...baseArgs, 'tls', 'false']);
		});
	});

	describe('smb', () => {
		it('sends the port and the domain', () => {
			expect(providers.smb.setup({ ...base, port: '1445', domain: 'ACME' })).toEqual([
				...baseArgs,
				'port',
				'1445',
				'domain',
				'ACME',
			]);
		});

		it('omits both when they are absent', () => {
			expect(providers.smb.setup(base)).toEqual(baseArgs);
		});
	});
});

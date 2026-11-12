import {
	sftpEndpoint,
	StorageLocationAliases,
} from '../../src/utils/relocation/storageLocationAliases';

const sftp = (id: string, host: string, user: string, port?: string | number) => ({
	id,
	type: 'sftp',
	settings: { host, user, ...(port === undefined ? {} : { port }) },
});

describe('storage location aliases for the same SFTP server', () => {
	const aliases = new StorageLocationAliases([
		sftp('old', '192.0.2.10', 'pluton-backup'),
		sftp('alias', 'SFTP.Example.Internal', 'pluton-backup', '22'),
		sftp('alias-ip', '192.0.2.10', 'pluton-backup', 22),
		sftp('other-user', '192.0.2.10', 'reports'),
		sftp('other-port', '192.0.2.10', 'pluton-backup', '2222'),
		sftp('root', '192.0.2.10', 'root'),
		sftp('other-host', '192.0.2.20', 'pluton-backup'),
		{ id: 's3', type: 's3', settings: { endpoint: 'https://s3.example.internal' } },
	]);
	const at = (storageId: string, storagePath: string) => ({ storageId, storagePath });

	it('normalizes host case and the default port', () => {
		expect(sftpEndpoint(sftp('a', 'Host.Example.Internal', 'u'))).toEqual({
			server: 'host.example.internal:22',
			user: 'u',
		});
		expect(sftpEndpoint(sftp('b', ' 192.0.2.10 ', 'u', 2222))!.server).toBe('192.0.2.10:2222');
		expect(sftpEndpoint({ id: 'c', type: 's3', settings: {} })).toBeUndefined();
	});

	it('keeps the existing same-record comparison', () => {
		expect(aliases.overlaps(at('old', 'backups/a'), at('old', 'backups/a/b'))).toBe(true);
		expect(aliases.overlaps(at('old', 'backups/a'), at('old', 'backups/ab'))).toBe(false);
	});

	it('treats two records for the same host, port and user as one location', () => {
		expect(aliases.overlaps(at('old', 'backups/a'), at('alias-ip', 'backups/a'))).toBe(true);
		expect(aliases.overlaps(at('old', 'backups/a'), at('alias-ip', 'backups/a/nested'))).toBe(true);
		expect(aliases.overlaps(at('old', 'backups/a'), at('alias-ip', 'backups/b'))).toBe(false);
	});

	it('compares absolute paths for any user and relative paths through the usual home folder', () => {
		expect(aliases.overlaps(at('old', '/srv/backups/a'), at('other-user', '/srv/backups'))).toBe(true);
		// Relative paths of different users live in different home folders.
		expect(aliases.overlaps(at('old', 'backups/a'), at('other-user', 'backups/a'))).toBe(false);
		expect(aliases.overlaps(at('old', 'backups/a'), at('alias-ip', '/home/pluton-backup/backups'))).toBe(
			true
		);
		expect(aliases.overlaps(at('old', 'backups/a'), at('other-user', '/home/pluton-backup/backups/a'))).toBe(
			true
		);
		expect(aliases.overlaps(at('root', 'repos/x'), at('old', '/root/repos'))).toBe(true);
		expect(aliases.overlaps(at('old', 'backups/a'), at('alias-ip', '/srv/backups/a'))).toBe(false);
	});

	it('does not alias a different port, host name, host or storage type', () => {
		expect(aliases.overlaps(at('old', 'backups/a'), at('other-port', 'backups/a'))).toBe(false);
		// A DNS name for the same machine is not resolved (documented limitation).
		expect(aliases.overlaps(at('old', 'backups/a'), at('alias', 'backups/a'))).toBe(false);
		expect(aliases.overlaps(at('old', 'backups/a'), at('other-host', 'backups/a'))).toBe(false);
		expect(aliases.overlaps(at('s3', 'bucket/a'), at('old', 'bucket/a'))).toBe(false);
		expect(aliases.overlaps(at('old', 'backups/a'), { storageId: null, storagePath: 'backups/a' })).toBe(
			false
		);
		expect(aliases.overlaps(at('old', 'backups/a'), at('unknown', 'backups/a'))).toBe(false);
	});
});

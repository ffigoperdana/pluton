import { managedSnapshotPath, assertManagedRestorePath } from '../../src/utils/managedSnapshotPath';
import { normalizeLegacySnapshotPath } from '../../src/utils/legacySnapshotPath';

describe('managed POSIX metadata paths', () => {
	it.each(['/srv/job:2026.txt', '/srv/100%complete/%2e%2e.txt', '/srv/café-文件.txt'])(
		'preserves literal decoded JSON path %s',
		value => {
			expect(managedSnapshotPath(value)).toBe(value);
			expect(() => assertManagedRestorePath(value, 'linux')).not.toThrow();
		}
	);
	it.each([
		'/',
		'',
		'relative',
		'//srv/file',
		'/srv/../file',
		'/srv/./file',
		'/srv/file/',
		'/srv\\file',
		'/srv/\0file',
		'/srv/\nfile',
		'/srv/\uFFFD',
		'/' + 'a'.repeat(1025),
	])('refuses ambiguous, escaping or unsupported paths', value => {
		expect(() => managedSnapshotPath(value)).toThrow();
	});
	it.each([
		'/srv/job:2026.txt',
		'/srv/CON',
		'/srv/aux.txt',
		'/srv/file.',
		'/srv/file ',
		'/srv/a?b',
	])('refuses Windows host aliases only when materializing on Windows', value => {
		expect(() => assertManagedRestorePath(value, 'win32')).toThrow('POSIX');
		expect(() => assertManagedRestorePath(value, 'linux')).not.toThrow();
	});
	it('preserves the independent legacy and staging-input restrictions', () => {
		expect(() => normalizeLegacySnapshotPath('srv/100%complete')).toThrow();
		expect(() => normalizeLegacySnapshotPath('C:escape')).toThrow();
	});
});

import * as server from '../../src/utils/backupExclusions';
import * as agent from '../../../agent/src/backupExclusions';
import * as browser from '../../../frontend/src/utils/backupExclusions';

describe.each([server, agent, browser])('exclusion contract at each trust boundary', policy => {
	it.each(
		[
			[],
			['.git/', 'node_modules/', '*.tmp', '**/cache/', '*/logs/', 'public/file?.txt'],
			['.cache/', 'nested/vendor/**'],
		].map(patterns => [patterns])
	)('normalizes and agrees across packages: %j', patterns => {
		expect(policy.parseBackupExclusions(patterns)).toEqual(server.parseBackupExclusions(patterns));
		for (const name of [
			'.git',
			'nested/.git/objects/x',
			'node_modules',
			'nested/node_modules/x',
			'.cache/a',
			'cache',
			'nested/cache/x',
			'public/file1.txt',
			'a/b/logs/x',
		])
			expect(policy.backupExclusionMatches(patterns, name)).toBe(
				server.backupExclusionMatches(patterns, name)
			);
		expect(policy.sourceResticExclusions('/srv/example-app', patterns)).toEqual(
			server.sourceResticExclusions('/srv/example-app', patterns)
		);
	});
	it.each([
		'/root',
		'../x',
		'a/../b',
		'a//b',
		'./x',
		'!keep',
		'a**b',
		'**foo',
		'**/dir/**/cache',
		'C:\\temp',
		'${HOME}',
		'a\n',
		'[ab]',
		'',
		'x'.repeat(513),
	])('refuses unsupported pattern %j', pattern => {
		// Trim does not make embedded controls valid; a trailing newline is an
		// unsupported single pattern too, not an implicit extra pattern.
		expect(() => policy.parseBackupExclusions([pattern])).toThrow();
	});
	it('limits total work and never matches or broadens the source root', () => {
		expect(() => policy.parseBackupExclusions(Array(101).fill('cache'))).toThrow();
		expect(() => policy.parseBackupExclusions(Array(100).fill('a'.repeat(200)))).toThrow();
		expect(policy.backupExclusionMatches(['**'], '')).toBe(false);
		expect(policy.backupExclusionMatches(['.cache'], 'cache/x')).toBe(false);
		expect(policy.backupExclusionMatches(['*/cache'], 'cache/x')).toBe(false);
		expect(policy.backupExclusionMatches(['**/cache'], 'cache/x')).toBe(true);
		expect(policy.backupExclusionMatches(['node_modules/**'], 'node_modules')).toBe(true);
		expect(policy.backupExclusionMatches(['node_modules/**'], 'nested/node_modules')).toBe(false);
		expect(() => policy.sourceResticExclusions('/srv/app[1]', ['cache'])).toThrow();
		expect(policy.sourceResticExclusions('/srv/example-app', ['*.sql'])).toEqual([
			'/srv/example-app/**/*.sql',
		]);
	});
});

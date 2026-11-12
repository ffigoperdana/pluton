import crypto from 'crypto';
import {
	buildInventory,
	classifyRepositoryPath,
	HashVerification,
	isSubsetOf,
	locationsOverlap,
	parseHashLine,
	validateRelocationPath,
} from '../../src/utils/relocation/repositoryInventory';
import { copyStats } from '../../src/utils/relocation/SftpRepositoryTransfer';

const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const data = sha('pack');
const key = sha('key');
const listing = () => [
	{ Path: 'config', Size: 155, IsDir: false },
	{ Path: 'data', Size: -1, IsDir: true },
	{ Path: `data/${data.slice(0, 2)}/${data}`, Size: 4096, IsDir: false },
	{ Path: `keys/${key}`, Size: 460, IsDir: false },
	{ Path: `index/${sha('index')}`, Size: 900, IsDir: false },
	{ Path: `snapshots/${sha('snapshot')}`, Size: 300, IsDir: false },
	{ Path: `locks/${sha('lock')}`, Size: 120, IsDir: false },
];

describe('relocation repository inventory', () => {
	it('classifies only Restic repository files', () => {
		expect(classifyRepositoryPath('config')).toBe('config');
		expect(classifyRepositoryPath(`data/${data.slice(0, 2)}/${data}`)).toBe('data');
		expect(classifyRepositoryPath(`data/zz/${data}`)).toBeUndefined();
		expect(classifyRepositoryPath(`data/00/${data}`)).toBe(data.startsWith('00') ? 'data' : undefined);
		expect(classifyRepositoryPath(`locks/${key}`)).toBe('lock');
		expect(classifyRepositoryPath(`keys/${key}.abc123.partial`)).toBe('partial');
		expect(classifyRepositoryPath('notes.txt')).toBeUndefined();
		expect(classifyRepositoryPath(`keys/${key}/extra`)).toBeUndefined();
	});

	it('builds an exact, order-independent inventory without locks', () => {
		const inventory = buildInventory(listing());
		expect(inventory.fileCount).toBe(5);
		expect(inventory.totalBytes).toBe(155 + 4096 + 460 + 900 + 300);
		expect(inventory.entries.some(entry => entry.path.startsWith('locks/'))).toBe(false);
		expect(buildInventory([...listing()].reverse()).digest).toBe(inventory.digest);
		const changed = listing();
		changed[2] = { ...changed[2], Size: 4097 };
		expect(buildInventory(changed).digest).not.toBe(inventory.digest);
	});

	it('rejects foreign files, partial uploads outside a retry, incomplete repositories and bad output', () => {
		expect(() => buildInventory([...listing(), { Path: 'readme.txt', Size: 1 }])).toThrow(
			'unexpected-repository-file'
		);
		const partial = [...listing(), { Path: `keys/${key}.x.partial`, Size: 1 }];
		expect(() => buildInventory(partial)).toThrow('unexpected-repository-file');
		expect(buildInventory(partial, { allowPartial: true }).partial).toEqual([`keys/${key}.x.partial`]);
		expect(() => buildInventory(listing().filter(item => item.Path !== 'config'))).toThrow(
			'repository-incomplete'
		);
		expect(buildInventory([], { requireRepository: false }).fileCount).toBe(0);
		expect(() => buildInventory({})).toThrow('invalid-output');
		expect(() => buildInventory([{ Path: 'config', Size: 1.5 }])).toThrow('invalid-output');
		expect(() =>
			buildInventory([...listing(), { Path: 'config', Size: 155 }])
		).toThrow('invalid-output');
	});

	it('checks subset by name and size', () => {
		const whole = buildInventory(listing()).entries;
		expect(isSubsetOf(whole.slice(1, 3), whole)).toBe(true);
		expect(isSubsetOf([{ ...whole[0], size: whole[0].size + 1 }], whole)).toBe(false);
		expect(isSubsetOf([{ path: 'config-x', size: 1 }], whole)).toBe(false);
	});

	it('proves every destination byte by content-addressed name and config digest', () => {
		const inventory = buildInventory(listing());
		const config = sha('config');
		const lines = inventory.entries.map(entry =>
			entry.path === 'config'
				? `${config}  config`
				: `${entry.path.split('/').at(-1)}  ${entry.path}`
		);
		const ok = new HashVerification(inventory, config);
		for (const line of [...lines, `${sha('lock')}  locks/${sha('lock')}`]) ok.accept(line);
		expect(() => ok.finish()).not.toThrow();
		expect(ok.count).toBe(5);

		const corrupt = new HashVerification(inventory, config);
		expect(() => corrupt.accept(`${sha('other')}  data/${data.slice(0, 2)}/${data}`)).toThrow(
			'destination-hash-mismatch'
		);
		const wrongConfig = new HashVerification(inventory, sha('different'));
		expect(() => wrongConfig.accept(`${config}  config`)).toThrow('destination-hash-mismatch');
		const missing = new HashVerification(inventory, config);
		missing.accept(lines[0]);
		expect(() => missing.finish()).toThrow('destination-hash-mismatch');
		const duplicate = new HashVerification(inventory, config);
		duplicate.accept(lines[1]);
		expect(() => duplicate.accept(lines[1])).toThrow('destination-listing-mismatch');
		const unknown = new HashVerification(inventory, config);
		expect(() => unknown.accept(`${key}  keys/${sha('another')}`)).toThrow(
			'destination-listing-mismatch'
		);
		expect(() => parseHashLine('not a hash line')).toThrow('invalid-output');
		expect(parseHashLine(`${'A'.repeat(64)}  config\r`)).toEqual({ hash: 'a'.repeat(64), path: 'config' });
	});

	it('validates destination paths and overlap', () => {
		expect(validateRelocationPath('backups/app-01')).toBe('backups/app-01');
		expect(validateRelocationPath('/srv/backups/app-01')).toBe('/srv/backups/app-01');
		for (const value of ['', ' ', '/', '.', './', 'a/../b', 'a\\b', '-flag', ' backups', 'a\nb', 7])
			expect(() => validateRelocationPath(value)).toThrow('configuration-invalid');
		expect(locationsOverlap('backups/a', 'backups/a/')).toBe(true);
		expect(locationsOverlap('backups/a', 'backups/a/b')).toBe(true);
		expect(locationsOverlap('backups/a', 'backups/ab')).toBe(false);
		expect(locationsOverlap('', 'backups/a')).toBe(true);
	});

	it('parses only real Rclone stats counters', () => {
		expect(
			copyStats(
				JSON.stringify({
					level: 'notice',
					msg: 'stats',
					stats: { bytes: 2048, totalBytes: 4096, transfers: 1, totalTransfers: 3 },
				})
			)
		).toEqual({ copiedBytes: 2048, copyTotalBytes: 4096, copiedFiles: 1, copyTotalFiles: 3 });
		expect(copyStats('{"level":"info","msg":"Copied (new)"}')).toBeUndefined();
		expect(copyStats('plain text')).toBeUndefined();
		expect(copyStats('{"stats":{"bytes":-5,"totalBytes":"x"}}')).toEqual({
			copiedBytes: 0,
			copyTotalBytes: 0,
			copiedFiles: 0,
			copyTotalFiles: 0,
		});
	});
});

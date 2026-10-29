import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Writable } from 'stream';
import tar from 'tar-stream';
import {
	ManagedSnapshotIndexCache,
	SNAPSHOT_INDEX_LIMITS,
} from '../../../src/utils/restic/ManagedSnapshotIndex';
import {
	prepareManagedExport,
	streamManagedExport,
} from '../../../src/utils/restic/ManagedTarExport';
import { ManagedExportError } from '../../../src/utils/restic/ManagedExportPolicy';
import { MANAGED_EXPORT_LIMITS } from '../../../src/utils/restic/ManagedExportPolicy';
import type { ManagedSnapshotNode } from '../../../src/utils/restic/ManagedSftpRepositorySession';

const binding = {
	backupId: 'backup-01',
	repositoryId: 'repository-01',
	snapshotId: 'a'.repeat(64),
};
const body = Buffer.from('historical ordinary bytes\n');
const files = [
	{ path: '/srv', type: 'dir', size: 0 },
	{ path: '/srv/example-app', type: 'dir', size: 0 },
	{ path: '/srv/example-app/data.txt', type: 'file', size: body.length },
	{ path: '/srv/example-app/empty', type: 'dir', size: 0 },
];
const linked = [
	...files,
	...Object.keys({ 'file': 1, 'directory': 1, 'broken': 1, 'circle-a': 1, 'circle-b': 1 }).map(
		name => ({ path: '/srv/example-app/' + name, type: 'symlink', size: 0 })
	),
];
const targets: Record<string, string> = {
	'file': 'data.txt',
	'directory': 'empty',
	'broken': 'missing',
	'circle-a': 'circle-b',
	'circle-b': 'circle-a',
};
async function archive(nodes = files, changes: Record<string, any> = {}) {
	const pack = tar.pack();
	const chunks: Buffer[] = [];
	pack.on('data', chunk => chunks.push(chunk));
	const ended = new Promise<void>((resolve, reject) => pack.on('end', resolve).on('error', reject));
	for (const node of nodes) {
		if (!['dir', 'file', 'symlink'].includes(node.type)) continue; // actual Restic dump omits FIFO
		const name = path.posix.basename(node.path);
		const header: tar.Headers = {
			name: node.path.slice(1),
			type: node.type === 'dir' ? 'directory' : (node.type as 'file' | 'symlink'),
			size: node.size,
			mode: 0o700,
			mtime: new Date('2026-01-01T00:00:00Z'),
			uid: 10001,
			gid: 10001,
			...(node.type === 'symlink' ? { linkname: targets[name] || 'data.txt' } : {}),
			...(changes[name] || {}),
		};
		await new Promise<void>((resolve, reject) =>
			pack.entry(header, header.type === 'file' ? body : Buffer.alloc(0), error =>
				error ? reject(error) : resolve()
			)
		);
	}
	pack.finalize();
	await ended;
	return Buffer.concat(chunks);
}
function session(bytes: Buffer, fragment = 37): any {
	return {
		archive: async (_id: string, target: Writable) => {
			for (let offset = 0; offset < bytes.length; offset += fragment)
				await new Promise<void>((resolve, reject) =>
					target.write(bytes.subarray(offset, offset + fragment), error =>
						error ? reject(error) : resolve()
					)
				);
		},
	};
}
const encodeHeader = require('tar-stream/headers').encode;
function rawEntry(type: string, payload: Buffer, name = 'srv/example-app/data.txt', linkname = '') {
	const header = encodeHeader({
		name,
		type,
		size: payload.length,
		mode: 0o600,
		uid: 10001,
		gid: 10001,
		mtime: new Date('2026-01-01T00:00:00Z'),
		linkname,
	});
	const extension = (
		{ 'gnu-long-path': 'L', 'gnu-long-link-path': 'K', 'pax-global-header': 'g' } as Record<
			string,
			string
		>
	)[type];
	if (extension) {
		header[156] = extension.charCodeAt(0);
		header.fill(32, 148, 156);
		const checksum = header.reduce((sum: number, byte: number) => sum + byte, 0);
		header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
	}
	return Buffer.concat([header, payload, Buffer.alloc((512 - (payload.length % 512)) % 512)]);
}
function pax(key: string, value: string) {
	let length = Buffer.byteLength(` ${key}=${value}\n`) + 1;
	for (;;) {
		const record = `${length} ${key}=${value}\n`;
		const measured = Buffer.byteLength(record);
		if (measured === length) return record;
		length = measured;
	}
}
describe('bounded managed TAR verification, canonical export and exact proof', () => {
	let scratch: string, cache: ManagedSnapshotIndexCache;
	beforeEach(async () => {
		scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-export-'));
		cache = new ManagedSnapshotIndexCache(path.join(scratch, 'indexes'));
	});
	afterEach(async () => {
		await cache.close();
		await fs.rm(scratch, { recursive: true, force: true });
	});
	async function use(nodes: typeof files, run: (index: any) => Promise<void>) {
		await cache.use(
			'b'.repeat(64),
			async append => {
				for (const node of nodes)
					append({
						...node,
						struct_type: 'node',
						name: path.posix.basename(node.path),
						mtime: '2026-01-01T00:00:00Z',
						mode: 0o700,
					} as ManagedSnapshotNode);
			},
			run
		);
	}
	it('preserves files, empty directories, internal broken/directory/circular links and deterministic hashes', async () => {
		const bytes = await archive(linked);
		await use(linked, async index => {
			// The global legacy gate remains strict until a separate proof is requested.
			expect(() => index.assertSafe()).toThrow(/symbolic links/);
			const proof = index.exportProof(binding, 'full');
			const prepared = await prepareManagedExport(
				index,
				session(bytes, 7),
				proof,
				new AbortController().signal
			);
			expect(prepared.includedEntries).toBe(linked.length);
			expect(prepared.excludedEntries).toBe(0);
			expect(proof.get('/srv/example-app/data.txt').sha256).toBe(
				crypto.createHash('sha256').update(body).digest('hex')
			);
			const output: Buffer[] = [];
			const actual = await streamManagedExport(
				index,
				session(bytes, 1),
				proof,
				new Writable({
					write(chunk, _encoding, done) {
						output.push(chunk);
						done();
					},
				}),
				new AbortController().signal
			);
			expect(actual).toEqual(prepared);
			expect(crypto.createHash('sha256').update(Buffer.concat(output)).digest('hex')).toBe(
				prepared.archiveSha256
			);
			const entries: any[] = [];
			const extract = tar.extract();
			extract.on('entry', (header, stream, next) => {
				entries.push(header);
				stream.on('end', next);
				stream.resume();
			});
			await new Promise<void>((resolve, reject) => {
				extract.on('finish', resolve).on('error', reject);
				extract.end(Buffer.concat(output));
			});
			expect(entries.filter(row => row.type === 'symlink')).toHaveLength(5);
			expect(entries.find(row => row.name === 'srv/example-app/broken').linkname).toBe('missing');
			expect([...proof.manifestLines()].join('')).not.toContain(scratch);
		});
	});
	for (const target of [
		'/outside-fixture/secret',
		'../../../../escape',
		'nested/../../../../escape',
		'a\\b',
		'bad\nlink',
	])
		it(`refuses an unsafe target without omitting it: ${JSON.stringify(target)}`, async () => {
			const nodes = [...files, { path: '/srv/example-app/link', type: 'symlink', size: 0 }];
			await use(nodes, async index => {
				await expect(
					prepareManagedExport(
						index,
						session(await archive(nodes, { link: { linkname: target } })),
						index.exportProof(binding, 'full'),
						new AbortController().signal
					)
				).rejects.toBeInstanceOf(ManagedExportError);
				expect(index.exportProof(binding, 'full').summary).toBeUndefined();
			});
		});
	it('partial export excludes unsafe links and special nodes while proving the entire ordinary set', async () => {
		const nodes = [
			...files,
			{ path: '/srv/example-app/link', type: 'symlink', size: 0 },
			{ path: '/srv/example-app/fifo', type: 'fifo', size: 0 },
		];
		await use(nodes, async index => {
			const bytes = await archive(nodes, { link: { linkname: '/outside-fixture/secret' } });
			await expect(
				prepareManagedExport(
					index,
					session(bytes),
					index.exportProof(binding, 'full'),
					new AbortController().signal
				)
			).rejects.toMatchObject({ reason: 'unsupported-node-type' });
			const proof = index.exportProof(binding, 'regular-files');
			const result = await prepareManagedExport(
				index,
				session(bytes),
				proof,
				new AbortController().signal
			);
			expect(result.includedEntries).toBe(files.length);
			expect(result.excludedByType).toEqual({ fifo: 1, symlink: 1 });
			expect(proof.get('/srv/example-app/link')).toBeUndefined();
			expect(proof.summary.mode).toBe('regular-files');
			expect(index.exportProof(binding, 'full').summary).toBeUndefined();
		});
	});
	it('refuses type confusion even for a link excluded from a partial export', async () => {
		const nodes = [...files, { path: '/srv/example-app/link', type: 'symlink', size: 0 }];
		await use(nodes, async index => {
			await expect(
				prepareManagedExport(
					index,
					session(
						await archive(nodes, { link: { type: 'file', size: body.length, linkname: '' } })
					),
					index.exportProof(binding, 'regular-files'),
					new AbortController().signal
				)
			).rejects.toMatchObject({ reason: 'archive-entry-mismatch' });
		});
	});
	it('detects metadata-only target chains escaping through another symlink', async () => {
		const nodes = [
			{ path: '/deep', type: 'dir', size: 0 },
			{ path: '/deep/link', type: 'symlink', size: 0 },
			{ path: '/x', type: 'symlink', size: 0 },
		];
		await use(nodes, async index => {
			await expect(
				prepareManagedExport(
					index,
					session(
						await archive(nodes, { link: { linkname: '..' }, x: { linkname: 'deep/link/..' } })
					),
					index.exportProof(binding, 'full'),
					new AbortController().signal
				)
			).rejects.toMatchObject({ reason: 'unsafe-link-target' });
		});
	});
	for (const damage of [
		'checksum',
		'truncated-body',
		'missing-footer',
		'garbage-after-footer',
		'duplicate',
		'missing-entry',
		'unknown-entry',
		'hardlink',
	])
		it(`fails closed for ${damage}`, async () => {
			let bytes = await archive();
			if (damage === 'checksum') {
				bytes = Buffer.from(bytes);
				bytes[0] ^= 1;
			}
			if (damage === 'truncated-body') bytes = bytes.subarray(0, 1700);
			if (damage === 'missing-footer') bytes = bytes.subarray(0, bytes.length - 1024);
			if (damage === 'garbage-after-footer') bytes = Buffer.concat([bytes, Buffer.from('garbage')]);
			if (damage === 'duplicate') bytes = await archive([...files, files[2]]);
			if (damage === 'missing-entry') bytes = await archive(files.slice(0, 3));
			if (damage === 'unknown-entry')
				bytes = await archive([...files, { path: '/unlisted', type: 'dir', size: 0 }]);
			if (damage === 'hardlink')
				bytes = await archive(files, {
					'data.txt': { type: 'link', size: 0, linkname: 'outside' },
				});
			await use(files, async index => {
				await expect(
					prepareManagedExport(
						index,
						session(bytes),
						index.exportProof(binding, 'full'),
						new AbortController().signal
					)
				).rejects.toThrow();
				expect(index.exportProof(binding, 'full').summary).toBeUndefined();
			});
		});
	it('rejects equal-sized content changes on transfer and never authorizes a different snapshot binding', async () => {
		await use(files, async index => {
			const bytes = await archive();
			const proof = index.exportProof(binding, 'full');
			await prepareManagedExport(index, session(bytes), proof, new AbortController().signal);
			const changed = Buffer.from(bytes);
			const offset = changed.indexOf(body);
			expect(offset).toBeGreaterThan(0);
			changed[offset] ^= 1;
			await expect(
				streamManagedExport(
					index,
					session(changed),
					proof,
					new Writable({
						write(_c, _e, done) {
							done();
						},
					}),
					new AbortController().signal
				)
			).rejects.toMatchObject({ reason: 'archive-content-mismatch' });
			expect(
				index.exportProof({ ...binding, snapshotId: 'c'.repeat(64) }, 'full').summary
			).toBeUndefined();
		});
	});
	it('enforces the separate proof database page cap without expanding the original index cap', async () => {
		await use(files, async index => {
			const proof = index.exportProof(binding, 'full');
			expect(index.proofDb.pragma('max_page_count', { simple: true }) * 4096).toBe(
				MANAGED_EXPORT_LIMITS.maxProofBytes
			);
			expect(index.db.pragma('max_page_count', { simple: true }) * 4096).toBe(
				SNAPSHOT_INDEX_LIMITS.maxBytes
			);
			index.proofDb.pragma('max_page_count=5');
			const bytes = await archive(files, {
				'data.txt': { pax: { 'SCHILY.xattr.user.large': 'x'.repeat(16000) } },
			});
			await expect(
				prepareManagedExport(index, session(bytes), proof, new AbortController().signal)
			).rejects.toMatchObject({ reason: 'export-resource-limit' });
			expect(proof.summary).toBeUndefined();
		});
	});
	it('handles long Unicode PAX paths, literal percent/colon names and long link targets', async () => {
		const directory = '/' + '雪'.repeat(60);
		const nodes = [
			{ path: directory, type: 'dir', size: 0 },
			{ path: directory + '/literal-%2e%2e:file.txt', type: 'file', size: body.length },
			{ path: '/link', type: 'symlink', size: 0 },
		];
		await use(nodes, async index => {
			const bytes = await archive(nodes, {
				'link': { linkname: directory.slice(1) + '/literal-%2e%2e:file.txt' },
				'literal-%2e%2e:file.txt': {
					pax: { 'mtime': '1767225600.123456789', 'SCHILY.xattr.user.fixture': 'unicode metadata' },
				},
			});
			const proof = index.exportProof(binding, 'full');
			await prepareManagedExport(index, session(bytes, 1), proof, new AbortController().signal);
			expect(proof.get('/link').linkTarget).toBe(directory.slice(1) + '/literal-%2e%2e:file.txt');
			expect(JSON.parse(proof.get(directory + '/literal-%2e%2e:file.txt').metadata).pax.mtime).toBe(
				'1767225600.123456789'
			);
		});
	});
	it('supports bounded GNU long-name and long-link extensions through canonical output', async () => {
		const name = 'long-' + '雪'.repeat(50);
		const nodes = [
			{ path: '/' + name, type: 'file', size: body.length },
			{ path: '/link', type: 'symlink', size: 0 },
		];
		const bytes = Buffer.concat([
			rawEntry('gnu-long-path', Buffer.from(name + '\0'), '././@LongLink'),
			rawEntry('file', body, 'placeholder'),
			rawEntry('gnu-long-link-path', Buffer.from(name + '\0'), '././@LongLink'),
			rawEntry('symlink', Buffer.alloc(0), 'link', 'placeholder'),
			Buffer.alloc(1024),
		]);
		await use(nodes, async index => {
			const proof = index.exportProof(binding, 'full');
			const result = await prepareManagedExport(
				index,
				session(bytes, 13),
				proof,
				new AbortController().signal
			);
			expect(result.includedEntries).toBe(2);
			expect(proof.get('/link').linkTarget).toBe(name);
		});
	});
	for (const scenario of [
		'pax-traversal',
		'pax-absolute',
		'pax-sparse',
		'pax-type-override',
		'pax-link-on-file',
		'pax-duplicate',
		'pax-length',
		'pax-global',
		'gnu-unterminated',
		'oversized-extension',
	])
		it(`rejects extension bypass: ${scenario}`, async () => {
			const prefix = (await archive(files.filter(file => file.type === 'dir'))).subarray(0, -1024);
			let type = 'pax-header',
				payload = pax('path', 'srv/example-app/data.txt');
			if (scenario === 'pax-traversal') payload = pax('path', '../escape');
			if (scenario === 'pax-absolute') payload = pax('path', '/absolute');
			if (scenario === 'pax-sparse') payload = pax('GNU.sparse.map', '0,100');
			if (scenario === 'pax-type-override') payload = pax('SCHILY.filetype', 'symlink');
			if (scenario === 'pax-link-on-file') payload = pax('linkpath', '../escape');
			if (scenario === 'pax-duplicate') payload += pax('path', 'elsewhere');
			if (scenario === 'pax-length') payload = '999999 path=bad\n';
			if (scenario === 'pax-global') type = 'pax-global-header';
			if (scenario === 'gnu-unterminated') {
				type = 'gnu-long-path';
				payload = 'unterminated';
			}
			if (scenario === 'oversized-extension') payload = 'x'.repeat(65537);
			const bytes = Buffer.concat([
				prefix,
				rawEntry(type, Buffer.from(payload), 'PaxHeader'),
				rawEntry('file', body),
				Buffer.alloc(1024),
			]);
			await use(files, async index => {
				const proof = index.exportProof(binding, 'full');
				await expect(
					prepareManagedExport(index, session(bytes), proof, new AbortController().signal)
				).rejects.toThrow();
				expect(proof.summary).toBeUndefined();
			});
		});
	it('aborts blocked output and releases duplicate-path cursors so the same immutable proof can be retried', async () => {
		await use(files, async index => {
			const bytes = await archive();
			const proof = index.exportProof(binding, 'full');
			await prepareManagedExport(index, session(bytes), proof, new AbortController().signal);
			let entered!: () => void;
			const blocked = new Promise<void>(resolve => {
				entered = resolve;
			});
			const controller = new AbortController();
			const destination = new Writable({
				highWaterMark: 1,
				write() {
					entered();
				},
			});
			const transferring = streamManagedExport(
				index,
				session(bytes),
				proof,
				destination,
				controller.signal
			);
			void transferring.catch(() => undefined);
			await blocked;
			controller.abort();
			await expect(transferring).rejects.toThrow();
			await expect(
				streamManagedExport(
					index,
					session(bytes),
					proof,
					new Writable({
						write(_c, _e, done) {
							done();
						},
					}),
					new AbortController().signal
				)
			).resolves.toEqual(proof.summary);
		});
	});
	it('preserves zero permissions, wide owners, Unicode owner names and post-2038 timestamps', async () => {
		let bytes = await archive(files, {
			'data.txt': {
				pax: {
					uid: '4294967294',
					gid: '4294967293',
					uname: 'owner-雪',
					gname: 'group-雪',
					mtime: '2208988800.123456789',
				},
			},
		});
		bytes = Buffer.from(bytes);
		let fileOffset = -1;
		for (let offset = 0; offset < bytes.length - 512; offset += 512)
			if (
				bytes.subarray(offset, offset + 9).toString() === 'PaxHeader' &&
				bytes[offset + 156] === 48
			)
				fileOffset = offset;
		expect(fileOffset).toBeGreaterThan(0);
		bytes.write('0000000\0', fileOffset + 100, 'ascii');
		bytes.fill(32, fileOffset + 148, fileOffset + 156);
		const sum = bytes.subarray(fileOffset, fileOffset + 512).reduce((a, b) => a + b, 0);
		bytes.write(sum.toString(8).padStart(6, '0') + '\0 ', fileOffset + 148, 'ascii');
		await use(files, async index => {
			const proof = index.exportProof(binding, 'full');
			await prepareManagedExport(index, session(bytes), proof, new AbortController().signal);
			const chunks: Buffer[] = [];
			await streamManagedExport(
				index,
				session(bytes),
				proof,
				new Writable({
					write(chunk, _enc, done) {
						chunks.push(chunk);
						done();
					},
				}),
				new AbortController().signal
			);
			const extract = tar.extract();
			let captured: any;
			extract.on('entry', (header, body, next) => {
				if (header.type === 'file') captured = header;
				body.on('end', next);
				body.resume();
			});
			await new Promise<void>((resolve, reject) => {
				extract.on('finish', resolve).on('error', reject);
				extract.end(Buffer.concat(chunks));
			});
			expect(captured.mode).toBe(0);
			expect(captured.pax.uid).toBe('4294967294');
			expect(captured.pax.uname).toBe('owner-雪');
			expect(captured.pax.mtime).toBe('2208988800.123456789');
		});
	});
});

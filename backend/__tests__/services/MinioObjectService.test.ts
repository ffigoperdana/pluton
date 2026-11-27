import crypto from 'crypto';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { Writable } from 'stream';
import { AppError } from '../../src/utils/AppError';
import { ManagedSnapshotIndexCache } from '../../src/utils/restic/ManagedSnapshotIndex';
import {
	MINIO_OBJECT_LIMITS,
	MinioObjectService,
	type MinioObjectQuery,
	type MinioSnapshotReader,
} from '../../src/services/MinioObjectService';
import type { ManagedSnapshotFiles } from '../../src/services/RemoteRepositoryRecoveryService';
import type { SelectedDownloadHeaders } from '../../src/utils/restic/SelectedSnapshotDownload';
import { readFixtureArchive, source, type FixtureEntry } from '../utils/minioObjects/fixture';

// Data folders written by a real MinIO server; see backend/__tests__/fixtures/minioObjects.
const DATA = '/srv/example-app/minio';
const ERASURE = '/srv/example-app/minio-erasure';
const SNAPSHOT = 'a'.repeat(64);
const baseEntries = () =>
	new Map<string, FixtureEntry>([
		...readFixtureArchive('xl-single.tar.gz', DATA),
		...readFixtureArchive('erasure-drive1.tar.gz', ERASURE),
	]);
const file = (data: Buffer | string): FixtureEntry => ({
	path: '',
	type: 'file',
	data: Buffer.from(data),
	mtime: new Date('2026-11-20T00:00:00Z'),
});
const dir = (): FixtureEntry => ({
	path: '',
	type: 'dir',
	data: Buffer.alloc(0),
	mtime: new Date('2026-11-20T00:00:00Z'),
});

/** Index, file reads and pattern restores over in-memory snapshot entries, like the recovery service. */
class FixtureSnapshots implements MinioSnapshotReader {
	indexing = 0;
	sessions = 0;
	restores: string[][] = [];
	reads: string[] = [];
	readonly cache: ManagedSnapshotIndexCache;
	constructor(
		readonly entries: Map<string, FixtureEntry>,
		root: string
	) {
		this.cache = new ManagedSnapshotIndexCache(path.join(root, 'indexes'));
	}
	async snapshotIndexStatus() {
		if (this.indexing > 0) {
			this.indexing--;
			return { status: 'indexing' as const, snapshotId: SNAPSHOT, entries: 12, elapsedMs: 5 };
		}
		return { status: 'ready' as const, snapshotId: SNAPSHOT };
	}
	leases = 0;
	private populate = async (append: (node: any) => void) => {
		for (const [name, entry] of [...this.entries.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))
			append({
				struct_type: 'node',
				path: name,
				name: path.posix.basename(name),
				type: entry.type,
				size: entry.type === 'file' ? entry.data.length : 0,
				mtime: entry.mtime.toISOString(),
			});
	};
	private get key() {
		return ManagedSnapshotIndexCache.key({ snapshot: SNAPSHOT, entries: this.entries.size });
	}
	async withSnapshotIndex<T>(
		_backupId: string,
		consume: (index: ManagedSnapshotFiles['index']) => Promise<T> | T
	) {
		this.leases++;
		return this.cache.use(this.key, this.populate, consume);
	}
	async withSnapshotFiles<T>(
		_backupId: string,
		consume: (files: ManagedSnapshotFiles) => Promise<T>
	) {
		this.sessions++;
		return this.cache.use(
			ManagedSnapshotIndexCache.key({ snapshot: SNAPSHOT, entries: this.entries.size }),
			async append => {
				for (const [name, entry] of [...this.entries.entries()].sort(([a], [b]) =>
					a < b ? -1 : 1
				))
					append({
						struct_type: 'node',
						path: name,
						name: path.posix.basename(name),
						type: entry.type,
						size: entry.type === 'file' ? entry.data.length : 0,
						mtime: entry.mtime.toISOString(),
					});
			},
			index =>
				consume({
					snapshotId: SNAPSHOT,
					index,
					readFile: async (itemPath, output) => {
						this.reads.push(itemPath);
						const entry = this.entries.get(itemPath);
						if (!entry || entry.type !== 'file')
							throw new AppError(404, 'Snapshot file not found.');
						for (let offset = 0; offset < entry.data.length || offset === 0; offset += 65536) {
							const chunk = entry.data.subarray(offset, offset + 65536);
							if (!chunk.length) break;
							await new Promise<void>((resolve, reject) =>
								output.write(chunk, error => (error ? reject(error) : resolve()))
							);
						}
					},
					restoreFiles: async (includes, target) => {
						this.restores.push(includes);
						const patterns = includes.map(
							include =>
								new RegExp(
									'^' +
										include
											.split('/**/')
											.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
											.join('/(?:.*/)?') +
										'$'
								)
						);
						let restored = 0;
						for (const [name, entry] of this.entries)
							if (entry.type === 'file' && patterns.some(pattern => pattern.test(name))) {
								const local = path.join(target, ...name.slice(1).split('/'));
								await fsp.mkdir(path.dirname(local), { recursive: true });
								await fsp.writeFile(local, entry.data);
								restored++;
							}
						return { files_restored: restored, bytes_restored: 0 };
					},
				})
		);
	}
}

const collect = () => {
	const chunks: Buffer[] = [];
	return {
		chunks,
		output: new Writable({
			write(chunk: Buffer, _encoding, done) {
				chunks.push(chunk);
				done();
			},
		}),
	};
};

describe('MinioObjectService', () => {
	let root: string;
	let snapshots: FixtureSnapshots;
	let service: MinioObjectService;
	const setup = async (entries = baseEntries(), limits = MINIO_OBJECT_LIMITS) => {
		snapshots = new FixtureSnapshots(entries, root);
		service = new MinioObjectService(snapshots, path.join(root, 'catalogs'), limits);
	};
	const reset = async (entries = baseEntries(), limits = MINIO_OBJECT_LIMITS) => {
		await service.close();
		await snapshots.cache.close();
		await setup(entries, limits);
	};
	beforeEach(async () => {
		root = await fsp.mkdtemp(path.join(os.tmpdir(), 'minio-objects-'));
		await setup();
	});
	afterEach(async () => {
		await service.close();
		await snapshots.cache.close();
		await fsp.rm(root, { recursive: true, force: true });
	});

	const ready = async (query: MinioObjectQuery) => {
		for (let attempt = 0; attempt < 400; attempt++) {
			const page = await service.page('backup-01', query);
			if (page.status === 'ready') return page;
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		throw new Error('catalog did not become ready');
	};
	const download = async (query: MinioObjectQuery, id: number, headOnly = false) => {
		const { chunks, output } = collect();
		let headers: SelectedDownloadHeaders | undefined;
		await service.download(
			'backup-01',
			id,
			query,
			output,
			new AbortController().signal,
			value => (headers = value),
			headOnly
		);
		return { content: Buffer.concat(chunks), headers: headers! };
	};
	const sha256 = (value: Buffer) => crypto.createHash('sha256').update(value).digest('hex');
	const bucket = (name: string, extra: Partial<MinioObjectQuery> = {}): MinioObjectQuery => ({
		dataDir: DATA,
		bucket: name,
		...extra,
	});

	it('finds the MinIO data folders of a snapshot once its index is ready', async () => {
		snapshots.indexing = 1;
		expect(await service.dataDirectories('backup-01')).toMatchObject({
			status: 'indexing',
			entries: 12,
		});
		const result = await service.dataDirectories('backup-01');
		expect(result).toEqual({
			status: 'ready',
			dataDirs: [
				// Snapshot path order: '-' sorts before '/'.
				{
					path: ERASURE,
					format: 'xl',
					drives: 4,
					supported: false,
					bucketsTruncated: false,
					buckets: [
						{
							name: 'erasure-bucket',
							objects: 1,
							metadataBytes: expect.any(Number),
							legacyObjects: 0,
						},
					],
				},
				{
					path: DATA,
					format: 'xl-single',
					drives: 1,
					supported: true,
					bucketsTruncated: false,
					buckets: [
						{
							name: 'example-bucket',
							objects: 11,
							metadataBytes: expect.any(Number),
							legacyObjects: 0,
						},
						{
							name: 'versioned-bucket',
							objects: 3,
							metadataBytes: expect.any(Number),
							legacyObjects: 0,
						},
					],
				},
			],
		});
		await service.dataDirectories('backup-01');
		expect(snapshots.sessions).toBe(1); // cached per snapshot
		expect(snapshots.reads).toEqual([
			`${ERASURE}/.minio.sys/format.json`,
			`${DATA}/.minio.sys/format.json`,
		]);
	});

	it('decides from the index alone that a snapshot holds no MinIO data', async () => {
		const entries = new Map<string, FixtureEntry>([
			['/srv', { ...dir(), path: '/srv' }],
			['/srv/example-app', { ...dir(), path: '/srv/example-app' }],
			['/srv/example-app/format.json', file('{"format":"xl-single"}')],
		]);
		await reset(entries);
		expect(await service.dataDirectories('backup-01')).toEqual({ status: 'ready', dataDirs: [] });
		expect(snapshots.leases).toBe(1);
		expect(snapshots.sessions).toBe(0);
		expect(snapshots.reads).toEqual([]);
	});

	it('lists a bucket like S3 with folders, search and sorting, from restored metadata only', async () => {
		const first = await service.page('backup-01', bucket('example-bucket'));
		expect(first.status).toBe('indexing');
		const page = await ready(bucket('example-bucket'));
		expect(snapshots.restores).toEqual([[`${DATA}/example-bucket/**/xl.meta`]]);
		expect(page.counts).toEqual({
			objects: 11,
			deleted: 0,
			unsupported: 1,
			versions: 11,
			bytes: expect.any(Number),
		});
		expect(page.folders.map(folder => folder.prefix)).toEqual([
			'data/',
			'docs/',
			'dokumen/',
			'exports/',
			'folder/',
			'logs/',
			'secret/',
			'uploads/',
		]);
		expect(page.items.map(item => item.key)).toEqual(['empty.txt', 'hello.txt']);
		expect(page.items[1]).toMatchObject({
			size: 18,
			etag: source('hello.txt').md5,
			contentType: 'text/plain',
			versionId: 'null',
			latest: true,
			inline: true,
			status: 'supported',
			reason: null,
		});

		const logs = await ready(
			bucket('example-bucket', { prefix: 'logs/', sort: 'size', order: 'desc' })
		);
		expect(logs.items.map(item => [item.key, item.size, item.compressed])).toEqual([
			['logs/app.log', source('app.log').size, true],
			['logs/small.log', source('small.log').size, true],
		]);
		const folder = await ready(bucket('example-bucket', { prefix: 'folder/' }));
		expect(folder.items.map(item => [item.key, item.status])).toEqual([['folder/', 'directory']]);
		const secret = await ready(bucket('example-bucket', { prefix: 'secret/' }));
		expect(secret.items[0]).toMatchObject({ status: 'encrypted', size: null, etag: null });
		expect(secret.items[0].reason).toMatch(/server-side encryption/);
		const search = await ready(bucket('example-bucket', { search: 'LAPORAN' }));
		expect(search.folders).toEqual([]);
		expect(search.items.map(item => item.key)).toEqual(['dokumen/laporan akhir é.txt']);
		const paged = await ready(
			bucket('example-bucket', { search: '.', limit: 4, offset: 4, sort: 'key' })
		);
		expect(paged).toMatchObject({ total: 10, offset: 4, limit: 4, nextOffset: 8 });

		// Inline data never stays on disk: only the catalog database remains.
		const catalogs = path.join(root, 'catalogs');
		const [catalog] = await fsp.readdir(catalogs);
		expect(await fsp.readdir(path.join(catalogs, catalog))).toEqual(['catalog.sqlite']);
		expect(snapshots.restores).toHaveLength(1);
	});

	it('lists versions and delete markers of a versioned bucket', async () => {
		const latest = await ready(bucket('versioned-bucket'));
		expect(latest.counts).toMatchObject({ objects: 2, deleted: 1, versions: 7 });
		expect(latest.items.map(item => [item.key, item.deleteMarker, item.versions])).toEqual([
			['kept.bin', false, 2],
			['legacy.txt', false, 2],
			['notes.txt', true, 3],
		]);
		expect(latest.items[2].reason).toMatch(/delete marker/);
		const all = await ready(bucket('versioned-bucket', { versions: 'all' }));
		expect(
			all.items
				.filter(item => item.key === 'notes.txt')
				.map(item => [item.latest, item.deleteMarker, item.size])
		).toEqual([
			[true, true, 0],
			[false, false, source('notes-v2.txt').size],
			[false, false, source('notes-v1.txt').size],
		]);
		expect(all.items.find(item => item.key === 'legacy.txt' && !item.latest)!.versionId).toBe(
			'null'
		);
	});

	it('downloads every supported object version as its original file', async () => {
		const files: Record<string, string> = {
			'hello.txt': 'hello.txt',
			'empty.txt': 'empty.txt',
			'dokumen/laporan akhir é.txt': 'laporan.txt',
			'docs/report.bin': 'report.bin',
			'data/large.bin': 'large.bin',
			'uploads/multipart.bin': 'multipart.bin',
			'logs/app.log': 'app.log',
			'logs/small.log': 'small.log',
			'exports/table.csv': 'table.csv',
		};
		const page = await ready(bucket('example-bucket', { search: '/', limit: 500 }));
		const root = await ready(bucket('example-bucket'));
		for (const item of [...page.items, ...root.items].filter(
			value => value.status === 'supported'
		)) {
			const head = await download(bucket('example-bucket'), item.id, true);
			expect(head.content.length).toBe(0);
			expect(head.headers.length).toBe(item.size);
			const { content, headers } = await download(bucket('example-bucket'), item.id);
			expect(sha256(content)).toBe(source(files[item.key]).sha256);
			expect(headers).toMatchObject({
				contentType: 'application/octet-stream',
				length: source(files[item.key]).size,
			});
		}
		const laporan = page.items.find(item => item.key.startsWith('dokumen/'))!;
		expect((await download(bucket('example-bucket'), laporan.id, true)).headers).toMatchObject({
			fileName: 'laporan akhir _.txt',
			utf8FileName: 'laporan akhir é.txt',
		});

		const versions = await ready(bucket('versioned-bucket', { versions: 'all' }));
		const notes = versions.items.filter(item => item.key === 'notes.txt' && !item.deleteMarker);
		expect(sha256((await download(bucket('versioned-bucket'), notes[1].id)).content)).toBe(
			source('notes-v1.txt').sha256
		);
		const legacy = versions.items.find(
			item => item.key === 'legacy.txt' && item.versionId === 'null'
		)!;
		expect(sha256((await download(bucket('versioned-bucket'), legacy.id)).content)).toBe(
			source('legacy-v1.txt').sha256
		);
	});

	it('refuses versions it cannot read, unknown objects and catalogs that are not ready', async () => {
		await expect(download(bucket('example-bucket'), 1)).rejects.toMatchObject({ statusCode: 409 });
		const secret = await ready(bucket('example-bucket', { prefix: 'secret/' }));
		await expect(download(bucket('example-bucket'), secret.items[0].id)).rejects.toMatchObject({
			statusCode: 409,
			message: expect.stringMatching(/server-side encryption/),
		});
		const folder = await ready(bucket('example-bucket', { prefix: 'folder/' }));
		await expect(download(bucket('example-bucket'), folder.items[0].id)).rejects.toMatchObject({
			statusCode: 409,
		});
		await expect(download(bucket('example-bucket'), 99_999)).rejects.toMatchObject({
			statusCode: 404,
		});
		await expect(download(bucket('example-bucket'), 0)).rejects.toMatchObject({ statusCode: 400 });
		const versioned = await ready(bucket('versioned-bucket'));
		const marker = versioned.items.find(item => item.deleteMarker)!;
		await expect(download(bucket('versioned-bucket'), marker.id)).rejects.toMatchObject({
			statusCode: 409,
		});
	});

	it('refuses erasure-coded deployments, unknown folders and buckets', async () => {
		await expect(
			service.page('backup-01', { dataDir: ERASURE, bucket: 'erasure-bucket' })
		).rejects.toMatchObject({
			statusCode: 409,
			message: expect.stringMatching(/4 drives/),
		});
		await expect(service.page('backup-01', bucket('missing-bucket'))).rejects.toMatchObject({
			statusCode: 404,
		});
		await expect(
			service.page('backup-01', { dataDir: '/srv/other', bucket: 'example-bucket' })
		).rejects.toMatchObject({ statusCode: 404 });
		await expect(service.page('backup-01', bucket('../etc'))).rejects.toMatchObject({
			statusCode: 400,
		});
		expect(snapshots.restores).toEqual([]);
	});

	it('never completes a download whose content does not match the ETag', async () => {
		const page = await ready(bucket('example-bucket', { prefix: 'data/' }));
		const part = [...snapshots.entries.keys()].find(
			name => name.startsWith(`${DATA}/example-bucket/data/large.bin/`) && name.endsWith('/part.1')
		)!;
		const original = snapshots.entries.get(part)!;
		const damaged = Buffer.from(original.data);
		damaged[1_500_000] ^= 0x20;
		snapshots.entries.set(part, { ...original, data: damaged });
		const { chunks, output } = collect();
		await expect(
			service.download(
				'backup-01',
				page.items[0].id,
				bucket('example-bucket'),
				output,
				new AbortController().signal,
				() => undefined
			)
		).rejects.toMatchObject({
			statusCode: 422,
			message: expect.stringMatching(/does not match the object ETag/),
		});
		expect(Buffer.concat(chunks).length).toBeLessThan(source('large.bin').size);
	});

	it('refuses a download when the snapshot metadata differs from the catalog or a part file is incomplete', async () => {
		const page = await ready(bucket('example-bucket'));
		const hello = page.items.find(item => item.key === 'hello.txt')!;
		snapshots.entries.set(
			`${DATA}/example-bucket/hello.txt/xl.meta`,
			snapshots.entries.get(`${DATA}/example-bucket/empty.txt/xl.meta`)!
		);
		await expect(download(bucket('example-bucket'), hello.id)).rejects.toMatchObject({
			statusCode: 409,
		});

		const entries = baseEntries();
		const part = [...entries.keys()].find(
			name => name.includes('/docs/report.bin/') && name.endsWith('/part.1')
		)!;
		entries.set(part, { ...entries.get(part)!, data: entries.get(part)!.data.subarray(0, 1000) });
		await reset(entries);
		const docs = await ready(bucket('example-bucket', { prefix: 'docs/' }));
		await expect(download(bucket('example-bucket'), docs.items[0].id)).rejects.toMatchObject({
			statusCode: 422,
			message: expect.stringMatching(/missing or incomplete/),
		});
	});

	it('labels damaged and pre-2020 metadata instead of failing the bucket', async () => {
		const entries = baseEntries();
		const meta = `${DATA}/example-bucket/hello.txt/xl.meta`;
		const damaged = Buffer.from(entries.get(meta)!.data);
		damaged[40] ^= 0x01;
		entries.set(meta, { ...entries.get(meta)!, data: damaged });
		entries.set(`${DATA}/example-bucket/old`, { ...dir(), path: `${DATA}/example-bucket/old` });
		entries.set(`${DATA}/example-bucket/old/report.pdf`, {
			...dir(),
			path: `${DATA}/example-bucket/old/report.pdf`,
		});
		entries.set(
			`${DATA}/example-bucket/old/report.pdf/xl.json`,
			file('{"version":"1.0.1","format":"xl"}')
		);
		await reset(entries);
		const page = await ready(bucket('example-bucket'));
		expect(page.items.find(item => item.key === 'hello.txt')).toMatchObject({
			status: 'metadata-invalid',
			size: null,
		});
		const old = await ready(bucket('example-bucket', { prefix: 'old/' }));
		expect(old.items).toMatchObject([{ key: 'old/report.pdf', status: 'legacy-format' }]);
		expect(page.counts.unsupported).toBe(3);
	});

	it('enforces the metadata, version and path limits before restoring anything', async () => {
		await reset(baseEntries(), { ...MINIO_OBJECT_LIMITS, metadataBytes: 100 });
		await service.page('backup-01', bucket('example-bucket'));
		await expect(ready(bucket('example-bucket'))).rejects.toMatchObject({ statusCode: 413 });
		expect(snapshots.restores).toEqual([]);

		await reset(baseEntries(), { ...MINIO_OBJECT_LIMITS, maxVersions: 5 });
		await expect(ready(bucket('versioned-bucket'))).rejects.toMatchObject({ statusCode: 413 });

		const entries = baseEntries();
		entries.set(`${DATA}/example-bucket/odd`, { ...dir(), path: '' });
		entries.set(`${DATA}/example-bucket/odd/xl.meta`, { ...dir(), path: '' });
		await reset(entries);
		await expect(ready(bucket('example-bucket'))).rejects.toMatchObject({
			statusCode: 409,
			message: expect.stringMatching(/named xl.meta/),
		});

		const glob = new Map<string, FixtureEntry>();
		for (const [name, entry] of readFixtureArchive('xl-single.tar.gz', '/srv/example-app/minio[1]'))
			glob.set(name, entry);
		await reset(glob);
		await expect(
			ready({ dataDir: '/srv/example-app/minio[1]', bucket: 'example-bucket' })
		).rejects.toMatchObject({
			statusCode: 409,
			message: expect.stringMatching(/characters/),
		});
		expect(snapshots.restores).toEqual([]);
	});

	it('keeps a failed build failed until an explicit retry', async () => {
		await reset(baseEntries(), { ...MINIO_OBJECT_LIMITS, metadataBytes: 100 });
		await expect(ready(bucket('example-bucket'))).rejects.toMatchObject({ statusCode: 413 });
		await expect(service.page('backup-01', bucket('example-bucket'))).rejects.toMatchObject({
			statusCode: 413,
		});
		const retried = await service.page('backup-01', { ...bucket('example-bucket'), retry: true });
		expect(retried.status).toBe('indexing');
	});
});

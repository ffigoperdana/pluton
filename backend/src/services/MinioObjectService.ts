import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Writable } from 'stream';
import Database from 'better-sqlite3';
import { AppError, NotFoundError } from '../utils/AppError';
import { appPaths } from '../utils/AppPaths';
import { planLogger } from '../utils/logger';
import { BRAND_NAME } from '../utils/brand';
import { assertManagedRestorePath, managedSnapshotPath } from '../utils/managedSnapshotPath';
import { resolvePathWithin } from '../utils/legacySnapshotPath';
import { attachmentDownloadNames } from '../utils/attachmentCatalog/odooAttachments';
import type { SelectedDownloadHeaders } from '../utils/restic/SelectedSnapshotDownload';
import type { ManagedSnapshotFiles } from './RemoteRepositoryRecoveryService';
import {
	XlMetaError,
	objectKeyFromPath,
	parseMinioFormat,
	parseXlMeta,
	type MinioFormat,
	type XlVersion,
	type XlVersionStatus,
} from '../utils/minioObjects/xlMeta';
import {
	MinioObjectError,
	partPath,
	storedPartSize,
	streamMinioVersion,
} from '../utils/minioObjects/objectStream';

export const MINIO_OBJECT_LIMITS = Object.freeze({
	dataDirectories: 8,
	buckets: 1000,
	formatBytes: 64 * 1024,
	/** One xl.meta; MinIO itself refuses far smaller files. */
	metadataFileBytes: 64 * 1024 ** 2,
	/** All xl.meta files of one bucket, restored to read them. */
	metadataBytes: 2 * 1024 ** 3,
	diskReserve: 256 * 1024 ** 2,
	maxVersions: 2_000_000,
	maxBytes: 512 * 1024 ** 2,
	maxCatalogs: 3,
	idleMs: 12 * 3_600_000,
	pageSize: 100,
	maxPageSize: 500,
	maxFolders: 1000,
	downloads: 2,
	sourceCache: 32,
	restoreTimeoutMs: 6 * 3_600_000,
});

/** Catalog status of one version: the parser's verdict, or why the file was not read. */
export type MinioCatalogStatus =
	| XlVersionStatus
	| 'directory'
	| 'metadata-invalid'
	| 'metadata-too-large'
	| 'legacy-format';

export type MinioObjectQuery = {
	dataDir: string;
	bucket: string;
	prefix?: string;
	search?: string;
	versions?: 'latest' | 'all';
	sort?: 'key' | 'size' | 'modified';
	order?: 'asc' | 'desc';
	offset?: number;
	limit?: number;
	retry?: boolean;
};

export type MinioBucket = {
	name: string;
	objects: number;
	metadataBytes: number;
	legacyObjects: number;
};
export type MinioDataDirectory = {
	path: string;
	format: MinioFormat['format'];
	drives: number;
	supported: boolean;
	buckets: MinioBucket[];
	bucketsTruncated: boolean;
};

export type MinioSnapshotReader = {
	snapshotIndexStatus(
		backupId: string,
		retry?: boolean
	): Promise<
		| { status: 'indexing'; snapshotId: string; entries: number; elapsedMs: number }
		| { status: 'ready'; snapshotId: string }
	>;
	withSnapshotIndex<T>(
		backupId: string,
		consume: (index: ManagedSnapshotFiles['index']) => Promise<T> | T,
		signal?: AbortSignal
	): Promise<T>;
	withSnapshotFiles<T>(
		backupId: string,
		consume: (files: ManagedSnapshotFiles) => Promise<T>,
		signal: AbortSignal,
		limits?: { restoreTimeoutMs: number; temporaryRoot?: string }
	): Promise<T>;
};

type Phase = 'waiting' | 'metadata-restore' | 'parsing';

type Counts = {
	objects: number;
	deleted: number;
	unsupported: number;
	versions: number;
	bytes: number;
};

type Entry = {
	key: string;
	status: 'building' | 'ready' | 'failed';
	phase: Phase;
	metadataFiles: number;
	metadataBytes: number;
	parsed: number;
	started: number;
	used: number;
	directory?: string;
	db?: Database.Database;
	counts?: Counts;
	error?: AppError;
	controller: AbortController;
};

type Row = {
	id: number;
	key: string;
	objectPath: string;
	versionId: string | null;
	latest: number;
	deleteMarker: number;
	size: number | null;
	modified: number | null;
	etag: string | null;
	contentType: string | null;
	parts: number;
	inline: number;
	compressed: number;
	versions: number;
	status: MinioCatalogStatus;
};

const statusMessages: Partial<Record<MinioCatalogStatus, string>> = {
	'delete-marker': 'This version is a delete marker; it has no content.',
	'directory': 'This is a folder object; it has no content to download.',
	'legacy-version': 'This version uses the MinIO V1 object format, which cannot be read here.',
	'encrypted':
		'This object is encrypted with server-side encryption (SSE) and cannot be read from the backup.',
	'transitioned':
		'The data of this object was moved to a remote storage tier and is not in this backup.',
	'erasure-multi-drive':
		'This object is erasure-coded across several drives. Restore every drive and read it with MinIO.',
	'unknown-layout': 'This object uses a MinIO data layout that cannot be read here.',
	'unknown-compression': 'This object uses an unknown compression format.',
	'etag-unverifiable':
		'The ETag of this object is not an MD5 checksum, so its content cannot be verified.',
	'metadata-invalid': 'The xl.meta file of this object is damaged or uses an unknown format.',
	'metadata-too-large': 'The xl.meta file of this object is too large to read.',
	'legacy-format': 'This object uses the pre-2020 MinIO xl.json format, which cannot be read here.',
};

const objectFailures: Record<MinioObjectError['reason'], [number, string]> = {
	'not-supported': [409, 'This object version cannot be read from the backup.'],
	'inline-missing': [422, 'The xl.meta file of this object lacks its inline data.'],
	'stored-size': [
		422,
		'A part file of this object in the snapshot does not have the size its metadata records.',
	],
	'decoded-size': [422, 'The decoded object does not have the size its metadata records.'],
	'compressed-data': [422, 'The compressed data of this object is damaged.'],
	'etag-mismatch': [
		422,
		'The restored content does not match the object ETag. The download was stopped.',
	],
};

const sha = (value: unknown) =>
	crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isoTime = (value: number | null) => (value === null ? null : new Date(value).toISOString());
const yieldNow = () => new Promise<void>(resolve => setImmediate(resolve));

/** Bucket names as MinIO accepts them (S3 rules, a little wider for legacy buckets). */
const BUCKET = /^[A-Za-z0-9][A-Za-z0-9._-]{1,62}$/;

async function readSmallFile(files: ManagedSnapshotFiles, itemPath: string, limit: number) {
	const item = files.index.get(itemPath);
	if (!item || item.type !== 'file' || item.size > limit) return undefined;
	const chunks: Buffer[] = [];
	await files.readFile(
		itemPath,
		new Writable({
			write(chunk: Buffer, _encoding, done) {
				chunks.push(chunk);
				done();
			},
		})
	);
	return Buffer.concat(chunks);
}

/**
 * Lists and downloads objects of MinIO single-drive data folders inside a
 * Managed Agent snapshot. Read-only: object metadata is restored to a private
 * workspace and deleted once parsed; object content is streamed from the
 * snapshot and verified against its ETag.
 */
export class MinioObjectService {
	private readonly entries = new Map<string, Entry>();
	private readonly sources = new Map<string, { used: number; value: MinioDataDirectory[] }>();
	private building?: string;
	private downloads = 0;
	private initialized?: Promise<void>;

	constructor(
		private readonly snapshots: MinioSnapshotReader,
		private readonly root = path.join(appPaths.getDataDir(), 'minio-catalogs'),
		private readonly limits = MINIO_OBJECT_LIMITS
	) {}

	/** MinIO data folders of a snapshot, or the index progress while it is prepared. */
	async dataDirectories(backupId: string, retry = false, signal = new AbortController().signal) {
		const state = await this.snapshots.snapshotIndexStatus(backupId, retry);
		if (state.status === 'indexing')
			return {
				status: 'indexing' as const,
				retryAfterMs: 2000,
				entries: state.entries,
				elapsedMs: state.elapsedMs,
			};
		return {
			status: 'ready' as const,
			dataDirs: await this.detect(backupId, state.snapshotId, signal),
		};
	}

	async page(backupId: string, query: MinioObjectQuery) {
		const state = await this.snapshots.snapshotIndexStatus(backupId);
		const key = sha([backupId, state.snapshotId, query.dataDir, query.bucket]);
		this.expire();
		let entry = this.entries.get(key);
		// A ready catalog outlives the snapshot index cache; serve it without one.
		if (entry?.status === 'ready' && entry.db) {
			entry.used = Date.now();
			return {
				status: 'ready' as const,
				dataDir: query.dataDir,
				bucket: query.bucket,
				...this.select(entry, query),
			};
		}
		if (state.status === 'indexing')
			return {
				status: 'indexing' as const,
				retryAfterMs: 2000,
				progress: this.progress(undefined, 'snapshot-index', state.entries, state.elapsedMs),
			};
		const bucket = await this.bucket(backupId, state.snapshotId, query);
		if (entry?.status === 'failed' && query.retry) {
			await this.discard(entry);
			entry = undefined;
		}
		if (!entry) entry = this.start(key, backupId, query.dataDir, bucket);
		if (entry.status === 'failed') throw entry.error!;
		if (entry.status === 'building' || !entry.db)
			return { status: 'indexing' as const, retryAfterMs: 2000, progress: this.progress(entry) };
		entry.used = Date.now();
		return {
			status: 'ready' as const,
			dataDir: query.dataDir,
			bucket: query.bucket,
			...this.select(entry, query),
		};
	}

	/** Streams one object version of a ready catalog as its original file. */
	async download(
		backupId: string,
		objectId: number,
		query: Pick<MinioObjectQuery, 'dataDir' | 'bucket'>,
		output: Writable,
		signal: AbortSignal,
		headers: (value: SelectedDownloadHeaders) => void,
		headOnly = false
	) {
		if (!Number.isSafeInteger(objectId) || objectId < 1)
			throw new AppError(400, 'Select one object.');
		const state = await this.snapshots.snapshotIndexStatus(backupId);
		const entry = this.entries.get(sha([backupId, state.snapshotId, query.dataDir, query.bucket]));
		if (entry?.status !== 'ready' || !entry.db)
			throw new AppError(409, 'Open the object list again; its catalog is not ready.');
		entry.used = Date.now();
		const row = entry.db.prepare('SELECT * FROM versions WHERE id=?').get(objectId) as
			| Row
			| undefined;
		if (!row) throw new NotFoundError('Object not found in this catalog.');
		if (row.status !== 'supported')
			throw new AppError(409, statusMessages[row.status] || 'This object cannot be downloaded.');
		const segments = row.key.split('/');
		const names = attachmentDownloadNames(segments[segments.length - 1] || 'object');
		const describe = (length: number) =>
			headers({
				fileName: names.ascii,
				utf8FileName: names.utf8,
				contentType: 'application/octet-stream',
				length,
			});
		if (headOnly) return describe(row.size!);
		if (this.downloads >= this.limits.downloads)
			throw new AppError(429, 'MinIO object downloads are busy. Retry shortly.');
		this.downloads++;
		try {
			await this.snapshots.withSnapshotFiles(
				backupId,
				async files => {
					const metaPath = `${row.objectPath}/xl.meta`;
					const buffer = await readSmallFile(files, metaPath, this.limits.metadataFileBytes);
					if (!buffer)
						throw new AppError(409, 'The object metadata is no longer in this snapshot.');
					const meta = parseXlMeta(buffer);
					const version = meta.versions.find(value => value.versionId === row.versionId);
					if (
						!version ||
						version.status !== 'supported' ||
						version.size !== row.size ||
						version.etag !== row.etag ||
						Number(version.modTimeNs / 1_000_000n) !== row.modified
					)
						throw new AppError(
							409,
							'The object metadata differs from the catalog. Open the object list again.'
						);
					for (const part of version.inline ? [] : version.parts) {
						const file = files.index.get(partPath(row.objectPath, version, part));
						if (!file || file.type !== 'file' || file.size !== storedPartSize(version, part))
							throw new AppError(
								422,
								'A part file of this object is missing or incomplete in the snapshot (it may have been written while the backup ran).'
							);
					}
					signal.throwIfAborted();
					describe(version.size!);
					await streamMinioVersion(
						version,
						meta.inline.get(version.versionId),
						(part, sink) => files.readFile(partPath(row.objectPath, version, part), sink),
						output,
						signal
					);
				},
				signal
			);
		} catch (error) {
			throw this.safeError(error);
		} finally {
			this.downloads--;
		}
	}

	async close() {
		for (const entry of [...this.entries.values()]) {
			entry.controller.abort();
			if (entry.status !== 'building') await this.discard(entry);
		}
	}

	private progress(
		entry?: Entry,
		phase: Phase | 'snapshot-index' = entry?.phase || 'waiting',
		entries = 0,
		elapsedMs?: number
	) {
		return {
			phase,
			metadataFiles: entry?.metadataFiles || 0,
			metadataBytes: entry?.metadataBytes || 0,
			parsed: entry?.parsed || 0,
			indexedEntries: entries,
			elapsedMs: elapsedMs ?? (entry ? Date.now() - entry.started : 0),
		};
	}

	private async detect(backupId: string, snapshotId: string, signal: AbortSignal) {
		const cacheKey = `${backupId}:${snapshotId}`;
		const cached = this.sources.get(cacheKey);
		if (cached) {
			cached.used = Date.now();
			return cached.value;
		}
		// Most snapshots hold no MinIO data: decide from the index alone before
		// opening a session that reads files.
		const candidates = await this.snapshots.withSnapshotIndex(
			backupId,
			index =>
				index
					.filesNamed('format.json', this.limits.dataDirectories * 4)
					.filter(file => path.posix.basename(path.posix.dirname(file.path)) === '.minio.sys')
					.slice(0, this.limits.dataDirectories)
					.map(file => file.path),
			signal
		);
		const value = !candidates.length
			? []
			: await this.snapshots.withSnapshotFiles(
					backupId,
					async files => {
						const found: MinioDataDirectory[] = [];
						const formats = candidates
							.map(candidate => files.index.get(candidate))
							.filter(file => file?.type === 'file');
						for (const file of formats as NonNullable<(typeof formats)[number]>[]) {
							const dataDir = path.posix.dirname(path.posix.dirname(file.path));
							if (dataDir === '/') continue;
							const text = await readSmallFile(files, file.path, this.limits.formatBytes);
							const format = text ? parseMinioFormat(text.toString('utf8')) : parseMinioFormat('');
							const children = files.index.childDirectories(dataDir, this.limits.buckets + 2);
							const buckets = children
								.filter(child => child.name !== '.minio.sys')
								.slice(0, this.limits.buckets)
								.map(child => {
									const metadata = files.index.namedBelow(child.path, 'xl.meta');
									return {
										name: child.name,
										objects: metadata.files,
										metadataBytes: metadata.bytes,
										legacyObjects: files.index.namedBelow(child.path, 'xl.json').files,
									};
								});
							found.push({
								path: dataDir,
								...format,
								buckets,
								bucketsTruncated:
									children.filter(child => child.name !== '.minio.sys').length >
									this.limits.buckets,
							});
						}
						return found;
					},
					signal
				);
		this.sources.set(cacheKey, { used: Date.now(), value });
		while (this.sources.size > this.limits.sourceCache) {
			const oldest = [...this.sources.entries()].sort((a, b) => a[1].used - b[1].used)[0];
			this.sources.delete(oldest[0]);
		}
		return value;
	}

	private async bucket(backupId: string, snapshotId: string, query: MinioObjectQuery) {
		managedSnapshotPath(query.dataDir);
		if (!BUCKET.test(query.bucket))
			throw new AppError(400, 'Select a bucket of the MinIO data folder.');
		const dataDirs = await this.detect(backupId, snapshotId, new AbortController().signal);
		const dataDir = dataDirs.find(value => value.path === query.dataDir);
		if (!dataDir) throw new NotFoundError('No MinIO data folder at this path in the snapshot.');
		if (!dataDir.supported)
			throw new AppError(
				409,
				dataDir.format === 'xl'
					? `This MinIO deployment spreads objects over ${dataDir.drives || 'several'} drives (erasure coding). Restore every drive and read the objects with MinIO.`
					: dataDir.format === 'fs'
						? 'This MinIO data folder uses the FS mode, which stores objects as ordinary files. Browse them in the Files view.'
						: 'The MinIO data folder has an unknown format.'
			);
		const bucket = dataDir.buckets.find(value => value.name === query.bucket);
		if (!bucket) throw new NotFoundError('Bucket not found in this MinIO data folder.');
		return bucket;
	}

	private async initialize() {
		this.initialized ||= (async () => {
			await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
			// Catalogs and restored metadata never survive a restart; remove only our directories.
			for (const name of await fs.readdir(this.root))
				if (/^catalog-[a-f0-9]{24}$/.test(name))
					await fs.rm(path.join(this.root, name), { recursive: true, force: true });
		})().catch(error => {
			this.initialized = undefined;
			throw error;
		});
		return this.initialized;
	}

	private start(key: string, backupId: string, dataDir: string, bucket: MinioBucket): Entry {
		const entry: Entry = {
			key,
			status: 'building',
			phase: 'waiting',
			metadataFiles: bucket.objects,
			metadataBytes: bucket.metadataBytes,
			parsed: 0,
			started: Date.now(),
			used: Date.now(),
			controller: new AbortController(),
		};
		if (this.building) return entry; // one build at a time; a later poll starts this one
		this.entries.set(key, entry);
		this.building = key;
		void this.build(entry, backupId, `${dataDir}/${bucket.name}`)
			.catch(async error => {
				entry.status = 'failed';
				entry.error = this.safeError(error);
				entry.db?.close();
				entry.db = undefined;
				if (entry.directory)
					await fs.rm(entry.directory, { recursive: true, force: true }).catch(() => undefined);
				planLogger('minio-objects').warn(
					{ reason: entry.error.message, status: entry.error.statusCode },
					'MinIO object catalog build failed.'
				);
			})
			.finally(() => {
				if (this.building === key) this.building = undefined;
			});
		return entry;
	}

	private safeError(error: unknown): AppError {
		if (error instanceof AppError) return error;
		if (error instanceof MinioObjectError) {
			const [status, message] = objectFailures[error.reason];
			return new AppError(status, message);
		}
		if (error instanceof XlMetaError) return new AppError(422, statusMessages['metadata-invalid']!);
		if ((error as { code?: string })?.code === 'SQLITE_FULL')
			return new AppError(
				507,
				`The MinIO object catalog reached its size limit or ran out of disk space on the ${BRAND_NAME} server.`
			);
		return new AppError(503, 'The MinIO object list is unavailable. Retry.');
	}

	private async build(entry: Entry, backupId: string, bucketPath: string) {
		await this.initialize();
		await this.makeRoom(entry.key);
		if (/[*?[\]\\]/.test(bucketPath))
			throw new AppError(
				409,
				'The MinIO data folder path holds characters that cannot be used to select its metadata.'
			);
		if (entry.metadataBytes > this.limits.metadataBytes)
			throw new AppError(
				413,
				'The metadata of this bucket is too large to list here. Restore the bucket folder instead.'
			);
		const disk = await fs.statfs(this.root);
		if (disk.bavail * disk.bsize < entry.metadataBytes + this.limits.diskReserve)
			throw new AppError(
				507,
				`Listing this bucket needs more free disk space on the ${BRAND_NAME} server.`
			);
		entry.directory = path.join(this.root, `catalog-${crypto.randomBytes(12).toString('hex')}`);
		const workspace = path.join(entry.directory, 'metadata');
		await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
		const db = new Database(path.join(entry.directory, 'catalog.sqlite'));
		entry.db = db;
		db.pragma('page_size=4096');
		db.pragma(`max_page_count=${Math.floor(this.limits.maxBytes / 4096)}`);
		db.pragma('journal_mode=OFF');
		db.pragma('synchronous=OFF');
		db.pragma('temp_store=FILE');
		db.exec(`CREATE TABLE versions(id INTEGER PRIMARY KEY, key TEXT NOT NULL, objectPath TEXT NOT NULL,
			versionId TEXT, latest INTEGER NOT NULL, deleteMarker INTEGER NOT NULL, size INTEGER, modified INTEGER,
			etag TEXT, contentType TEXT, parts INTEGER NOT NULL, inline INTEGER NOT NULL, compressed INTEGER NOT NULL,
			versions INTEGER NOT NULL, status TEXT NOT NULL); BEGIN;`);
		const insert =
			db.prepare(`INSERT INTO versions(key,objectPath,versionId,latest,deleteMarker,size,modified,etag,
			contentType,parts,inline,compressed,versions,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
		let rows = 0;
		const add = (
			key: string,
			objectPath: string,
			versions: (XlVersion | null)[],
			fallback?: MinioCatalogStatus
		) => {
			versions.forEach((version, index) => {
				if (++rows > this.limits.maxVersions)
					throw new AppError(413, 'This bucket has too many object versions to list here.');
				const status: MinioCatalogStatus =
					fallback ??
					(version!.kind === 'object' && key.endsWith('/') ? 'directory' : version!.status);
				insert.run(
					key,
					objectPath,
					version?.versionId ?? null,
					index === 0 ? 1 : 0,
					version?.kind === 'delete-marker' ? 1 : 0,
					version ? version.size : null,
					version?.modTimeNs ? Number(version.modTimeNs / 1_000_000n) : null,
					version?.etag ?? null,
					version?.contentType ?? null,
					version?.parts.length ?? 0,
					version?.inline ? 1 : 0,
					version?.compression ? 1 : 0,
					versions.length,
					status
				);
			});
		};

		await this.snapshots.withSnapshotFiles(
			backupId,
			async files => {
				const index = files.index;
				const bucket = index.get(bucketPath);
				if (bucket?.type !== 'dir') throw new NotFoundError('Bucket not found in this snapshot.');
				const named = index.namedBelow(bucketPath, 'xl.meta');
				if (named.other)
					throw new AppError(
						409,
						'This bucket holds a folder named xl.meta, so its metadata cannot be selected safely.'
					);
				entry.metadataFiles = named.files;
				entry.metadataBytes = named.bytes;
				if (named.bytes > this.limits.metadataBytes)
					throw new AppError(
						413,
						'The metadata of this bucket is too large to list here. Restore the bucket folder instead.'
					);
				const objectFolder = (file: string) => {
					const folder = path.posix.dirname(file);
					return { folder, key: objectKeyFromPath(folder.slice(bucketPath.length + 1)) };
				};
				if (process.platform === 'win32')
					for (let after: string | undefined; ; ) {
						const page = index.filesNamedBelow(bucketPath, 'xl.meta', after, 2048);
						for (const file of page) assertManagedRestorePath(file.path);
						if (page.length < 2048) break;
						after = page[page.length - 1].path;
					}

				entry.phase = 'metadata-restore';
				// Restic counts restored folders too; every file is checked against the index below.
				if (named.files) await files.restoreFiles([`${bucketPath}/**/xl.meta`], workspace);
				if (entry.controller.signal.aborted)
					throw new AppError(409, 'The MinIO object list was cancelled.');

				entry.phase = 'parsing';
				for (let after: string | undefined; ; ) {
					const page = index.filesNamedBelow(bucketPath, 'xl.meta', after, 512);
					for (const file of page) {
						const { folder, key } = objectFolder(file.path);
						const local = resolvePathWithin(workspace, file.path.slice(1));
						const stat = await fs.lstat(local).catch(() => undefined);
						if (!stat?.isFile() || stat.size !== file.size)
							throw new AppError(
								422,
								'Restoring the object metadata of this bucket was incomplete. Retry.'
							);
						if (file.size > this.limits.metadataFileBytes)
							add(key, folder, [null], 'metadata-too-large');
						else {
							try {
								const meta = parseXlMeta(await fs.readFile(local));
								if (meta.versions.length) add(key, folder, meta.versions);
							} catch (error) {
								if (!(error instanceof XlMetaError)) throw error;
								add(key, folder, [null], 'metadata-invalid');
							}
						}
						// Inline object data lives in xl.meta; never keep it longer than parsing.
						await fs.rm(local, { force: true });
						entry.parsed++;
					}
					if (entry.controller.signal.aborted)
						throw new AppError(409, 'The MinIO object list was cancelled.');
					await yieldNow();
					if (page.length < 512) break;
					after = page[page.length - 1].path;
				}
				for (let after: string | undefined; ; ) {
					const page = index.filesNamedBelow(bucketPath, 'xl.json', after, 512);
					for (const file of page) {
						const { folder, key } = objectFolder(file.path);
						if (!index.get(`${folder}/xl.meta`)) add(key, folder, [null], 'legacy-format');
					}
					if (page.length < 512) break;
					after = page[page.length - 1].path;
				}
			},
			entry.controller.signal,
			{ restoreTimeoutMs: this.limits.restoreTimeoutMs, temporaryRoot: entry.directory }
		);
		await fs.rm(workspace, { recursive: true, force: true });
		db.exec(`COMMIT;
			CREATE INDEX byKey ON versions(latest, key, modified DESC, id);
			CREATE INDEX byAll ON versions(key, modified DESC, id);`);
		const count = (where: string) =>
			(db.prepare(`SELECT count(*) AS n FROM versions WHERE ${where}`).get() as { n: number }).n;
		entry.counts = {
			objects: count('latest=1 AND deleteMarker=0'),
			deleted: count('latest=1 AND deleteMarker=1'),
			unsupported: count(`latest=1 AND status NOT IN ('supported','delete-marker','directory')`),
			versions: count('1'),
			bytes: (
				db
					.prepare(
						"SELECT coalesce(sum(size),0) AS n FROM versions WHERE latest=1 AND status='supported'"
					)
					.get() as { n: number }
			).n,
		};
		entry.status = 'ready';
		entry.used = Date.now();
		planLogger('minio-objects').info(
			{ ...entry.counts, elapsedMs: Date.now() - entry.started },
			'MinIO object catalog ready.'
		);
	}

	private select(entry: Entry, query: MinioObjectQuery) {
		const db = entry.db!;
		const limit = query.limit ?? this.limits.pageSize;
		const offset = query.offset ?? 0;
		const prefix = query.prefix || '';
		const where: string[] = [];
		const params: (string | number)[] = [];
		if (query.versions !== 'all') where.push('latest = 1');
		if (prefix) {
			// Prefixes end with '/', so [prefix, prefix-without-slash + '0') is exactly the subtree.
			where.push('key >= ? AND key < ?');
			params.push(prefix, `${prefix.slice(0, -1)}0`);
		}
		const scope = [...where];
		const scopeParams = [...params];
		let folders: { prefix: string; objects: number }[] = [];
		let foldersTruncated = false;
		if (query.search) {
			where.push('instr(lower(key), lower(?)) > 0');
			params.push(query.search);
		} else {
			const rest = 'substr(key, length(?) + 1)';
			where.push(`instr(${rest}, '/') = 0 OR key = ?`);
			params.push(prefix, prefix);
			const found = db
				.prepare(
					`SELECT substr(r, 1, instr(r, '/')) AS folder, count(DISTINCT key) AS n FROM
					(SELECT key, ${rest} AS r FROM versions ${scope.length ? `WHERE ${scope.join(' AND ')}` : ''})
					WHERE instr(r, '/') > 0 AND r <> '' GROUP BY folder ORDER BY folder LIMIT ?`
				)
				.all(prefix, ...scopeParams, this.limits.maxFolders + 1) as { folder: string; n: number }[];
			foldersTruncated = found.length > this.limits.maxFolders;
			folders = found
				.slice(0, this.limits.maxFolders)
				.map(row => ({ prefix: prefix + row.folder, objects: row.n }));
		}
		const clause = where.length ? `WHERE ${where.map(value => `(${value})`).join(' AND ')}` : '';
		const order = query.order === 'desc' ? 'DESC' : 'ASC';
		const sort =
			query.sort === 'size'
				? `coalesce(size, -1) ${order}, key, modified DESC, id`
				: query.sort === 'modified'
					? `coalesce(modified, 0) ${order}, key, id`
					: `key ${order}, modified DESC, id`;
		const total = (
			db.prepare(`SELECT count(*) AS n FROM versions ${clause}`).get(...params) as { n: number }
		).n;
		const rows = db
			.prepare(`SELECT * FROM versions ${clause} ORDER BY ${sort} LIMIT ? OFFSET ?`)
			.all(...params, limit, offset) as Row[];
		return {
			prefix,
			counts: entry.counts!,
			folders,
			foldersTruncated,
			total,
			offset,
			limit,
			nextOffset: offset + rows.length < total ? offset + rows.length : null,
			items: rows.map(row => ({
				id: row.id,
				key: row.key,
				versionId: row.versionId,
				latest: !!row.latest,
				deleteMarker: !!row.deleteMarker,
				size: row.size,
				modified: isoTime(row.modified),
				etag: row.etag,
				contentType: row.contentType,
				parts: row.parts,
				inline: !!row.inline,
				compressed: !!row.compressed,
				versions: row.versions,
				status: row.status,
				reason: statusMessages[row.status] ?? null,
			})),
		};
	}

	private async makeRoom(keep: string) {
		const others = [...this.entries.values()]
			.filter(entry => entry.key !== keep && entry.status !== 'building')
			.sort((a, b) => a.used - b.used);
		while (others.length && this.entries.size > this.limits.maxCatalogs)
			await this.discard(others.shift()!);
	}

	private expire() {
		const now = Date.now();
		for (const entry of [...this.entries.values()])
			if (entry.status !== 'building' && now - entry.used > this.limits.idleMs)
				void this.discard(entry);
	}

	private async discard(entry: Entry) {
		this.entries.delete(entry.key);
		entry.db?.close();
		entry.db = undefined;
		if (entry.directory)
			await fs.rm(entry.directory, { recursive: true, force: true }).catch(() => undefined);
	}
}

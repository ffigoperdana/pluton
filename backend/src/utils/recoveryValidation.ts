import crypto from 'crypto';
import { constants } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { AppError } from './AppError';
import { isPathWithin, normalizeLegacySnapshotPath, resolvePathWithin } from './legacySnapshotPath';
import type { SnapShotFile } from '../types/restic';
import type { RecoveryCode, RecoveryStage, RecoveryDatabaseResult } from '../types/recoveryTests';
import { z } from 'zod';
import { recoveryEngineSchema } from './recoveryTestPolicy';
import { ManagedSnapshotIndex } from './restic/ManagedSnapshotIndex';

export class RecoveryTestError extends AppError {
	constructor(
		readonly stage: RecoveryStage,
		readonly code: RecoveryCode
	) {
		super(409, `Recovery test failed (${stage}/${code}).`);
		Object.setPrototypeOf(this, new.target.prototype);
	}
}
export function checkRecoveryCancellation(signal: AbortSignal) {
	if (signal.aborted) throw new RecoveryTestError('job', 'cancelled');
}

export async function validateRestoredFiles(
	files: SnapShotFile[] | ManagedSnapshotIndex,
	target: string,
	signal: AbortSignal
) {
	const realTarget = await fs.realpath(target);
	const indexed = files instanceof ManagedSnapshotIndex;
	const expected = indexed ? files : new Map(files.map(file => [file.path, file]));
	const get = (relative: string) => expected.get(`/${relative}`);
	const hasChildren = (relative: string) =>
		indexed
			? files.hasDescendant(`/${relative}`)
			: files.some(file => file.path.startsWith(`/${relative}/`));
	const expectedFiles = indexed
		? files.stats.total_files
		: files.filter(file => file.type === 'file').length;
	const expectedDirectories = indexed
		? files.count - expectedFiles
		: files.filter(file => file.type === 'dir').length;
	let count = 0,
		bytes = 0;
	let directories = 0;
	const walk = async (directory: string): Promise<void> => {
		checkRecoveryCancellation(signal);
		for await (const entry of await fs.opendir(directory)) {
			checkRecoveryCancellation(signal);
			const candidate = path.join(directory, entry.name);
			const relative = path.relative(target, candidate).split(path.sep).join('/');
			const stat = await fs.lstat(candidate);
			if (
				stat.isSymbolicLink() ||
				(!stat.isDirectory() && !stat.isFile()) ||
				!isPathWithin(realTarget, await fs.realpath(candidate))
			)
				throw new RecoveryTestError('filesystem-validation', 'unsupported-snapshot-file');
			if (stat.isDirectory()) {
				// Ancestors may be implicit in a granular selection. Files never may.
				if (!get(relative) && !hasChildren(relative))
					throw new RecoveryTestError('filesystem-validation', 'restored-file-count-mismatch');
				if (get(relative)?.type === 'file')
					throw new RecoveryTestError('filesystem-validation', 'restored-file-count-mismatch');
				if (get(relative)?.type === 'dir') directories++;
				await walk(candidate);
			} else {
				const file = get(relative);
				if (!file || file.type !== 'file')
					throw new RecoveryTestError('filesystem-validation', 'restored-file-count-mismatch');
				if (file.size !== stat.size)
					throw new RecoveryTestError('filesystem-validation', 'restored-file-size-mismatch');
				count++;
				bytes += stat.size;
			}
		}
	};
	await walk(target);
	if (count !== expectedFiles)
		throw new RecoveryTestError('filesystem-validation', 'restored-file-count-mismatch');
	if (directories !== expectedDirectories)
		throw new RecoveryTestError('filesystem-validation', 'restored-file-count-mismatch');
	return { files: count, bytes };
}

const artifactSchema = z.object({
	databaseId: z.string().regex(/^db_[A-Za-z0-9_-]{1,80}$/),
	engine: recoveryEngineSchema,
	database: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/),
	path: z.string().regex(/^\/pluton\/database\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,95}\.sql$/),
	bytes: z
		.number()
		.int()
		.positive()
		.max(100 * 1024 ** 3),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const historicalArtifactSchema = artifactSchema.extend({
	databaseId: artifactSchema.shape.databaseId.optional(),
	engine: artifactSchema.shape.engine.optional(),
	database: artifactSchema.shape.database.optional(),
});
export function recoveryArtifacts(lifecycle: unknown): RecoveryDatabaseResult[] {
	if (lifecycle === undefined || lifecycle === null) return [];
	const value = lifecycle as { databases?: unknown; database?: unknown };
	const multi = value.databases !== undefined;
	const parsed = multi
		? z.array(artifactSchema).max(8).safeParse(value.databases)
		: value.database !== undefined
			? z.array(historicalArtifactSchema).safeParse([value.database])
			: { success: true as const, data: [] };
	if (!parsed.success)
		throw new RecoveryTestError('database-artifact-validation', 'database-metadata-incomplete');
	const paths = new Set<string>(),
		ids = new Set<string>();
	return parsed.data.map(entry => {
		normalizeLegacySnapshotPath(entry.path.slice(1), false);
		const id =
			'databaseId' in entry && typeof entry.databaseId === 'string' ? entry.databaseId : undefined;
		if (paths.has(entry.path) || (id && ids.has(id)))
			throw new RecoveryTestError('database-artifact-validation', 'database-metadata-incomplete');
		paths.add(entry.path);
		if (id) ids.add(id);
		return {
			...entry,
			artifactValidation: 'pending',
			importValidation: 'pending',
		} as RecoveryDatabaseResult;
	});
}
export async function validateRecoveryArtifact(
	entry: RecoveryDatabaseResult,
	target: string,
	signal: AbortSignal
) {
	const candidate = resolvePathWithin(
		target,
		normalizeLegacySnapshotPath(entry.path.slice(1), false)
	);
	let handle: fs.FileHandle | undefined;
	try {
		checkRecoveryCancellation(signal);
		const stat = await fs.lstat(candidate);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			!isPathWithin(await fs.realpath(target), await fs.realpath(candidate))
		)
			throw new RecoveryTestError('database-artifact-validation', 'database-artifact-missing');
		if (stat.size !== entry.bytes)
			throw new RecoveryTestError(
				'database-artifact-validation',
				'database-artifact-size-mismatch'
			);
		await fs.chmod(candidate, 0o600);
		handle = await fs.open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
		const hash = crypto.createHash('sha256');
		for await (const chunk of handle.createReadStream({ autoClose: false })) {
			checkRecoveryCancellation(signal);
			hash.update(chunk);
		}
		if (hash.digest('hex') !== entry.sha256)
			throw new RecoveryTestError(
				'database-artifact-validation',
				'database-artifact-hash-mismatch'
			);
		entry.artifactValidation = 'passed';
		return candidate;
	} catch (error) {
		entry.artifactValidation = 'failed';
		entry.failureCode =
			error instanceof RecoveryTestError ? error.code : 'database-artifact-missing';
		throw error instanceof RecoveryTestError
			? error
			: new RecoveryTestError('database-artifact-validation', 'database-artifact-missing');
	} finally {
		await handle?.close();
	}
}

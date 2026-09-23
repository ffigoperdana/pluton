import { spawn } from 'child_process';
import { z } from 'zod';
import { getBinaryPath } from '../binaryPathResolver';
import type { LegacyRepositorySnapshot, LegacyRepositoryStats } from '../../types/legacyRepositories';

const INSPECTION_TIMEOUT_MS = 30_000;
const MAX_INSPECTION_OUTPUT_BYTES = 8 * 1024 * 1024;
const ALLOWED_INSPECTION_OPERATIONS = new Set(['snapshots', 'stats']);

export type LegacyRepositoryInspectionOperation = 'snapshots' | 'stats';

export type LegacyRepositoryInspectionFailure =
	| 'forbidden-operation'
	| 'wrong-password'
	| 'repository-unavailable'
	| 'timeout'
	| 'invalid-output'
	| 'output-limit'
	| 'execution-failed';

/**
 * Deliberately contains no subprocess output. Restic and transport errors can
 * contain repository locations or backend details and are unsafe to return or log.
 */
export class LegacyRepositoryInspectionError extends Error {
	constructor(public readonly kind: LegacyRepositoryInspectionFailure) {
		super('Legacy repository inspection failed.');
		Object.setPrototypeOf(this, LegacyRepositoryInspectionError.prototype);
	}
}

export interface LegacyResticInspectionClient {
	listSnapshots(repositoryPath: string, password: string): Promise<LegacyRepositorySnapshot[]>;
	getRepositoryStats(repositoryPath: string, password: string): Promise<LegacyRepositoryStats>;
}

const snapshotSchema = z.object({
	id: z.string().regex(/^[a-fA-F0-9]{64}$/),
	time: z.string().min(1),
	hostname: z.string().default(''),
	tags: z.array(z.string()).default([]),
	paths: z.array(z.string()).default([]),
	parent: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
	short_id: z.string().optional(),
});

const snapshotsSchema = z.array(snapshotSchema);

const statsSchema = z.object({
	total_size: z.number().nonnegative(),
	total_uncompressed_size: z.number().nonnegative().default(0),
	compression_ratio: z.number().nonnegative().default(0),
	total_blob_count: z.number().int().nonnegative().default(0),
	snapshots_count: z.number().int().nonnegative().default(0),
});

/**
 * Purpose-built Restic command runner for imported repositories.
 *
 * It cannot receive arbitrary Restic arguments, always uses `--no-lock` and
 * never forwards command stderr into application logs or API errors.
 */
export class ResticLegacyRepositoryInspector implements LegacyResticInspectionClient {
	async listSnapshots(repositoryPath: string, password: string): Promise<LegacyRepositorySnapshot[]> {
		const output = await this.execute('snapshots', repositoryPath, password);
		let parsed: unknown;
		try {
			parsed = JSON.parse(output);
		} catch {
			throw new LegacyRepositoryInspectionError('invalid-output');
		}

		const validation = snapshotsSchema.safeParse(parsed);
		if (!validation.success) {
			throw new LegacyRepositoryInspectionError('invalid-output');
		}

		return validation.data
			.map(snapshot => ({
				id: snapshot.id,
				shortId: snapshot.short_id || snapshot.id.slice(0, 8),
				time: snapshot.time,
				hostname: snapshot.hostname,
				tags: snapshot.tags,
				paths: snapshot.paths,
				parent: snapshot.parent,
			}))
			.sort((left, right) => Date.parse(right.time) - Date.parse(left.time));
	}

	async getRepositoryStats(repositoryPath: string, password: string): Promise<LegacyRepositoryStats> {
		const output = await this.execute('stats', repositoryPath, password);
		let parsed: unknown;
		try {
			parsed = JSON.parse(output);
		} catch {
			throw new LegacyRepositoryInspectionError('invalid-output');
		}

		const validation = statsSchema.safeParse(parsed);
		if (!validation.success) {
			throw new LegacyRepositoryInspectionError('invalid-output');
		}

		return {
			totalSize: validation.data.total_size,
			totalUncompressedSize: validation.data.total_uncompressed_size,
			compressionRatio: validation.data.compression_ratio,
			totalBlobCount: validation.data.total_blob_count,
			snapshotCount: validation.data.snapshots_count,
		};
	}

	async execute(
		operation: string,
		repositoryPath: string,
		password: string,
		timeoutMs: number = INSPECTION_TIMEOUT_MS
	): Promise<string> {
		if (!ALLOWED_INSPECTION_OPERATIONS.has(operation)) {
			throw new LegacyRepositoryInspectionError('forbidden-operation');
		}

		const operationArgs = operation === 'stats' ? ['stats', '--mode', 'raw-data'] : ['snapshots'];
		const args = [
			'--no-lock',
			'--no-cache',
			'--json',
			'--repo',
			repositoryPath,
			...operationArgs,
		];
		const environment = { ...process.env };
		delete environment.RESTIC_REPOSITORY;
		delete environment.RESTIC_REPOSITORY_FILE;
		delete environment.RESTIC_PASSWORD_COMMAND;
		delete environment.RESTIC_PASSWORD_FILE;
		environment.RESTIC_PASSWORD = password;

		return await new Promise<string>((resolve, reject) => {
			let settled = false;
			let output = '';
			let outputBytes = 0;
			const timeout = { value: undefined as NodeJS.Timeout | undefined };
			const settle = (callback: () => void) => {
				if (settled) return;
				settled = true;
				if (timeout.value) clearTimeout(timeout.value);
				callback();
			};

			const child = spawn(getBinaryPath('restic'), args, {
				env: environment,
				shell: false,
				windowsHide: true,
				stdio: ['ignore', 'pipe', 'pipe'],
			});

			timeout.value = setTimeout(() => {
				try {
					child.kill('SIGKILL');
				} catch {
					// The child may already have exited.
				}
				settle(() => reject(new LegacyRepositoryInspectionError('timeout')));
			}, timeoutMs);

			child.on('error', () => {
				settle(() => reject(new LegacyRepositoryInspectionError('execution-failed')));
			});

			child.stdout?.on('data', (chunk: Buffer) => {
				if (settled) return;
				outputBytes += chunk.length;
				if (outputBytes > MAX_INSPECTION_OUTPUT_BYTES) {
					try {
						child.kill('SIGKILL');
					} catch {
						// The child may already have exited.
					}
					settle(() => reject(new LegacyRepositoryInspectionError('output-limit')));
					return;
				}
				output += chunk.toString();
			});

			// Consume stderr so it cannot back up the process pipe, but never retain,
			// log, or return it: it can include repository/backend details.
			child.stderr?.on('data', () => undefined);

			child.on('close', code => {
				if (settled) return;
				if (code === 0) {
					settle(() => resolve(output));
					return;
				}
				if (code === 12) {
					settle(() => reject(new LegacyRepositoryInspectionError('wrong-password')));
					return;
				}
				if (code === 10) {
					settle(() => reject(new LegacyRepositoryInspectionError('repository-unavailable')));
					return;
				}
				settle(() => reject(new LegacyRepositoryInspectionError('execution-failed')));
			});
		});
	}
}

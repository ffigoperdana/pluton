import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { z } from 'zod';
import type { SnapshotDiffRecord } from './SnapshotComparison';
import { AppError } from '../AppError';
import { getBinaryPath } from '../binaryPathResolver';
import { killProcessTree } from '../processTree';
import { processManager } from '../../managers/ProcessManager';
import { planLogger } from '../logger';

export type RecoveryFailureCode =
	| 'configuration-invalid'
	| 'credentials-unavailable'
	| 'repository-unavailable'
	| 'wrong-password'
	| 'execution-failed'
	| 'invalid-output'
	| 'output-limit'
	| 'timeout'
	| 'cancelled'
	| 'repository-busy'
	| 'archive-failed'
	| 'stream-interrupted'
	| 'cleanup-failed';

/** Only closed error categories cross the process/credential boundary. */
export class ManagedRepositoryAccessError extends AppError {
	constructor(
		public readonly code: RecoveryFailureCode,
		readonly reason?:
			| 'repository-output-invalid'
			| 'metadata-schema-invalid'
			| 'invalid-size'
			| 'invalid-timestamp'
	) {
		super(code === 'repository-busy' ? 429 : 502, `Managed repository access failed (${code}).`);
		// AppError sets its own prototype; retain this closed-category subclass.
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export const fullSnapshotId = z.string().regex(/^[a-f0-9]{64}$/);
const snapshotSchema = z.object({
	id: fullSnapshotId,
	tags: z.array(z.string()),
	paths: z.array(z.string()),
});
const nodeSchema = z.object({
	struct_type: z.literal('node'),
	name: z.string().max(1024),
	path: z.string().max(1025),
	type: z.enum(['file', 'dir', 'symlink', 'dev', 'chardev', 'fifo', 'socket']),
	size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().default(0),
	mtime: z
		.string()
		.max(64)
		.refine(value => Number.isFinite(Date.parse(value))),
	mode: z.number().int().nonnegative().optional(),
});
export type ManagedSnapshot = z.infer<typeof snapshotSchema>;
export type ManagedSnapshotNode = z.infer<typeof nodeSchema>;
export type ManagedRestoreSummary = { files_restored: number; bytes_restored: number };

export interface ManagedRepositorySession {
	diff?(
		previous: string,
		current: string,
		consume: (record: SnapshotDiffRecord) => void
	): Promise<void>;
	snapshot(id: string): Promise<ManagedSnapshot>;
	/** Bounded compatibility helper. Production consumers use streamFiles. */
	files(id: string): Promise<ManagedSnapshotNode[]>;
	streamFiles(
		id: string,
		consume: (node: ManagedSnapshotNode) => void | Promise<void>
	): Promise<void>;
	restore(id: string, selectedFiles: string[], stagingPath: string): Promise<ManagedRestoreSummary>;
	/** Full snapshot TAR only; no client-controlled path, format or command. */
	archive(id: string, destination: Writable): Promise<void>;
}

export type ManagedSftpAccess = {
	options: Record<string, string>;
	repositoryPath: string;
	password: string;
};
export interface ManagedRepositorySessionProvider {
	withSession<T>(
		access: ManagedSftpAccess,
		consume: (session: ManagedRepositorySession) => Promise<T>,
		signal?: AbortSignal,
		limits?: { restoreTimeoutMs: number; temporaryRoot?: string; cleanupWarning?: () => void }
	): Promise<T>;
}

function safeEnvironment(): NodeJS.ProcessEnv {
	// Do not inherit RESTIC_*, RCLONE_*, password commands, provider overrides,
	// application secrets or arbitrary SSH options from the server environment.
	const environment: NodeJS.ProcessEnv = {};
	for (const key of ['PATH', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR']) {
		if (process.env[key]) environment[key] = process.env[key];
	}
	return environment;
}

function hasControlCharacters(value: string): boolean {
	return [...value].some(
		character => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f
	);
}

/**
 * A scoped, allowlisted repository session, not the managed lifecycle executor.
 * No init/backup/forget/prune/unlock operation can be requested through it.
 * Credentials exist only for the callback lifetime and never in argv/output.
 */
export class ManagedSftpRepositorySession implements ManagedRepositorySessionProvider {
	private static active = 0;
	/** Bound Restic/Rclone memory as well as index construction concurrency. */
	async withSession<T>(
		access: ManagedSftpAccess,
		consume: (session: ManagedRepositorySession) => Promise<T>,
		signal?: AbortSignal,
		limits?: { restoreTimeoutMs: number; temporaryRoot?: string; cleanupWarning?: () => void }
	): Promise<T> {
		if (signal?.aborted) throw new ManagedRepositoryAccessError('cancelled');
		if (ManagedSftpRepositorySession.active >= 2)
			throw new ManagedRepositoryAccessError('repository-busy');
		ManagedSftpRepositorySession.active++;
		try {
			return await this.scopedSession(access, consume, signal, limits);
		} finally {
			ManagedSftpRepositorySession.active--;
		}
	}
	private async scopedSession<T>(
		access: ManagedSftpAccess,
		consume: (session: ManagedRepositorySession) => Promise<T>,
		signal?: AbortSignal,
		limits?: { restoreTimeoutMs: number; temporaryRoot?: string; cleanupWarning?: () => void }
	): Promise<T> {
		const keys = Object.keys(access.options);
		if (
			keys.some(key => !['host', 'port', 'user', 'pass'].includes(key)) ||
			!access.options.host ||
			!access.options.user ||
			!access.options.pass ||
			!access.password ||
			Object.values(access.options).some(
				value => typeof value !== 'string' || hasControlCharacters(value)
			) ||
			!access.repositoryPath ||
			access.repositoryPath.includes('\\') ||
			hasControlCharacters(access.repositoryPath) ||
			access.repositoryPath.split('/').includes('..')
		)
			throw new ManagedRepositoryAccessError('configuration-invalid');
		const restic = getBinaryPath('restic');
		const rclone = getBinaryPath('rclone');
		// Never silently fall back to an unpinned executable in PATH.
		if (!path.isAbsolute(restic) || !path.isAbsolute(rclone)) {
			throw new ManagedRepositoryAccessError('execution-failed');
		}
		const environment = safeEnvironment();
		let directory: string | undefined;
		try {
			const obscured = (
				await this.run(rclone, ['obscure', '-'], environment, signal, `${access.options.pass}\n`)
			).trim();
			if (!obscured || !/^[A-Za-z0-9_-]+$/.test(obscured)) {
				throw new ManagedRepositoryAccessError('credentials-unavailable');
			}
			directory = await fs.mkdtemp(
				path.join(limits?.temporaryRoot || os.tmpdir(), 'pluton-recovery-')
			);
			await fs.chmod(directory, 0o700);
			const configPath = path.join(directory, 'rclone.conf');
			const options = { ...access.options, pass: obscured };
			await fs.writeFile(
				configPath,
				`[pluton]\ntype = sftp\n${Object.entries(options)
					.map(([key, value]) => `${key} = ${value}`)
					.join('\n')}\n`,
				{ flag: 'wx', mode: 0o600 }
			);
			await fs.chmod(configPath, 0o600);
			const resticEnvironment = {
				...environment,
				RCLONE_CONFIG: configPath,
				RESTIC_PASSWORD: access.password,
			};
			const prefix = [
				'--no-lock',
				'--no-cache',
				'--json',
				'--repo',
				`rclone:pluton:${access.repositoryPath}`,
				'-o',
				`rclone.program=${rclone}`,
			];
			const execute = (args: string[], restore = false) =>
				this.run(
					restic,
					[...prefix, ...args],
					resticEnvironment,
					signal,
					undefined,
					restore,
					limits?.restoreTimeoutMs
				);
			const checkId = (id: string) => {
				if (!fullSnapshotId.safeParse(id).success)
					throw new ManagedRepositoryAccessError('configuration-invalid');
			};
			const streamFiles: ManagedRepositorySession['streamFiles'] = async (id, onNode) => {
				checkId(id);
				let header = false;
				await this.streamMetadata(
					restic,
					[...prefix, 'ls', id, '--long'],
					resticEnvironment,
					async line => {
						const record = this.parse(z.record(z.string(), z.unknown()), line);
						if (record.message_type !== undefined && record.message_type !== record.struct_type)
							throw new ManagedRepositoryAccessError('invalid-output');
						if (record.struct_type === 'snapshot' && !header) {
							const snapshot = this.parse(snapshotSchema, line);
							if (snapshot.id !== id) throw new ManagedRepositoryAccessError('invalid-output');
							header = true;
						} else if (record.struct_type === 'node' && header) {
							if (record.type === 'file' && record.size === undefined)
								throw new ManagedRepositoryAccessError('invalid-output', 'invalid-size');
							const parsed = nodeSchema.safeParse(record);
							if (!parsed.success) {
								const field = parsed.error.issues[0]?.path[0];
								throw new ManagedRepositoryAccessError(
									'invalid-output',
									field === 'size'
										? 'invalid-size'
										: field === 'mtime'
											? 'invalid-timestamp'
											: 'metadata-schema-invalid'
								);
							}
							await onNode(parsed.data);
						} else throw new ManagedRepositoryAccessError('invalid-output');
					},
					signal
				);
				if (!header) throw new ManagedRepositoryAccessError('invalid-output');
			};
			return await consume({
				streamFiles,
				diff: async (previous, current, onRecord) => {
					checkId(previous);
					checkId(current);
					await this.streamMetadata(
						restic,
						[...prefix, 'diff', '--metadata', previous, current],
						resticEnvironment,
						async line => {
							const record = this.parse(
								z.discriminatedUnion('message_type', [
									z.object({
										message_type: z.literal('change'),
										path: z.string().max(1025),
										modifier: z.string().min(1).max(8),
									}),
									z.object({
										message_type: z.literal('statistics'),
										source_snapshot: fullSnapshotId,
										target_snapshot: fullSnapshotId,
									}),
								]),
								line
							);
							onRecord(record);
						},
						signal
					);
				},
				archive: async (id, destination) => {
					checkId(id);
					await this.streamArchive(
						restic,
						[
							...prefix.filter(argument => argument !== '--json'),
							'dump',
							'--archive',
							'tar',
							id,
							'/',
						],
						resticEnvironment,
						destination,
						signal
					);
				},
				snapshot: async id => {
					checkId(id);
					const snapshots = this.parse(z.array(snapshotSchema), await execute(['snapshots', id]));
					if (snapshots.length !== 1 || snapshots[0].id !== id)
						throw new AppError(404, 'The exact backup snapshot is unavailable.');
					return snapshots[0];
				},
				files: async id => {
					const nodes: ManagedSnapshotNode[] = [];
					await streamFiles(id, node => {
						if (nodes.length >= 5000) throw new ManagedRepositoryAccessError('output-limit');
						nodes.push(node);
					});
					return nodes;
				},
				restore: async (id, selectedFiles, stagingPath) => {
					checkId(id);
					const output = await execute(
						[
							'restore',
							id,
							'--target',
							stagingPath,
							'--overwrite',
							'never',
							...selectedFiles.flatMap(file => ['--include', file]),
						],
						true
					);
					const summary = output
						.split(/\r?\n/)
						.filter(Boolean)
						.map(line => this.parse(z.record(z.string(), z.unknown()), line))
						.find(record => record.message_type === 'summary');
					const parsed = z
						.object({
							files_restored: z.number().int().nonnegative(),
							bytes_restored: z.number().nonnegative(),
						})
						.safeParse(summary);
					if (!parsed.success) throw new ManagedRepositoryAccessError('invalid-output');
					return parsed.data;
				},
			});
		} catch (error) {
			if (error instanceof AppError) throw error;
			throw new ManagedRepositoryAccessError('credentials-unavailable');
		} finally {
			if (directory) {
				// Phase 6 owns this session directory durably; preserve completed
				// validation and retry cleanup of its exact workspace after restart.
				if (limits?.cleanupWarning) {
					try {
						await this.cleanup(directory);
					} catch {
						limits.cleanupWarning();
					}
				} else await this.cleanup(directory);
			}
		}
	}

	private async cleanup(directory: string) {
		try {
			await fs.rm(directory, { recursive: true, force: true });
		} catch {
			throw new ManagedRepositoryAccessError('cleanup-failed');
		}
	}

	private parse<T>(schema: z.ZodType<T>, output: string): T {
		try {
			return schema.parse(JSON.parse(output));
		} catch {
			throw new ManagedRepositoryAccessError('invalid-output', 'repository-output-invalid');
		}
	}

	private async streamMetadata(
		binary: string,
		args: string[],
		env: NodeJS.ProcessEnv,
		consume: (line: string) => Promise<void>,
		signal?: AbortSignal
	) {
		if (signal?.aborted) throw new ManagedRepositoryAccessError('cancelled');
		const child = spawn(binary, args, {
			env,
			shell: false,
			windowsHide: true,
			detached: process.platform !== 'win32',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const processId = `managed-metadata-${crypto.randomUUID()}`;
		processManager.trackProcess(processId, child);
		let failure: unknown;
		let hasClosed = false;
		const stop = (error: unknown) => {
			failure ||= error;
			if (!hasClosed) killProcessTree(child, 'SIGKILL');
		};
		const abort = () => stop(new ManagedRepositoryAccessError('cancelled'));
		const closed = new Promise<void>(resolve => {
			child.once('close', code => {
				hasClosed = true;
				if (code !== 0)
					failure ||= new ManagedRepositoryAccessError(
						code === 12
							? 'wrong-password'
							: code === 10
								? 'repository-unavailable'
								: 'execution-failed'
					);
				resolve();
			});
		});
		child.on('error', () => stop(new ManagedRepositoryAccessError('execution-failed')));
		child.stderr?.on('data', () => undefined);
		signal?.addEventListener('abort', abort, { once: true });
		const timer = setTimeout(() => stop(new ManagedRepositoryAccessError('timeout')), 15 * 60_000);
		timer.unref();
		try {
			if (!child.stdout) throw new ManagedRepositoryAccessError('execution-failed');
			await consumeMetadataLines(child.stdout, async line => {
				if (failure) throw failure;
				await consume(line);
			});
			await closed;
			if (failure) throw failure;
		} catch (error) {
			stop(error);
			await closed;
			throw failure instanceof AppError
				? failure
				: new ManagedRepositoryAccessError('invalid-output');
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener('abort', abort);
			if (process.platform !== 'win32' && child.pid) {
				try {
					process.kill(-child.pid, 'SIGKILL');
				} catch {
					/* Already stopped. */
				}
			}
			processManager.untrackProcess(processId);
		}
	}

	private async streamArchive(
		binary: string,
		args: string[],
		env: NodeJS.ProcessEnv,
		destination: Writable,
		signal?: AbortSignal
	): Promise<void> {
		if (signal?.aborted || destination.destroyed)
			throw new ManagedRepositoryAccessError('cancelled');
		const child = spawn(binary, args, {
			env,
			shell: false,
			windowsHide: true,
			detached: process.platform !== 'win32',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const processId = `managed-download-${crypto.randomUUID()}`;
		const began = Date.now();
		let exitStatus: number | null = null,
			exitSignal: string | null = null;
		processManager.trackProcess(processId, child);
		let failure: RecoveryFailureCode | undefined;
		let hasClosed = false;
		let pipelineFinished = false;
		let receivedData = false;
		const transfer = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		const stop = (reason: RecoveryFailureCode) => {
			failure ||= reason;
			if (!hasClosed) killProcessTree(child, 'SIGKILL');
			// Also interrupt a blocked destination after Restic's stdout has ended.
			// Destroying only stdout cannot release that backpressure wait.
			if (!pipelineFinished) {
				transfer.abort();
				// pipeline(end:false) deliberately leaves the consumer open.
				// A failed/aborted TAR cannot be resumed or completed safely.
				destination.destroy();
			}
		};
		const abort = () => stop('cancelled');
		// Inactivity bound, not a tiny archive size or total-transfer-time limit.
		const activity = () => {
			clearTimeout(timer);
			timer = setTimeout(() => stop('timeout'), receivedData ? 10 * 60_000 : 15_000);
			timer.unref();
		};
		const closed = new Promise<void>(resolve => {
			child.once('close', (code, childSignal) => {
				exitStatus = code;
				exitSignal = childSignal;
				hasClosed = true;
				if (code !== 0)
					failure ||=
						code === 12
							? 'wrong-password'
							: code === 10
								? 'repository-unavailable'
								: 'archive-failed';
				resolve();
			});
		});
		child.on('error', () => {
			failure ||= 'execution-failed';
		});
		child.stderr?.on('data', () => undefined); // never retain provider diagnostics
		signal?.addEventListener('abort', abort, { once: true });
		const dataActivity = () => {
			receivedData = true;
			activity();
		};
		child.stdout?.on('data', dataActivity);
		destination.on('drain', activity);
		activity();
		try {
			if (!child.stdout) throw new ManagedRepositoryAccessError('execution-failed');
			// Backpressure propagates to Restic. No archive buffer or temporary TAR.
			// Do not end HTTP at stdout EOF: first require a successful process exit.
			await pipeline(child.stdout, destination, { end: false, signal: transfer.signal });
			pipelineFinished = true;
			await closed;
			if (failure) throw new ManagedRepositoryAccessError(failure);
		} catch {
			stop(signal?.aborted ? 'cancelled' : failure || 'stream-interrupted');
			await closed; // config cleanup must wait until Restic/Rclone have stopped
			throw new ManagedRepositoryAccessError(failure || 'execution-failed');
		} finally {
			clearTimeout(timer!);
			signal?.removeEventListener('abort', abort);
			child.stdout?.removeListener('data', dataActivity);
			destination.removeListener('drain', activity);
			processManager.untrackProcess(processId);
			try {
				planLogger('download').info(
					{
						event: 'managed_native_archive',
						elapsedMs: Date.now() - began,
						exitStatus,
						signal: exitSignal,
						classification: failure || 'success',
						activeRepositorySessions: ManagedSftpRepositorySession.active,
						nodeRssBytes: process.memoryUsage().rss,
					},
					'Managed archive process finished.'
				);
			} catch {
				/* Never log arguments, environment or provider output. */
			}
		}
	}

	private run(
		binary: string,
		args: string[],
		env: NodeJS.ProcessEnv,
		signal?: AbortSignal,
		input?: string,
		restore = false,
		restoreTimeoutMs = 30 * 60_000
	): Promise<string> {
		if (signal?.aborted) return Promise.reject(new ManagedRepositoryAccessError('cancelled'));
		return new Promise((resolve, reject) => {
			const child = spawn(binary, args, {
				env,
				shell: false,
				windowsHide: true,
				detached: process.platform !== 'win32',
				stdio: ['pipe', 'pipe', 'pipe'],
			});
			const processId = `managed-recovery-${crypto.randomUUID()}`;
			processManager.trackProcess(processId, child);
			let output = '';
			let bytes = 0;
			let failure: RecoveryFailureCode | undefined;
			const stop = (reason: RecoveryFailureCode) => {
				failure ||= reason;
				killProcessTree(child, 'SIGKILL');
			};
			const abort = () => stop('cancelled');
			signal?.addEventListener('abort', abort, { once: true });
			const timer = setTimeout(
				() => stop('timeout'),
				restore ? Math.min(24 * 60 * 60_000, Math.max(1000, restoreTimeoutMs)) : 60_000
			);
			child.on('error', () => {
				failure ||= 'execution-failed';
			});
			child.stdin?.on('error', () => {
				failure ||= 'execution-failed';
			});
			child.stdin?.end(input);
			child.stdout?.setEncoding('utf8');
			child.stdout?.on('data', (chunk: string) => {
				bytes += Buffer.byteLength(chunk);
				if (bytes > 32 * 1024 * 1024) stop('output-limit');
				else output += chunk;
			});
			// Drain, but never retain/return stderr (may contain secrets/locations).
			child.stderr?.on('data', () => undefined);
			child.on('close', code => {
				// Also stop descendants that survived a normally exiting parent.
				if (process.platform !== 'win32' && child.pid) {
					try {
						process.kill(-child.pid, 'SIGKILL');
					} catch {
						/* Already stopped. */
					}
				}
				processManager.untrackProcess(processId);
				clearTimeout(timer);
				signal?.removeEventListener('abort', abort);
				if (failure) reject(new ManagedRepositoryAccessError(failure));
				else if (code !== 0)
					reject(
						new ManagedRepositoryAccessError(
							code === 12
								? 'wrong-password'
								: code === 10
									? 'repository-unavailable'
									: 'execution-failed'
						)
					);
				else resolve(output);
			});
			// Cleanup is intentionally AFTER close, never while rclone still uses config.
		});
	}
}

/** Fixed working set, including split UTF-8 and JSON records. No complete stdout copy. */
export async function consumeMetadataLines(
	chunks: AsyncIterable<Buffer | string>,
	consume: (line: string) => Promise<void>,
	maxLineBytes = 256 * 1024,
	maxStreamBytes = 1024 ** 3
) {
	let pending = Buffer.alloc(0),
		total = 0,
		lines = 0;
	const decoder = new TextDecoder('utf-8', { fatal: true });
	for await (const chunk of chunks) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += bytes.length;
		if (total > maxStreamBytes) throw new ManagedRepositoryAccessError('output-limit');
		let start = 0;
		for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
			if (pending.length + end - start > maxLineBytes)
				throw new ManagedRepositoryAccessError('output-limit');
			const line = Buffer.concat([pending, bytes.subarray(start, end)]);
			pending = Buffer.alloc(0);
			if (!line.length) throw new ManagedRepositoryAccessError('invalid-output');
			try {
				await consume(decoder.decode(line));
			} catch (error) {
				throw error instanceof AppError
					? error
					: new ManagedRepositoryAccessError('invalid-output');
			}
			start = end + 1;
			if (++lines % 256 === 0) await new Promise<void>(resolve => setImmediate(resolve));
		}
		if (pending.length + bytes.length - start > maxLineBytes)
			throw new ManagedRepositoryAccessError('output-limit');
		pending = Buffer.concat([pending, bytes.subarray(start)]);
	}
	// Restic's encoder always terminates records. EOF inside a record is truncation.
	if (pending.length) throw new ManagedRepositoryAccessError('invalid-output');
}

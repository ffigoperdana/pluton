import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { z } from 'zod';
import type { SnapshotDiffRecord } from './SnapshotComparison';
import { managedSnapshotPath } from '../managedSnapshotPath';
import { AppError } from '../AppError';
import { getBinaryPath } from '../binaryPathResolver';
import { killProcessTree } from '../processTree';
import { processManager } from '../../managers/ProcessManager';
import { planLogger } from '../logger';
import {
	archiveProcessWindow,
	sampleArchiveProcesses,
	type ArchiveProcessWindow,
} from './archiveProcessObservation';

export type RecoveryFailureCode =
	| 'network-unavailable'
	| 'authentication-denied'
	| 'tls-invalid'
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

export type RepositoryOperation =
	| 'credential-setup'
	| 'connection-probe'
	| 'repository-identity'
	| 'snapshot-metadata'
	| 'snapshot-index'
	| 'snapshot-diff'
	| 'archive-readback'
	| 'native-restore';

export type RepositoryTimeoutCategory =
	| 'connection-timeout'
	| 'repository-io-timeout'
	| 'command-deadline'
	| 'metadata-stream-deadline'
	| 'native-restore-deadline'
	| 'archive-first-output'
	| 'archive-output-idle'
	| 'archive-consumer-idle'
	| 'archive-exit-idle'
	| 'caller-deadline';

export type ArchiveActivity =
	| 'awaiting-archive-output'
	| 'validating-archive-output'
	| 'archive-output-paused'
	| 'archive-consumer-pending'
	| 'archive-exit-pending';
export type ArchiveActivityObserver = (activity: ArchiveActivity) => void;

export type ArchiveReadbackDiagnostic = {
	firstByteMs?: number;
	bytesReceived: number;
	lastOutputAgeMs?: number;
	consumerPending: boolean;
	consumerPendingMs?: number;
	consumerBackpressured: boolean;
	stdoutEnded: boolean;
	processAtStop: 'not-started' | 'running' | 'exited';
	completion:
		| 'not-started'
		| 'clean-exit'
		| 'nonzero-exit'
		| 'signalled'
		| 'spawn-error'
		| 'unknown';
	nativeIo?: ArchiveProcessWindow;
};

export type RepositoryOperationDiagnostic = {
	operation: RepositoryOperation;
	elapsedMs: number;
	timeoutCategory?: RepositoryTimeoutCategory;
	archive?: ArchiveReadbackDiagnostic;
};

const callerDeadline = (signal?: AbortSignal): 'caller-deadline' | undefined =>
	signal?.aborted && signal.reason?.name === 'TimeoutError' ? 'caller-deadline' : undefined;

/** Only closed error categories cross the process/credential boundary. */
export class ManagedRepositoryAccessError extends AppError {
	constructor(
		public readonly code: RecoveryFailureCode,
		readonly reason?:
			| 'repository-output-invalid'
			| 'metadata-schema-invalid'
			| 'invalid-size'
			| 'invalid-timestamp',
		readonly diagnostic?: RepositoryOperationDiagnostic
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
	tree: fullSnapshotId.optional(),
	original: fullSnapshotId.optional(),
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
	/** Fixed bounded transport check; names are discarded, never identity proof. */
	probe?(): Promise<void>;
	diff?(
		previous: string,
		current: string,
		consume: (record: SnapshotDiffRecord) => void
	): Promise<void>;
	identity?(): Promise<string>;
	snapshot(id: string): Promise<ManagedSnapshot>;
	/** Bounded compatibility helper. Production consumers use streamFiles. */
	files(id: string): Promise<ManagedSnapshotNode[]>;
	streamFiles(
		id: string,
		consume: (node: ManagedSnapshotNode) => void | Promise<void>
	): Promise<void>;
	restore(id: string, selectedFiles: string[], stagingPath: string): Promise<ManagedRestoreSummary>;
	/** Full snapshot TAR only; no client-controlled path, format or command. */
	archive(id: string, destination: Writable, onActivity?: ArchiveActivityObserver): Promise<void>;
	/** Exact validated snapshot item only; files are raw, directories are TAR. */
	dump?(id: string, itemPath: string, destination: Writable): Promise<void>;
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
	protected validateAccess(access: ManagedSftpAccess) {
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
	}
	protected async connectionConfiguration(
		access: ManagedSftpAccess,
		environment: NodeJS.ProcessEnv,
		signal?: AbortSignal
	): Promise<{ contents: string; environment?: NodeJS.ProcessEnv }> {
		const obscured = (
			await this.run(getBinaryPath('rclone'), ['obscure', '-'], environment, signal, {
				operation: 'credential-setup',
				input: access.options.pass + '\n',
			})
		).trim();
		if (!obscured || !/^[A-Za-z0-9_-]+$/.test(obscured))
			throw new ManagedRepositoryAccessError('credentials-unavailable');
		const options = { ...access.options, pass: obscured };
		return {
			contents:
				'[pluton]\ntype = sftp\n' +
				Object.entries(options)
					.map(([key, value]) => key + ' = ' + value)
					.join('\n') +
				'\n',
		};
	}
	private async scopedSession<T>(
		access: ManagedSftpAccess,
		consume: (session: ManagedRepositorySession) => Promise<T>,
		signal?: AbortSignal,
		limits?: { restoreTimeoutMs: number; temporaryRoot?: string; cleanupWarning?: () => void }
	): Promise<T> {
		this.validateAccess(access);
		const restic = getBinaryPath('restic');
		const rclone = getBinaryPath('rclone');
		// Never silently fall back to an unpinned executable in PATH.
		if (!path.isAbsolute(restic) || !path.isAbsolute(rclone)) {
			throw new ManagedRepositoryAccessError('execution-failed');
		}
		const environment = safeEnvironment();
		let directory: string | undefined;
		try {
			const connection = await this.connectionConfiguration(access, environment, signal);
			directory = await fs.mkdtemp(
				path.join(limits?.temporaryRoot || os.tmpdir(), 'pluton-recovery-')
			);
			await fs.chmod(directory, 0o700);
			const configPath = path.join(directory, 'rclone.conf');
			await fs.writeFile(configPath, connection.contents, { flag: 'wx', mode: 0o600 });
			await fs.chmod(configPath, 0o600);
			const resticEnvironment = {
				...environment,
				...connection.environment,
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
			const execute = (args: string[], operation: RepositoryOperation) =>
				this.run(restic, [...prefix, ...args], resticEnvironment, signal, {
					operation,
					deadlineMs:
						operation === 'native-restore'
							? Math.min(24 * 60 * 60_000, Math.max(1000, limits?.restoreTimeoutMs ?? 30 * 60_000))
							: 60_000,
				});
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
					signal,
					'snapshot-index'
				);
				if (!header) throw new ManagedRepositoryAccessError('invalid-output');
			};
			return await consume({
				probe: async () => {
					await this.run(
						rclone,
						[
							'lsf',
							'pluton:' + access.repositoryPath,
							'--max-depth',
							'1',
							'--files-only',
							'--retries',
							'1',
							'--low-level-retries',
							'1',
							'--timeout',
							'10s',
							'--contimeout',
							'5s',
						],
						resticEnvironment,
						signal,
						{ operation: 'connection-probe' }
					);
				},
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
						signal,
						'snapshot-diff'
					);
				},
				dump: async (id, itemPath, destination) => {
					checkId(id);
					managedSnapshotPath(itemPath);
					await this.streamArchive(
						restic,
						[
							...prefix.filter(argument => argument !== '--json'),
							'dump',
							'--archive',
							'tar',
							id,
							itemPath,
						],
						resticEnvironment,
						destination,
						signal
					);
				},
				archive: async (id, destination, onActivity) => {
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
						signal,
						onActivity
					);
				},
				identity: async () =>
					this.parse(
						z.object({ id: fullSnapshotId }),
						await execute(['cat', 'config'], 'repository-identity')
					).id,
				snapshot: async id => {
					checkId(id);
					const snapshots = this.parse(
						z.array(snapshotSchema),
						await execute(['snapshots', id], 'snapshot-metadata')
					);
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
						'native-restore'
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
		signal: AbortSignal | undefined,
		operation: 'snapshot-index' | 'snapshot-diff'
	) {
		const began = performance.now();
		const diagnostic = (
			timeoutCategory?: RepositoryTimeoutCategory
		): RepositoryOperationDiagnostic => ({
			operation,
			elapsedMs: Math.round(performance.now() - began),
			timeoutCategory,
		});
		if (signal?.aborted)
			throw new ManagedRepositoryAccessError(
				'cancelled',
				undefined,
				diagnostic(callerDeadline(signal))
			);
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
		const abort = () =>
			stop(
				new ManagedRepositoryAccessError('cancelled', undefined, diagnostic(callerDeadline(signal)))
			);
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
		const timer = setTimeout(
			() =>
				stop(
					new ManagedRepositoryAccessError(
						'timeout',
						undefined,
						diagnostic('metadata-stream-deadline')
					)
				),
			15 * 60_000
		);
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
		signal?: AbortSignal,
		onActivity?: ArchiveActivityObserver
	): Promise<void> {
		const began = performance.now();
		const duration = (ms: number) => Math.min(24 * 60 * 60_000, Math.max(0, Math.round(ms)));
		let timeoutCategory: RepositoryTimeoutCategory | undefined;
		const archiveError = (code: RecoveryFailureCode, archive: ArchiveReadbackDiagnostic) =>
			new ManagedRepositoryAccessError(code, undefined, {
				operation: 'archive-readback',
				elapsedMs: duration(performance.now() - began),
				timeoutCategory,
				archive,
			});
		if (signal?.aborted || destination.destroyed) {
			timeoutCategory = callerDeadline(signal);
			throw archiveError('cancelled', {
				bytesReceived: 0,
				consumerPending: false,
				consumerBackpressured: false,
				stdoutEnded: false,
				processAtStop: 'not-started',
				completion: 'not-started',
			});
		}
		const child = spawn(binary, args, {
			env,
			shell: false,
			windowsHide: true,
			detached: process.platform !== 'win32',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const processId = 'managed-download-' + crypto.randomUUID();
		let exitStatus: number | null = null,
			exitSignal: string | null = null;
		processManager.trackProcess(processId, child);
		let failure: RecoveryFailureCode | undefined;
		let hasClosed = false;
		let pipelineFinished = false;
		let firstOutput: number | undefined;
		let lastOutput: number | undefined;
		let pendingWrite: number | undefined;
		let bytesReceived = 0;
		let completion: ArchiveReadbackDiagnostic['completion'] = 'unknown';
		let stopped: ArchiveReadbackDiagnostic | undefined;
		let nativeIo: ReturnType<typeof archiveProcessWindow>;
		const transfer = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		// pipeline(end:false) only waits for stdout EOF, even with an outstanding
		// destination write below its high water mark. End this forwarding stream
		// instead, and wait for real write acknowledgements without closing the caller's sink.
		const forwarding = new Writable({
			highWaterMark: destination.writableHighWaterMark,
			write(chunk, _encoding, done) {
				pendingWrite = performance.now();
				destination.write(chunk, error => {
					pendingWrite = undefined;
					done(error);
				});
			},
		});
		const observe = (): ArchiveReadbackDiagnostic => {
			const now = performance.now();
			return {
				firstByteMs: firstOutput === undefined ? undefined : duration(firstOutput - began),
				bytesReceived,
				lastOutputAgeMs: lastOutput === undefined ? undefined : duration(now - lastOutput),
				consumerPending: pendingWrite !== undefined || forwarding.writableLength > 0,
				consumerPendingMs: pendingWrite === undefined ? undefined : duration(now - pendingWrite),
				consumerBackpressured: forwarding.writableNeedDrain || destination.writableNeedDrain,
				stdoutEnded: child.stdout?.readableEnded ?? false,
				processAtStop:
					completion === 'spawn-error'
						? 'not-started'
						: hasClosed || child.exitCode != null || child.signalCode != null
							? 'exited'
							: 'running',
				completion,
				nativeIo: nativeIo && {
					windowMs: nativeIo.windowMs,
					sampleAgeMs: duration(now - nativeIo.at),
					restic: nativeIo.restic,
					rclone: nativeIo.rclone,
				},
			};
		};
		const stop = (reason: RecoveryFailureCode, category?: RepositoryTimeoutCategory) => {
			if (failure) return;
			failure = reason;
			timeoutCategory = category;
			stopped = observe();
			if (!hasClosed) killProcessTree(child, 'SIGKILL');
			if (!pipelineFinished) transfer.abort();
			// An interrupted archive cannot be completed or served safely.
			destination.destroy();
		};
		const abort = () => stop('cancelled', callerDeadline(signal));
		const disconnected = () =>
			stop(signal?.aborted ? 'cancelled' : 'stream-interrupted', callerDeadline(signal));
		const activity = () => {
			if (failure) return;
			clearTimeout(timer);
			timer = setTimeout(
				() => {
					const sample = observe();
					let category: RepositoryTimeoutCategory = 'archive-first-output';
					if (firstOutput !== undefined) {
						if (sample.consumerPending || sample.consumerBackpressured)
							category = 'archive-consumer-idle';
						else if (pipelineFinished || sample.stdoutEnded) category = 'archive-exit-idle';
						else category = 'archive-output-idle';
					}
					stop('timeout', category);
				},
				firstOutput === undefined ? 15_000 : 10 * 60_000
			);
			timer.unref();
		};
		const closed = new Promise<void>(resolve => {
			child.once('close', (code, childSignal) => {
				exitStatus = code;
				exitSignal = childSignal;
				hasClosed = true;
				if (completion !== 'spawn-error')
					completion =
						code === 0
							? 'clean-exit'
							: childSignal
								? 'signalled'
								: code === null
									? 'unknown'
									: 'nonzero-exit';
				if (code !== 0)
					stop(
						code === 12
							? 'wrong-password'
							: code === 10
								? 'repository-unavailable'
								: 'archive-failed'
					);
				resolve();
			});
		});
		child.on('error', () => {
			completion = 'spawn-error';
			stop('execution-failed');
		});
		child.stderr?.on('data', () => undefined); // never retain provider diagnostics
		signal?.addEventListener('abort', abort, { once: true });
		let reported: ArchiveActivity | undefined;
		const report = (value: ArchiveActivity) => {
			if (!onActivity || reported === value) return;
			reported = value;
			try {
				onActivity(value);
			} catch {
				/* Progress reporting cannot interrupt archive verification. */
			}
		};
		let quietTimer: ReturnType<typeof setTimeout> | undefined;
		let previous: Awaited<ReturnType<typeof sampleArchiveProcesses>>;
		let sampling = false;
		let closedArchive = false;
		const checkQuiet = () => {
			if (failure || closedArchive) return;
			const current = observe();
			if (current.consumerPending || current.consumerBackpressured)
				report('archive-consumer-pending');
			else if (pipelineFinished || current.stdoutEnded) report('archive-exit-pending');
			else {
				report('archive-output-paused');
				if (!sampling && child.pid !== undefined) {
					const outputBeforeSample = lastOutput;
					sampling = true;
					void sampleArchiveProcesses(child.pid)
						.then(sample => {
							if (failure || closedArchive || hasClosed || outputBeforeSample !== lastOutput)
								return;
							nativeIo = sample && previous ? archiveProcessWindow(previous, sample) : undefined;
							previous = sample;
						})
						.catch(() => {})
						.finally(() => {
							sampling = false;
						});
				}
			}
			quietTimer = setTimeout(checkQuiet, 5_000);
			quietTimer.unref();
		};
		const dataActivity = (chunk: Buffer) => {
			lastOutput = performance.now();
			firstOutput ??= lastOutput;
			bytesReceived = Math.min(Number.MAX_SAFE_INTEGER, bytesReceived + chunk.length);
			activity();
			if (onActivity && !failure) {
				report('validating-archive-output');
				previous = undefined;
				nativeIo = undefined;
				clearTimeout(quietTimer);
				quietTimer = setTimeout(checkQuiet, 30_000);
				quietTimer.unref();
			}
		};
		child.stdout?.on('data', dataActivity);
		destination.on('drain', activity);
		destination.on('close', disconnected);
		destination.on('error', disconnected);
		activity();
		const diagnostic = () => ({ ...(stopped ?? observe()), completion });
		try {
			if (!child.stdout) throw new ManagedRepositoryAccessError('execution-failed');
			await pipeline(child.stdout, forwarding, { signal: transfer.signal });
			pipelineFinished = true;
			await closed;
		} catch {
			stop(signal?.aborted ? 'cancelled' : 'stream-interrupted', callerDeadline(signal));
			await closed; // config cleanup must wait until Restic/Rclone have stopped
		} finally {
			closedArchive = true;
			clearTimeout(timer!);
			clearTimeout(quietTimer);
			signal?.removeEventListener('abort', abort);
			child.stdout?.removeListener('data', dataActivity);
			destination.removeListener('drain', activity);
			destination.removeListener('close', disconnected);
			destination.removeListener('error', disconnected);
			processManager.untrackProcess(processId);
			try {
				planLogger('download').info(
					{
						event: 'managed_native_archive',
						operation: 'archive-readback',
						elapsedMs: duration(performance.now() - began),
						timeoutCategory,
						archive: diagnostic(),
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
		if (failure) throw archiveError(failure, diagnostic());
	}

	private run(
		binary: string,
		args: string[],
		env: NodeJS.ProcessEnv,
		signal: AbortSignal | undefined,
		{
			operation,
			input,
			deadlineMs = 60_000,
		}: { operation: RepositoryOperation; input?: string; deadlineMs?: number }
	): Promise<string> {
		const began = performance.now();
		let timeoutCategory: RepositoryTimeoutCategory | undefined;
		const operationDiagnostic = (): RepositoryOperationDiagnostic => ({
			operation,
			elapsedMs: Math.round(performance.now() - began),
			timeoutCategory,
		});
		if (signal?.aborted) {
			timeoutCategory = callerDeadline(signal);
			return Promise.reject(
				new ManagedRepositoryAccessError('cancelled', undefined, operationDiagnostic())
			);
		}
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
			let diagnostic = Buffer.alloc(0);
			let diagnosticTruncated = false;
			let bytes = 0;
			let failure: RecoveryFailureCode | undefined;
			const stop = (reason: RecoveryFailureCode, category?: RepositoryTimeoutCategory) => {
				if (!failure) {
					failure = reason;
					timeoutCategory = category;
				}
				killProcessTree(child, 'SIGKILL');
			};
			const abort = () => {
				const category = callerDeadline(signal);
				stop(category ? 'timeout' : 'cancelled', category);
			};
			signal?.addEventListener('abort', abort, { once: true });
			const timer = setTimeout(
				() =>
					stop(
						'timeout',
						operation === 'native-restore' ? 'native-restore-deadline' : 'command-deadline'
					),
				deadlineMs
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
			// Bounded private classification only. Never return or log provider text.
			child.stderr?.on('data', (chunk: Buffer) => {
				diagnosticTruncated ||= diagnostic.length + chunk.length > 16 * 1024;
				diagnostic = Buffer.concat([diagnostic, Buffer.from(chunk)]).subarray(-16 * 1024);
			});
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
				if (!failure && code === 0) {
					resolve(output);
					return;
				}
				const providerText = diagnostic.toString();
				const failureCode =
					failure && failure !== 'timeout'
						? failure
						: diagnosticTruncated && (failure === 'timeout' || code !== 12)
							? 'output-limit'
							: recoveryProcessFailure(code, providerText, failure);
				if (!timeoutCategory && failureCode === 'network-unavailable') {
					if (/dial tcp[^\r\n]*(?:i\/o timeout|connection timed out)/i.test(providerText))
						timeoutCategory = 'connection-timeout';
					else if (/i\/o timeout/i.test(providerText)) timeoutCategory = 'repository-io-timeout';
				}
				reject(new ManagedRepositoryAccessError(failureCode, undefined, operationDiagnostic()));
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

/** Closed classifications only; authentication/TLS/encryption always outrank availability. */
export function recoveryProcessFailure(
	exitCode: number | null,
	diagnostic: string,
	fallback: RecoveryFailureCode = 'execution-failed'
): RecoveryFailureCode {
	if (
		exitCode === 12 ||
		/wrong password|no key found|unable to decrypt|cipher|authentication tag/i.test(diagnostic)
	)
		return 'wrong-password';
	if (
		/permission denied|authentication failed|unable to authenticate|AccessDenied|Forbidden|SignatureDoesNotMatch|InvalidAccessKey|\b(?:401|403)\b/i.test(
			diagnostic
		)
	)
		return 'authentication-denied';
	if (
		/x509|certificate|tls handshake|host key (?:mismatch|verification failed|not found|unknown)|knownhosts: (?:key mismatch|key is unknown)|remote host identification has changed|fingerprint mismatch/i.test(
			diagnostic
		)
	)
		return 'tls-invalid';
	if (
		/connection refused|network is unreachable|no route to host|no such host|connection reset by peer|i\/o timeout|dial tcp.*timeout|temporary failure in name resolution|EHOSTUNREACH|ECONNREFUSED|ENETUNREACH|ENOTFOUND/i.test(
			diagnostic
		)
	)
		return 'network-unavailable';
	return fallback === 'timeout' ? 'timeout' : exitCode === 10 ? 'repository-unavailable' : fallback;
}

import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { getBinaryPath } from '../binaryPathResolver';
import { killProcessTree } from '../processTree';
import { processManager } from '../../managers/ProcessManager';
import { recoveryProcessFailure } from '../restic/ManagedSftpRepositorySession';
import {
	buildInventory,
	HashVerification,
	RelocationError,
	type RelocationFailureCode,
	type RepositoryInventory,
} from './repositoryInventory';

export type SftpEndpoint = { options: Record<string, string>; path: string };
export type RelocationSide = 'source' | 'destination';
export type CopyProgress = {
	copiedBytes: number;
	copyTotalBytes: number;
	copiedFiles: number;
	copyTotalFiles: number;
};

/** The only repository operations a relocation may perform. No init/backup/forget/prune/unlock. */
export interface RepositoryTransferSession {
	/** `null` when the directory does not exist. */
	inventory(
		side: RelocationSide,
		options?: { allowPartial?: boolean; requireRepository?: boolean }
	): Promise<(RepositoryInventory & { partial: string[] }) | null>;
	/** Removes Rclone upload temporaries from the job-owned destination only. */
	removeDestinationPartials(): Promise<void>;
	copy(onProgress: (progress: CopyProgress) => void): Promise<void>;
	sha256(side: RelocationSide, file: 'config'): Promise<string>;
	verifyDestinationHashes(
		inventory: RepositoryInventory,
		configSha256: string,
		onProgress: (verifiedFiles: number) => void
	): Promise<void>;
	repositoryId(side: RelocationSide): Promise<string>;
	snapshotIds(side: RelocationSide): Promise<string[]>;
	checkDestination(): Promise<void>;
	/** Whole-directory removal of the previous location. Callers prove ownership first. */
	purgeSource(): Promise<void>;
}
export interface RepositoryTransferProvider {
	withSession<T>(
		input: { source: SftpEndpoint; destination: SftpEndpoint; password: string },
		consume: (session: RepositoryTransferSession) => Promise<T>,
		signal?: AbortSignal
	): Promise<T>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const OPTION_KEYS = ['host', 'port', 'user', 'pass'];
const RCLONE_NETWORK = [
	'--retries',
	'3',
	'--low-level-retries',
	'10',
	'--contimeout',
	'60s',
	'--timeout',
	'5m',
];
const fullId = z.string().regex(/^[a-f0-9]{64}$/);

function safeEnvironment(): NodeJS.ProcessEnv {
	// Never inherit RESTIC_*, RCLONE_*, password commands or application secrets.
	const environment: NodeJS.ProcessEnv = {};
	for (const key of ['PATH', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR']) {
		if (process.env[key]) environment[key] = process.env[key];
	}
	return environment;
}

const hasControl = (value: string) =>
	[...value].some(character => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f);

function validateEndpoint(endpoint: SftpEndpoint) {
	const keys = Object.keys(endpoint.options);
	if (
		keys.some(key => !OPTION_KEYS.includes(key)) ||
		!endpoint.options.host ||
		!endpoint.options.user ||
		!endpoint.options.pass ||
		Object.values(endpoint.options).some(value => typeof value !== 'string' || hasControl(value)) ||
		!endpoint.path ||
		endpoint.path.includes('\\') ||
		hasControl(endpoint.path) ||
		endpoint.path.split('/').includes('..') ||
		['/', '.', './'].includes(endpoint.path)
	)
		throw new RelocationError('configuration-invalid', 400);
}

/** Provider classification first; then Rclone conditions that matter to a copy. */
function classify(code: number | null, diagnostic: string): RelocationFailureCode {
	if (/no space left|disk quota|quota exceeded|insufficient (?:storage|space)/i.test(diagnostic))
		return 'destination-full';
	if (/immutable file modified|source and destination exist but do not match/i.test(diagnostic))
		return 'destination-conflict';
	const base = recoveryProcessFailure(code, diagnostic);
	if (base === 'tls-invalid') return 'host-verification-failed';
	const passthrough: RelocationFailureCode[] = [
		'network-unavailable',
		'authentication-denied',
		'configuration-invalid',
		'repository-unavailable',
		'wrong-password',
		'invalid-output',
		'output-limit',
		'timeout',
		'cancelled',
	];
	return passthrough.includes(base as RelocationFailureCode)
		? (base as RelocationFailureCode)
		: 'execution-failed';
}

type RunOptions = {
	deadlineMs: number;
	input?: string;
	maxStdoutBytes?: number;
	onStdoutLine?: (line: string) => void;
	onStderrLine?: (line: string) => void;
	/** Exit code that means "directory not found" and is an expected answer. */
	missingExitCode?: number;
	/**
	 * Kill the process when no forward progress was reported for this long. A hung
	 * SFTP request can block Rclone without any I/O, which its own idle timeout misses.
	 */
	stallMs?: number;
	/** Receives a function that marks forward progress; called by the line consumers. */
	onActivity?: (markActivity: () => void) => void;
};
const STALL_MS = 10 * 60_000;

export class SftpRepositoryTransfer implements RepositoryTransferProvider {
	async withSession<T>(
		input: { source: SftpEndpoint; destination: SftpEndpoint; password: string },
		consume: (session: RepositoryTransferSession) => Promise<T>,
		signal?: AbortSignal
	): Promise<T> {
		validateEndpoint(input.source);
		validateEndpoint(input.destination);
		if (!input.password) throw new RelocationError('configuration-invalid', 400);
		const restic = getBinaryPath('restic');
		const rclone = getBinaryPath('rclone');
		if (!path.isAbsolute(restic) || !path.isAbsolute(rclone))
			throw new RelocationError('execution-failed', 500);
		const environment = safeEnvironment();
		let directory: string | undefined;
		try {
			const section = async (name: RelocationSide, endpoint: SftpEndpoint) => {
				const obscured = (
					await this.run(rclone, ['obscure', '-'], environment, signal, {
						deadlineMs: MINUTE,
						input: endpoint.options.pass + '\n',
					})
				).stdout.trim();
				if (!/^[A-Za-z0-9_-]+$/.test(obscured)) throw new RelocationError('configuration-invalid');
				return (
					`[${name}]\ntype = sftp\n` +
					Object.entries({ ...endpoint.options, pass: obscured })
						.map(([key, value]) => `${key} = ${value}`)
						.join('\n') +
					'\n'
				);
			};
			const contents =
				(await section('source', input.source)) +
				(await section('destination', input.destination));
			directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pluton-relocation-'));
			await fs.chmod(directory, 0o700);
			const configPath = path.join(directory, 'rclone.conf');
			await fs.writeFile(configPath, contents, { flag: 'wx', mode: 0o600 });
			await fs.chmod(configPath, 0o600);
			const rcloneEnv = { ...environment, RCLONE_CONFIG: configPath };
			const resticEnv = { ...rcloneEnv, RESTIC_PASSWORD: input.password };
			const remote = (side: RelocationSide) => `${side}:${input[side].path}`;
			const restic$ = (side: RelocationSide, args: string[], options: RunOptions) =>
				this.run(
					restic,
					[
						'--no-lock',
						'--no-cache',
						'--json',
						'--repo',
						`rclone:${remote(side)}`,
						'-o',
						`rclone.program=${rclone}`,
						...args,
					],
					resticEnv,
					signal,
					options
				);
			const session: RepositoryTransferSession = {
				inventory: async (side, options = {}) => {
					const result = await this.run(
						rclone,
						[
							'lsjson',
							'-R',
							'--files-only',
							'--no-modtime',
							'--no-mimetype',
							...RCLONE_NETWORK,
							remote(side),
						],
						rcloneEnv,
						signal,
						{ deadlineMs: 2 * HOUR, maxStdoutBytes: 256 * 1024 ** 2, missingExitCode: 3 }
					);
					if (result.missing) return null;
					let parsed: unknown;
					try {
						parsed = JSON.parse(result.stdout);
					} catch {
						throw new RelocationError('invalid-output');
					}
					return buildInventory(parsed, options);
				},
				removeDestinationPartials: async () => {
					await this.run(
						rclone,
						['delete', '--include', '*.partial', ...RCLONE_NETWORK, remote('destination')],
						rcloneEnv,
						signal,
						{ deadlineMs: HOUR, missingExitCode: 3 }
					);
				},
				copy: async onProgress => {
					await this.run(
						rclone,
						[
							'copy',
							remote('source'),
							remote('destination'),
							'--exclude',
							'/locks/**',
							'--size-only',
							'--immutable',
							'--no-update-modtime',
							'--transfers',
							'4',
							'--checkers',
							'8',
							'--use-json-log',
							'--stats',
							'5s',
							'--stats-log-level',
							'NOTICE',
							...RCLONE_NETWORK,
						],
						rcloneEnv,
						signal,
						((): RunOptions => {
							let mark = () => {};
							let last = '';
							return {
								deadlineMs: 48 * HOUR,
								stallMs: STALL_MS,
								onActivity: markActivity => (mark = markActivity),
								onStderrLine: line => {
									const stats = copyStats(line);
									if (!stats) return;
									const fingerprint = statsFingerprint(line);
									if (fingerprint !== last) {
										last = fingerprint;
										mark();
									}
									onProgress(stats);
								},
							};
						})()
					);
				},
				sha256: async side => {
					const output = (
						await this.run(
							rclone,
							[
								'hashsum',
								'sha256',
								'--download',
								'--include',
								'/config',
								...RCLONE_NETWORK,
								remote(side),
							],
							rcloneEnv,
							signal,
							{ deadlineMs: 10 * MINUTE }
						)
					).stdout
						.split('\n')
						.filter(Boolean);
					const hash = output.length === 1 ? /^([a-f0-9]{64}) {2}config$/.exec(output[0]) : null;
					if (!hash) throw new RelocationError('repository-incomplete');
					return hash[1];
				},
				verifyDestinationHashes: async (inventory, configSha256, onProgress) => {
					const verification = new HashVerification(inventory, configSha256);
					let failure: RelocationError | undefined;
					let markHashed = () => {};
					await this.run(
						rclone,
						[
							'hashsum',
							'sha256',
							'--download',
							'--exclude',
							'/locks/**',
							'--checkers',
							'4',
							...RCLONE_NETWORK,
							remote('destination'),
						],
						rcloneEnv,
						signal,
						{
							deadlineMs: 48 * HOUR,
							stallMs: STALL_MS,
							onActivity: markActivity => (markHashed = markActivity),
							onStdoutLine: line => {
								markHashed();
								if (failure) return;
								try {
									verification.accept(line);
									if (verification.count % 64 === 0) onProgress(verification.count);
								} catch (error) {
									failure =
										error instanceof RelocationError
											? error
											: new RelocationError('invalid-output');
								}
							},
						}
					).catch(error => {
						// A hash mismatch outranks the non-zero exit Rclone reports for it.
						throw failure || error;
					});
					if (failure) throw failure;
					verification.finish();
					onProgress(verification.count);
				},
				repositoryId: async side => {
					const output = (
						await restic$(side, ['cat', 'config'], { deadlineMs: 5 * MINUTE })
					).stdout;
					try {
						return z.object({ id: fullId }).parse(JSON.parse(output)).id;
					} catch {
						throw new RelocationError('invalid-output');
					}
				},
				snapshotIds: async side => {
					const output = (
						await restic$(side, ['snapshots'], {
							deadlineMs: 30 * MINUTE,
							maxStdoutBytes: 128 * 1024 ** 2,
						})
					).stdout;
					try {
						return z
							.array(z.object({ id: fullId }).passthrough())
							.parse(JSON.parse(output))
							.map(snapshot => snapshot.id);
					} catch {
						throw new RelocationError('invalid-output');
					}
				},
				checkDestination: async () => {
					try {
						await restic$('destination', ['check'], {
							deadlineMs: 24 * HOUR,
							onStdoutLine: () => undefined,
						});
					} catch (error) {
						if (
							error instanceof RelocationError &&
							['execution-failed', 'repository-unavailable'].includes(error.code)
						)
							throw new RelocationError('restic-check-failed');
						throw error;
					}
				},
				purgeSource: async () => {
					try {
						await this.run(
							rclone,
							['purge', ...RCLONE_NETWORK, remote('source')],
							rcloneEnv,
							signal,
							{ deadlineMs: 12 * HOUR, missingExitCode: 3 }
						);
					} catch (error) {
						if (error instanceof RelocationError && error.code === 'cancelled') throw error;
						throw new RelocationError('source-delete-failed');
					}
				},
			};
			return await consume(session);
		} finally {
			if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
		}
	}

	/** Bounded, credential-free process execution. Provider text never leaves this method. */
	private run(
		binary: string,
		args: string[],
		env: NodeJS.ProcessEnv,
		signal: AbortSignal | undefined,
		options: RunOptions
	): Promise<{ stdout: string; missing: boolean }> {
		if (signal?.aborted) return Promise.reject(new RelocationError('cancelled'));
		return new Promise((resolve, reject) => {
			const child = spawn(binary, args, {
				env,
				shell: false,
				windowsHide: true,
				detached: process.platform !== 'win32',
				stdio: ['pipe', 'pipe', 'pipe'],
			});
			const processId = `plan-relocation-${crypto.randomUUID()}`;
			processManager.trackProcess(processId, child);
			const maxStdout = options.maxStdoutBytes ?? 32 * 1024 ** 2;
			let stdout = '';
			let stdoutBytes = 0;
			let pendingOut = '';
			let pendingErr = '';
			let diagnostic = '';
			let failure: RelocationFailureCode | undefined;
			const stop = (reason: RelocationFailureCode) => {
				failure ||= reason;
				killProcessTree(child, 'SIGKILL');
			};
			const abort = () => stop('cancelled');
			signal?.addEventListener('abort', abort, { once: true });
			const timer = setTimeout(() => stop('timeout'), options.deadlineMs);
			let stall: NodeJS.Timeout | undefined;
			const markActivity = () => {
				if (!options.stallMs) return;
				if (stall) clearTimeout(stall);
				stall = setTimeout(() => stop('timeout'), options.stallMs);
			};
			markActivity();
			options.onActivity?.(markActivity);
			const lines = (pending: string, chunk: string, consume?: (line: string) => void) => {
				const text = pending + chunk;
				const parts = text.split('\n');
				const rest = parts.pop() || '';
				if (rest.length > 1024 * 1024) stop('output-limit');
				for (const line of parts) if (line) consume?.(line.replace(/\r$/, ''));
				return rest;
			};
			child.on('error', () => {
				failure ||= 'execution-failed';
			});
			child.stdin?.on('error', () => {
				failure ||= 'execution-failed';
			});
			child.stdin?.end(options.input);
			child.stdout?.setEncoding('utf8');
			child.stdout?.on('data', (chunk: string) => {
				if (options.onStdoutLine) {
					pendingOut = lines(pendingOut, chunk, options.onStdoutLine);
					return;
				}
				stdoutBytes += Buffer.byteLength(chunk);
				if (stdoutBytes > maxStdout) stop('output-limit');
				else stdout += chunk;
			});
			child.stderr?.setEncoding('utf8');
			child.stderr?.on('data', (chunk: string) => {
				// Bounded private classification only. Never returned or logged.
				diagnostic = (diagnostic + chunk).slice(-16 * 1024);
				if (options.onStderrLine) pendingErr = lines(pendingErr, chunk, options.onStderrLine);
			});
			child.on('close', code => {
				if (process.platform !== 'win32' && child.pid) {
					try {
						process.kill(-child.pid, 'SIGKILL');
					} catch {
						/* Already stopped. */
					}
				}
				processManager.untrackProcess(processId);
				clearTimeout(timer);
				if (stall) clearTimeout(stall);
				signal?.removeEventListener('abort', abort);
				if (!failure && pendingOut && options.onStdoutLine) options.onStdoutLine(pendingOut);
				if (!failure && code === 0) return resolve({ stdout, missing: false });
				if (
					!failure &&
					options.missingExitCode !== undefined &&
					code === options.missingExitCode &&
					/directory not found|not found/i.test(diagnostic)
				)
					return resolve({ stdout: '', missing: true });
				reject(new RelocationError(failure || classify(code, diagnostic)));
			});
		});
	}
}

/** Counters that only move with real work; elapsed time and speed are excluded. */
export function statsFingerprint(line: string): string {
	try {
		const stats = JSON.parse(line)?.stats || {};
		return ['bytes', 'checks', 'transfers', 'listed', 'deletes', 'renames', 'errors']
			.map(key => String(stats[key] ?? ''))
			.join(':');
	} catch {
		return '';
	}
}

/** Rclone JSON log stats line → real counters, or undefined for any other line. */
export function copyStats(line: string): CopyProgress | undefined {
	if (!line.startsWith('{')) return undefined;
	try {
		const stats = JSON.parse(line)?.stats;
		if (!stats || typeof stats !== 'object') return undefined;
		const count = (value: unknown) =>
			typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
		return {
			copiedBytes: count(stats.bytes),
			copyTotalBytes: count(stats.totalBytes),
			copiedFiles: count(stats.transfers),
			copyTotalFiles: count(stats.totalTransfers),
		};
	} catch {
		return undefined;
	}
}

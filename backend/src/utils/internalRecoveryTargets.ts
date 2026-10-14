import crypto from 'crypto';
import { constants, lstatSync, readFileSync, openSync, closeSync, fstatSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { connect } from 'net';
import { z } from 'zod';
import type { InternalRecoverySession } from '../db/schema/internalRecovery';
import type {
	InternalRecoveryEngine,
	RecoveryDatabaseResult,
	RecoveryTarget,
} from '../types/recoveryTests';
import { recoveryTargetSchema } from './recoveryTestPolicy';
import { RecoveryTestError } from './recoveryValidation';
import { assertRecoveryClientPath } from './recoveryDatabaseClients';

const ROOT = '/run/pluton-internal-recovery';
const REQUESTS = '/run/pluton-internal-requests';
const MiB = 1024 ** 2;
const stateSchema = z
	.object({
		version: z.literal(1),
		installationId: z.string().regex(/^[a-f0-9]{32}$/),
		activationId: z.string().regex(/^[a-f0-9]{32}$/),
		engine: z.enum(['mariadb', 'postgresql']),
		approved: z.literal(true),
		status: z.enum(['active', 'removed']),
		expiresAt: z.number().int().positive(),
		testId: z
			.string()
			.regex(/^[a-f0-9]{24}$/)
			.optional(),
		snapshotId: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
	})
	.strict();
const targetSchema = z
	.object({
		version: z.literal(1),
		target: recoveryTargetSchema,
		databases: z
			.array(z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/))
			.min(1)
			.max(8),
		maxSqlBytes: z
			.number()
			.int()
			.positive()
			.max(448 * MiB),
	})
	.strict();
export type InternalReadiness = {
	engine: InternalRecoveryEngine;
	status: 'not_provisioned' | 'ready' | 'running' | 'cleanup_required';
	mode: 'operator-managed';
};
export type ResourceSample = {
	total: number;
	available: number;
	swapUsed: number;
	pressure: number;
	limit: number;
	used: number;
	cgroupSwap: number;
	diskAvailable: number;
};
export function internalResourceReason(
	sample: ResourceSample,
	sqlBytes: number,
	maxSqlBytes: number
) {
	if (Object.values(sample).some(n => !Number.isFinite(n) || n < 0)) return 'capacity-unknown';
	if (
		!Number.isSafeInteger(sqlBytes) ||
		!Number.isSafeInteger(maxSqlBytes) ||
		maxSqlBytes <= 0 ||
		maxSqlBytes > 448 * MiB ||
		sqlBytes <= 0 ||
		sqlBytes > maxSqlBytes
	)
		return 'operator-sql-budget';
	if (sqlBytes * 4 + 256 * MiB > 2 * 1024 * MiB) return 'expanded-data-budget';
	if (sample.total < 3800 * MiB) return 'host-memory-total';
	if (sample.available < 2560 * MiB) return 'host-memory-headroom';
	if (sample.swapUsed > 128 * MiB || sample.cgroupSwap > 0) return 'swap-in-use';
	if (sample.pressure > 1) return 'memory-pressure';
	if (sample.limit < 768 * MiB || sample.used > sample.limit * 0.85)
		return 'server-cgroup-headroom';
	if (sample.diskAvailable < sqlBytes + 2 * 1024 * MiB) return 'staging-capacity';
	return null;
}

/** Conservative admission policy, not a guarantee that a SQL workload fits in its hard limits. */
export function assertInternalResources(
	sample: ResourceSample,
	sqlBytes: number,
	maxSqlBytes: number
) {
	if (internalResourceReason(sample, sqlBytes, maxSqlBytes))
		throw new RecoveryTestError('database-target-preflight', 'internal-resources-insufficient');
}
async function resources(directory: string): Promise<ResourceSample> {
	try {
		const mem = await fs.readFile('/proc/meminfo', 'utf8');
		const field = (name: string) => {
			const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(mem);
			if (!match) throw new Error();
			return Number(match[1]) * 1024;
		};
		const pressureText = await fs.readFile('/proc/pressure/memory', 'utf8');
		const pressure = /^some avg10=(\d+(?:\.\d+)?)/m.exec(pressureText);
		if (!pressure) throw new Error();
		const read = async (file: string) =>
			(await fs.readFile(`/sys/fs/cgroup/${file}`, 'utf8')).trim();
		const limit = await read('memory.max');
		const disk = await fs.statfs(directory);
		return {
			total: field('MemTotal'),
			available: field('MemAvailable'),
			swapUsed: field('SwapTotal') - field('SwapFree'),
			pressure: Number(pressure[1]),
			limit: limit === 'max' ? 0 : Number(limit),
			used: Number(await read('memory.current')),
			cgroupSwap: Number(await read('memory.swap.current')),
			diskAvailable: disk.bavail * disk.bsize,
		};
	} catch {
		// Linux cgroup v2 + PSI is required; unknown capacity is not approval.
		throw new RecoveryTestError('database-target-preflight', 'internal-resources-insufficient');
	}
}
const reachable = (host: string, port: number) =>
	new Promise<boolean>(resolve => {
		const socket = connect({ host, port });
		const timer = setTimeout(() => {
			socket.destroy();
			resolve(false);
		}, 500);
		socket.once('connect', () => {
			clearTimeout(timer);
			socket.destroy();
			resolve(true);
		});
		socket.once('error', () => {
			clearTimeout(timer);
			socket.destroy();
			resolve(false);
		});
	});

/** Trust comes from a root-owned read-only bind, NOT from a request submitted by the web UI. */
export class InternalRecoveryTargets {
	constructor(
		private readonly sample = resources,
		private readonly probe = reachable
	) {}
	/** Read-only advisory sample. Unknown is never reported as safe; execution samples again. */
	async resourceView(directory: string) {
		try {
			const sample = await this.sample(directory);
			if (Object.values(sample).some(n => !Number.isFinite(n) || n < 0)) throw new Error();
			return { status: 'measured' as const, sample, observedAt: Date.now() };
		} catch {
			return { status: 'unknown' as const, sample: null, observedAt: Date.now() };
		}
	}
	async admission(
		engine: InternalRecoveryEngine,
		entries: RecoveryDatabaseResult[],
		directory: string
	) {
		try {
			const config = this.target(engine);
			const reason = internalResourceReason(
				await this.sample(directory),
				entries.reduce((sum, entry) => sum + entry.bytes, 0),
				config.maxSqlBytes
			);
			if (reason)
				return {
					status: 'refused' as const,
					code: 'internal-resources-insufficient' as const,
					reason,
					maxSqlBytes: config.maxSqlBytes,
				};
			return { status: 'admitted' as const, maxSqlBytes: config.maxSqlBytes };
		} catch (error) {
			return {
				status: 'refused' as const,
				code:
					error instanceof RecoveryTestError
						? error.code
						: ('internal-resources-insufficient' as const),
			};
		}
	}
	private read<T>(name: string, schema: z.ZodType<T>): T {
		try {
			if (process.platform !== 'linux' || process.getuid?.() !== 10001) throw new Error();
			if (!/^(?:state\.json|(?:mariadb|postgresql)\.json|removed-[a-f0-9]{32}\.json)$/.test(name))
				throw new Error();
			const file = path.join(ROOT, name);
			// Reject symlinks at the public boundary even if their resolved file is root-owned.
			if (lstatSync(file).isSymbolicLink() || lstatSync(ROOT).isSymbolicLink()) throw new Error();
			assertRecoveryClientPath(file, false);
			const stat = lstatSync(file);
			if (stat.size > 16_384 || (stat.mode & 0o007) !== 0) throw new Error();
			const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const opened = fstatSync(fd);
				if (!opened.isFile() || opened.uid !== 0 || opened.size > 16_384 || opened.mode & 0o6027)
					throw new Error();
				return schema.parse(JSON.parse(readFileSync(fd, 'utf8')));
			} finally {
				closeSync(fd);
			}
		} catch {
			throw new RecoveryTestError('database-target-preflight', 'internal-target-not-provisioned');
		}
	}
	private state() {
		return this.read('state.json', stateSchema);
	}
	private target(engine: InternalRecoveryEngine) {
		const config = this.read(`${engine}.json`, targetSchema);
		if (
			config.target.engine !== engine ||
			config.target.host !== `internal-${engine}` ||
			config.target.port !== (engine === 'mariadb' ? 3306 : 5432) ||
			config.target.tls !== 'verify-identity' ||
			!config.target.enabled ||
			!config.target.password ||
			new Set(config.databases).size !== config.databases.length
		)
			throw new RecoveryTestError('database-target-preflight', 'internal-target-unsafe');
		return config;
	}
	trust(
		session: Pick<
			InternalRecoverySession,
			'engine' | 'installationId' | 'activationId' | 'caSha256'
		>,
		cleanup = false
	) {
		const state = this.state();
		if (
			state.status !== 'active' ||
			(!cleanup && state.expiresAt <= Date.now()) ||
			state.engine !== session.engine ||
			state.installationId !== session.installationId ||
			state.activationId !== session.activationId
		)
			throw new RecoveryTestError('database-target-preflight', 'internal-target-unsafe');
		const file = assertRecoveryClientPath(path.join(ROOT, `${session.engine}-ca.pem`), false);
		if (
			lstatSync(file).size > 16_384 ||
			crypto.createHash('sha256').update(readFileSync(file)).digest('hex') !== session.caSha256
		)
			throw new RecoveryTestError('database-target-preflight', 'database-tls-failed');
		return file;
	}
	async readiness(pending: InternalRecoverySession[] = []): Promise<InternalReadiness[]> {
		return Promise.all(
			(['mariadb', 'postgresql'] as const).map(async engine => {
				let status: InternalReadiness['status'] = 'not_provisioned';
				const active = pending.find(value => value.engine === engine);
				if (active) status = active.cleanupReady ? 'cleanup_required' : 'running';
				else
					try {
						const state = this.state();
						const config = this.target(engine);
						if (
							state.status === 'active' &&
							state.engine === engine &&
							state.expiresAt > Date.now() &&
							(await this.probe(config.target.host, config.target.port))
						)
							status = 'ready';
					} catch {
						/* Curated readiness only; credentials and parser output are never returned. */
					}
				return { engine, status, mode: 'operator-managed' as const };
			})
		);
	}
	async prepare(engine: InternalRecoveryEngine, entries: RecoveryDatabaseResult[]) {
		const state = this.state();
		const config = this.target(engine);
		if (
			state.status !== 'active' ||
			state.engine !== engine ||
			state.expiresAt <= Date.now() ||
			entries.some(
				entry =>
					entry.engine !== engine || !entry.database || !config.databases.includes(entry.database)
			)
		)
			throw new RecoveryTestError('database-target-preflight', 'internal-target-unsafe');
		const caFile = assertRecoveryClientPath(path.join(ROOT, `${engine}-ca.pem`), false);
		const caSha256 = crypto.createHash('sha256').update(readFileSync(caFile)).digest('hex');
		this.trust({ ...state, caSha256 });
		return {
			engine,
			installationId: state.installationId,
			activationId: state.activationId,
			target: config.target as RecoveryTarget,
			caSha256,
		};
	}
	async preflight(
		engine: InternalRecoveryEngine,
		entries: RecoveryDatabaseResult[],
		directory: string
	) {
		const config = this.target(engine);
		assertInternalResources(
			await this.sample(directory),
			entries.reduce((n, entry) => n + entry.bytes, 0),
			config.maxSqlBytes
		);
	}
	async requestCleanup(session: InternalRecoverySession, snapshotId: string) {
		try {
			const stat = await fs.lstat(REQUESTS);
			if (
				!stat.isDirectory() ||
				stat.isSymbolicLink() ||
				stat.uid !== 10001 ||
				(stat.mode & 0o777) !== 0o700
			)
				throw new Error();
			const request = {
				version: 1,
				installationId: session.installationId,
				activationId: session.activationId,
				engine: session.engine,
				testId: session.testId,
				snapshotId,
				cleanupReady: session.cleanupReady,
			};
			const temporary = path.join(REQUESTS, `${crypto.randomBytes(12).toString('hex')}.tmp`);
			try {
				await fs.writeFile(temporary, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
				await fs.rename(temporary, path.join(REQUESTS, 'request.json'));
			} finally {
				await fs.rm(temporary, { force: true });
			}
		} catch {
			throw new RecoveryTestError('infrastructure-cleanup', 'internal-cleanup-required');
		}
	}
	removed(session: InternalRecoverySession, snapshotId: string): boolean {
		try {
			const state = this.read(`removed-${session.activationId}.json`, stateSchema);
			return (
				state.status === 'removed' &&
				state.testId === session.testId &&
				state.snapshotId === snapshotId &&
				state.engine === session.engine &&
				state.installationId === session.installationId &&
				state.activationId === session.activationId
			);
		} catch {
			return false;
		}
	}
}

export async function mysqlWorkerReadiness(): Promise<'unavailable' | 'ready'> {
	if (process.env.PLUTON_MYSQL_WORKER !== 'enabled' || process.platform !== 'linux')
		return 'unavailable';
	try {
		const stat = await fs.lstat('/run/pluton-mysql-worker/worker.sock');
		if (!stat.isSocket() || stat.uid !== 10001 || (stat.mode & 0o777) !== 0o600)
			return 'unavailable';
		return await new Promise(resolve => {
			const socket = connect('/run/pluton-mysql-worker/worker.sock');
			const timer = setTimeout(() => {
				socket.destroy();
				resolve('unavailable');
			}, 500);
			socket.once('connect', () => {
				clearTimeout(timer);
				socket.destroy();
				resolve('ready');
			});
			socket.once('error', () => {
				clearTimeout(timer);
				resolve('unavailable');
			});
		});
	} catch {
		return 'unavailable';
	}
}

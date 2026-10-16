import crypto from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import { constants } from 'fs';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { DatabaseRestore } from '../types/databaseRestores';
import type { RecoveryDatabaseResult } from '../types/recoveryTests';
import { DatabaseRestoreError } from './persistentRestorePolicy';
import { recoveryTargetSchema } from './recoveryTestPolicy';
import { setTimeout as pause } from 'timers/promises';

export const LIFECYCLE_VERSION = 1;
export const LIFECYCLE_ROOT = '/run/pluton-automatic-recovery';
export const LIFECYCLE_REQUESTS = '/run/pluton-automatic-recovery-requests';
const hex = (length: number) => z.string().regex(new RegExp(`^[a-f0-9]{${length}}$`));
export const lifecycleBindingSchema = z
	.object({
		id: hex(24),
		mode: z.enum(['persistent', 'disposable']),
		engine: z.enum(['mariadb', 'postgresql']),
		snapshotId: hex(64),
		artifacts: z
			.array(
				z
					.object({
						databaseId: z.string().regex(/^db_[A-Za-z0-9_-]{1,80}$/),
						database: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/),
						sha256: hex(64),
						bytes: z
							.number()
							.int()
							.positive()
							.max(448 * 1024 ** 2),
					})
					.strict()
			)
			.min(1)
			.max(8),
		createdAt: z.number().int().positive(),
		expiresAt: z.number().int().positive(),
	})
	.strict();
export type LifecycleBinding = z.infer<typeof lifecycleBindingSchema>;
export type LifecycleAction = 'provision' | 'inspect' | 'stop' | 'resume' | 'delete';
export const lifecycleReceiptSchema = z
	.object({
		version: z.literal(1),
		id: hex(24),
		bindingHash: hex(64),
		state: z.enum([
			'requested',
			'checking-resources',
			'provisioning-container',
			'starting-database',
			'ready',
			'stopped',
			'cleaning-up',
			'removed',
			'cleanup-required',
		]),
		code: z
			.string()
			.regex(/^[a-z][a-z0-9-]{0,79}$/)
			.nullable(),
		observedAt: z.number().int().positive(),
		sequence: z.number().int().positive(),
	})
	.strict();
type Receipt = z.infer<typeof lifecycleReceiptSchema>;
type RecordRow = {
	id: string;
	mode: string;
	binding: string;
	owner_token: string;
	action: LifecycleAction;
	state: string;
	code: string | null;
	observed_sequence: number;
};
export function lifecycleHash(binding: LifecycleBinding, token: string) {
	return crypto.createHash('sha256').update(JSON.stringify(binding)).update(token).digest('hex');
}
/** Check the actual child mount, not the parent's Compose readonly declaration.
 * Mount remount flags do not propagate to already-running namespaces. */
export function isReadonlyRecoveryMount(mountinfo: string, directory: string) {
	const matches = mountinfo
		.split('\n')
		.map(line => line.split(' - '))
		.filter(([head]) => head.split(' ')[4] === directory);
	if (matches.length !== 1 || matches[0].length !== 2) return false;
	const [head, tail] = matches[0],
		options = head.split(' ')[5].split(',');
	return (
		tail.split(' ')[0] === 'ext4' &&
		!options.includes('rw') &&
		['ro', 'nodev', 'nosuid', 'noexec'].every(option => options.includes(option))
	);
}
/** Authenticated filesystem mailbox, NOT a Docker API. Root policy/receipts are read-only to UID 10001.
 * SQLite intent commits before publication. No SQL, image, path, command or connection input crosses it. */
export class AutomaticRecoveryLifecycle {
	private readonly publishing = new Map<string, Promise<void>>();
	constructor(
		private readonly sqlite: Database.Database,
		private readonly root = LIFECYCLE_ROOT,
		private readonly requests = LIFECYCLE_REQUESTS,
		private readonly clock = Date.now
	) {}
	async trusted(name: string, max = 65536): Promise<Buffer> {
		if (
			!/^(?:capabilities\.json|[a-f0-9]{24}(?:\.receipt\.json|\.target\.json|-ca\.pem))$/.test(
				name
			) ||
			process.platform !== 'linux' ||
			process.getuid?.() !== 10001
		)
			throw new DatabaseRestoreError('lifecycle-unavailable');
		const file = path.join(this.root, name);
		for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
			const stat = await fs.lstat(parent);
			if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o022)
				throw new DatabaseRestoreError('lifecycle-unsafe');
			if (parent === path.dirname(parent)) break;
		}
		const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = await fd.stat();
			if (
				!stat.isFile() ||
				stat.uid !== 0 ||
				stat.mode & 0o027 ||
				stat.size > max ||
				stat.nlink !== 1
			)
				throw new DatabaseRestoreError('lifecycle-unsafe');
			return await fd.readFile();
		} finally {
			await fd.close();
		}
	}
	async capability() {
		try {
			const data = z
				.object({
					version: z.literal(1),
					engines: z.tuple([z.literal('mariadb'), z.literal('postgresql')]),
					maxSqlBytes: z
						.number()
						.int()
						.positive()
						.max(448 * 1024 ** 2),
					quotaBytes: z.literal(2147483648),
					maxRetentionSeconds: z
						.number()
						.int()
						.min(86400)
						.max(30 * 86400),
					observedAt: z.number().int().positive(),
				})
				.strict()
				.parse(JSON.parse((await this.trusted('capabilities.json', 2048)).toString()));
			if (data.observedAt > this.clock() + 5000 || data.observedAt < this.clock() - 30000)
				throw new Error();
			return { available: true as const, ...data };
		} catch {
			return { available: false as const };
		}
	}
	record(id: string) {
		return this.sqlite.prepare('SELECT * FROM automatic_recovery_lifecycle WHERE id=?').get(id) as
			| RecordRow
			| undefined;
	}
	assertAvailable(id = '') {
		if (
			this.sqlite
				.prepare(
					"SELECT 1 FROM automatic_recovery_lifecycle WHERE state!='removed' AND id!=? LIMIT 1"
				)
				.get(id)
		)
			throw new DatabaseRestoreError('internal-lifecycle-busy');
	}
	async cleanupRetryIds() {
		const ids = new Set<string>();
		for (const record of this.sqlite
			.prepare(
				"SELECT * FROM automatic_recovery_lifecycle WHERE mode='disposable' AND state!='removed' LIMIT 8"
			)
			.all() as RecordRow[]) {
			const row = this.sqlite
				.prepare('SELECT status,result FROM recovery_tests WHERE id=?')
				.get(record.id) as { status: string; result: string | null } | undefined;
			if (!row || ['running', 'queued'].includes(row.status)) continue;
			const result = row.result ? JSON.parse(row.result) : null;
			if (result?.cleanup?.workspace && result?.cleanup?.databases) continue;
			if ((await this.receipt(record.id))?.state === 'ready') ids.add(record.id);
		}
		return ids;
	}
	private ensure(input: LifecycleBinding, ownerToken?: string) {
		const binding = lifecycleBindingSchema.parse(input),
			json = JSON.stringify(binding);
		return this.sqlite
			.transaction(() => {
				const previous = this.record(binding.id);
				if (previous) {
					if (previous.binding !== json || (ownerToken && previous.owner_token !== ownerToken))
						throw new DatabaseRestoreError('lifecycle-binding-mismatch');
					return previous;
				}
				// Parent identity must already be durable. Never provision an unbound browser request.
				const table =
					binding.mode === 'persistent' ? 'persistent_database_restores' : 'recovery_tests';
				const parent = this.sqlite
					.prepare(`SELECT snapshot_id FROM ${table} WHERE id=?`)
					.get(binding.id) as { snapshot_id: string } | undefined;
				if (parent?.snapshot_id !== binding.snapshotId)
					throw new DatabaseRestoreError('lifecycle-binding-mismatch');
				try {
					this.sqlite
						.prepare(
							`INSERT INTO automatic_recovery_lifecycle(id,mode,binding,owner_token,created_at,updated_at) VALUES(?,?,?,?,?,?)`
						)
						.run(
							binding.id,
							binding.mode,
							json,
							ownerToken || crypto.randomBytes(24).toString('hex'),
							binding.createdAt,
							this.clock()
						);
				} catch {
					throw new DatabaseRestoreError('internal-lifecycle-busy');
				}
				return this.record(binding.id)!;
			})
			.immediate();
	}
	async persistent(
		row: DatabaseRestore,
		action: LifecycleAction,
		cleanupReady: boolean,
		replay = false
	) {
		const record = this.ensure(
			{
				id: row.id,
				mode: 'persistent',
				engine: row.artifact.engine as 'mariadb' | 'postgresql',
				snapshotId: row.snapshotId,
				artifacts: [
					{
						databaseId: row.databaseId,
						database: row.artifact.database!,
						sha256: row.artifact.sha256,
						bytes: row.artifact.bytes,
					},
				],
				createdAt: row.createdAt,
				expiresAt: row.expiresAt,
			},
			row.ownerToken
		);
		return this.publish(record, action, cleanupReady, replay);
	}
	async testing(
		id: string,
		snapshotId: string,
		entries: RecoveryDatabaseResult[],
		createdAt: number
	) {
		const engine = entries[0]?.engine;
		if (
			!['mariadb', 'postgresql'].includes(engine || '') ||
			entries.some(entry => entry.engine !== engine)
		)
			throw new DatabaseRestoreError('lifecycle-binding-mismatch');
		const record = this.ensure({
			id,
			mode: 'disposable',
			engine: engine as 'mariadb' | 'postgresql',
			snapshotId,
			artifacts: entries.map(e => ({
				databaseId: e.databaseId!,
				database: e.database!,
				sha256: e.sha256,
				bytes: e.bytes,
			})),
			createdAt,
			expiresAt: createdAt + 2 * 60 * 60_000,
		});
		await this.publish(record, 'provision', false);
	}
	async action(id: string, action: LifecycleAction, cleanupReady = false) {
		const record = this.record(id);
		if (!record) throw new DatabaseRestoreError('lifecycle-binding-mismatch');
		await this.publish(record, action, cleanupReady);
	}
	private async publish(
		record: RecordRow,
		action: LifecycleAction,
		cleanupReady: boolean,
		replay = false
	) {
		if (record.state === 'removed') return;
		// Never resurrect a cancelled intent via an old queued provision/resume request.
		if (record.action === 'delete' && action !== 'delete')
			throw new DatabaseRestoreError('lifecycle-deletion-in-progress');
		this.sqlite
			.prepare('UPDATE automatic_recovery_lifecycle SET action=?,updated_at=? WHERE id=?')
			.run(action, this.clock(), record.id);
		const previous = this.publishing.get(record.id) || Promise.resolve();
		const operation = previous
			.catch(() => {})
			.then(() => this.writeRequest(record, action, cleanupReady, replay));
		this.publishing.set(record.id, operation);
		try {
			await operation;
		} finally {
			if (this.publishing.get(record.id) === operation) this.publishing.delete(record.id);
		}
	}
	private async writeRequest(
		record: RecordRow,
		action: LifecycleAction,
		cleanupReady: boolean,
		replay: boolean
	) {
		if (this.record(record.id)?.action !== action || this.record(record.id)?.state === 'removed')
			return;
		if (!(await this.capability()).available)
			throw new DatabaseRestoreError('lifecycle-unavailable');
		const stat = await fs.lstat(this.requests);
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			stat.uid !== 10001 ||
			(stat.mode & 0o777) !== 0o700
		)
			throw new DatabaseRestoreError('lifecycle-unsafe');
		const contents = JSON.stringify({
			version: 1,
			binding: JSON.parse(record.binding),
			ownerToken: record.owner_token,
			action,
			cleanupReady,
		});
		if (replay) {
			// Periodic reconciliation must not turn a consumed Resume into a new
			// control request. Explicit authenticated actions still replace the file.
			let existing;
			try {
				existing = await fs.open(
					path.join(this.requests, record.id + '.json'),
					fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
				);
				const value = await existing.stat();
				if (
					!value.isFile() ||
					value.uid !== 10001 ||
					(value.mode & 0o777) !== 0o600 ||
					value.nlink !== 1 ||
					value.size > 8192
				)
					throw new DatabaseRestoreError('lifecycle-unsafe');
				if ((await existing.readFile('utf8')) === contents) return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			} finally {
				await existing?.close();
			}
		}
		const temporary = path.join(this.requests, crypto.randomBytes(12).toString('hex') + '.tmp');
		try {
			const fd = await fs.open(temporary, 'wx', 0o600);
			try {
				await fd.writeFile(contents);
				await fd.sync();
			} finally {
				await fd.close();
			}
			if (this.record(record.id)?.action !== action || this.record(record.id)?.state === 'removed')
				return;
			await fs.rename(temporary, path.join(this.requests, record.id + '.json'));
		} finally {
			await fs.rm(temporary, { force: true });
		}
	}
	async receipt(id: string): Promise<Receipt | null> {
		const record = this.record(id);
		if (!record) return null;
		try {
			const value = lifecycleReceiptSchema.parse(
				JSON.parse((await this.trusted(id + '.receipt.json', 2048)).toString())
			);
			if (
				value.id !== id ||
				value.bindingHash !== lifecycleHash(JSON.parse(record.binding), record.owner_token) ||
				value.observedAt > this.clock() + 5000
			)
				throw new Error();
			const current = this.record(id)!;
			if (
				current.observed_sequence > value.sequence ||
				(current.state === 'removed' && value.state !== 'removed') ||
				(current.observed_sequence === value.sequence && current.state !== value.state)
			)
				return null;
			this.sqlite
				.prepare(
					'UPDATE automatic_recovery_lifecycle SET state=?,code=?,updated_at=?,observed_sequence=? WHERE id=? AND observed_sequence<=?'
				)
				.run(value.state, value.code, this.clock(), value.sequence, id, value.sequence);
			if (value.state === 'removed') {
				const file = path.join(this.requests, id + '.json');
				try {
					const stat = await fs.lstat(file);
					if (
						stat.isFile() &&
						!stat.isSymbolicLink() &&
						stat.uid === 10001 &&
						(stat.mode & 0o777) === 0o600 &&
						stat.nlink === 1
					)
						await fs.unlink(file);
				} catch {
					/* A missing request is already reconciled. */
				}
			}
			return value;
		} catch {
			return null;
		}
	}
	async target(id: string, cleanup = false) {
		const record = this.record(id);
		if (!record || record.mode !== 'disposable')
			throw new DatabaseRestoreError('lifecycle-binding-mismatch');
		const binding: LifecycleBinding = JSON.parse(record.binding);
		const receipt = await this.receipt(id);
		if (receipt?.state !== 'ready' || (!cleanup && binding.expiresAt <= this.clock()))
			throw new DatabaseRestoreError('lifecycle-target-not-ready');
		const value = z
			.object({
				version: z.literal(1),
				id: hex(24),
				engine: z.enum(['mariadb', 'postgresql']),
				target: recoveryTargetSchema,
				installationId: hex(32),
				activationId: hex(32),
				caSha256: hex(64),
				containerId: hex(64),
				bindingHash: hex(64),
				storage: z
					.object({
						id: z.string().regex(/^[a-f0-9-]{32,36}$/),
						kind: z.literal('fixed-ext4'),
						quotaBytes: z.literal(2147483648),
					})
					.strict(),
			})
			.strict()
			.parse(JSON.parse((await this.trusted(id + '.target.json')).toString()));
		if (
			value.id !== id ||
			value.bindingHash !== receipt.bindingHash ||
			value.engine !== binding.engine ||
			value.target.engine !== binding.engine ||
			value.target.host !== 'persistent-db-' + id ||
			value.target.port !== (binding.engine === 'mariadb' ? 3306 : 5432) ||
			value.target.tls !== 'verify-identity' ||
			value.target.username !== 'restore_user' ||
			!value.target.enabled ||
			!value.target.password
		)
			throw new DatabaseRestoreError('lifecycle-binding-mismatch');
		const ca = await this.trusted(id + '-ca.pem', 16384);
		if (crypto.createHash('sha256').update(ca).digest('hex') !== value.caSha256)
			throw new DatabaseRestoreError('lifecycle-tls-binding-mismatch');
		return {
			...value,
			target: { ...value.target, password: value.target.password },
			caFile: path.join(this.root, id + '-ca.pem'),
		};
	}
	async waitReady(id: string, signal: AbortSignal, stage: (value: string) => void) {
		const deadline = this.clock() + 180000;
		while (this.clock() < deadline) {
			signal.throwIfAborted();
			const receipt = await this.receipt(id);
			if (receipt) {
				stage(receipt.state);
				if (receipt.state === 'ready') return this.target(id);
				if (['cleanup-required', 'removed', 'stopped'].includes(receipt.state))
					throw new DatabaseRestoreError(receipt.code || 'lifecycle-target-not-ready');
			}
			await pause(250, undefined, { signal });
		}
		throw new DatabaseRestoreError('lifecycle-readiness-timeout');
	}
	async verifyStorage(
		id: string,
		storage: { id: string; quotaBytes: number },
		activationId: string
	) {
		if (!this.record(id) || !/^[a-f0-9]{24}$/.test(id))
			throw new DatabaseRestoreError('lifecycle-binding-mismatch');
		const root = '/run/pluton-automatic-storage',
			directory = path.join(root, id);
		let mountinfo: string;
		try {
			mountinfo = await fs.readFile('/proc/self/mountinfo', 'utf8');
		} catch {
			throw new DatabaseRestoreError('lifecycle-storage-unverified');
		}
		if (!isReadonlyRecoveryMount(mountinfo, directory))
			throw new DatabaseRestoreError('lifecycle-storage-unverified');
		const stat = await fs.lstat(directory),
			parent = await fs.lstat(root);
		if (
			!parent.isDirectory() ||
			parent.isSymbolicLink() ||
			parent.uid !== 0 ||
			parent.mode & 0o022 ||
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			stat.uid !== 0 ||
			stat.mode & 0o022 ||
			stat.dev === parent.dev ||
			(await fs.realpath(directory)) !== directory
		)
			throw new DatabaseRestoreError('lifecycle-storage-unverified');
		const handle = await fs.open(
			path.join(directory, 'identity.json'),
			constants.O_RDONLY | constants.O_NOFOLLOW
		);
		try {
			const st = await handle.stat();
			if (!st.isFile() || st.uid !== 0 || (st.mode & 0o777) !== 0o444 || st.size > 4096)
				throw new Error();
			const anchor = JSON.parse(await handle.readFile('utf8'));
			if (
				anchor.restoreId !== id ||
				anchor.storageId !== storage.id ||
				anchor.activationId !== activationId
			)
				throw new Error();
		} finally {
			await handle.close();
		}
		const disk = await fs.statfs(directory);
		if (disk.type !== 0xef53 || disk.bsize * disk.blocks > storage.quotaBytes)
			throw new DatabaseRestoreError('lifecycle-storage-unverified');
	}
	/** Interrupted imports are never retried. Empty pre-import intents can be cancelled safely;
	 * existing SQL leases must still pass the original native ownership cleanup first. */
	async reconcileTesting() {
		for (const record of this.sqlite
			.prepare(
				"SELECT * FROM automatic_recovery_lifecycle WHERE mode='disposable' AND state!='removed' LIMIT 8"
			)
			.all() as RecordRow[]) {
			const receipt = await this.receipt(record.id);
			const row = this.sqlite
				.prepare('SELECT status,result FROM recovery_tests WHERE id=?')
				.get(record.id) as { status: string; result: string | null } | undefined;
			if (!row || ['queued', 'running'].includes(row.status)) continue;
			const lease = this.sqlite
				.prepare('SELECT 1 FROM internal_recovery_import_leases WHERE test_id=? LIMIT 1')
				.get(record.id);
			const result = row.result ? JSON.parse(row.result) : null;
			if (receipt?.state === 'removed' && result) {
				result.cleanup.infrastructure = true;
				this.sqlite
					.prepare('UPDATE recovery_tests SET result=? WHERE id=?')
					.run(JSON.stringify(result), record.id);
				continue;
			}
			if (!lease && result?.cleanup?.workspace && result?.cleanup?.databases)
				try {
					await this.action(record.id, 'delete', true);
				} catch {
					/* Remains durable and visible. */
				}
		}
	}
}

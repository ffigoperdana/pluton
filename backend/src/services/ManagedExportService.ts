import { Readable, Writable } from 'stream';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import type { RemoteRepositoryRecoveryService } from './RemoteRepositoryRecoveryService';
import { ManagedExportStore } from '../stores/ManagedExportStore';
import { S3ExportStorage } from '../utils/managedExport/S3ExportStorage';
import {
	EXPORT_LIMITS,
	TemporaryExportError,
	ExportPreflightError,
	activeExport,
	bindingDigest,
	exportRange,
	exportFileName,
	type ExportConfig,
	type ExportJob,
} from '../utils/managedExport/ExportPolicy';
import {
	managedExportMode,
	ManagedExportError,
	type ManagedExportMode,
} from '../utils/restic/ManagedExportPolicy';
import { ManagedRepositoryAccessError } from '../utils/restic/ManagedSftpRepositorySession';
import { SnapshotIndexError } from '../utils/restic/ManagedSnapshotIndex';
import { AppError } from '../utils/AppError';
import { planLogger } from '../utils/logger';

/** One durable exporter per process. Credentials come only from the separate
 * server configuration; queued JSON never contains provider credentials or URLs. */
export class ManagedExportService {
	private active?: { id: string; controller: AbortController; done: Promise<void> };
	private stopped = false;
	private ticking?: Promise<void>;
	private downloads = 0;
	private grants = 0;
	private closed = false;
	private workerFault = false;
	private readonly cleanups = new Map<string, Promise<void>>();
	constructor(
		readonly store: ManagedExportStore,
		private readonly recovery: Pick<
			RemoteRepositoryRecoveryService,
			'exportBindingFor' | 'withVerifiedExport'
		>,
		private readonly configuration: () => ExportConfig | undefined,
		private readonly isolated: (c: ExportConfig) => Promise<void>,
		private readonly storageFactory = (c: ExportConfig) => new S3ExportStorage(c)
	) {}
	private config(job?: ExportJob) {
		const c = this.configuration();
		if (!c) throw new TemporaryExportError('not-configured');
		if (job && job.destination !== c.fingerprint) throw new TemporaryExportError('binding-changed');
		return c;
	}
	private safeLog(record: Record<string, string | number | boolean>) {
		try {
			planLogger('temporary-export').info(
				{ event: 'temporary_export', ...record },
				'Managed temporary export.'
			);
		} catch {
			/* Telemetry cannot authorize/fail data work. */
		}
	}
	async admit(owner: string, backupId: string, mode: ManagedExportMode) {
		if (this.stopped || this.workerFault) throw new TemporaryExportError('interrupted');
		const c = this.config();
		await this.isolated(c);
		const binding = await this.recovery.exportBindingFor(backupId, managedExportMode(mode));
		const job = this.store.admit(owner, binding, c);
		this.schedule();
		this.safeLog({ stage: 'admitted', state: job.state });
		return this.public(job);
	}
	async preflight(owner: string) {
		if (this.stopped || this.workerFault) throw new TemporaryExportError('interrupted');
		const c = this.config();
		await this.isolated(c);
		const identity = crypto.randomUUID();
		const job = this.store.admit(
			owner,
			{
				backupId: `preflight-${identity}`,
				planId: 'preflight',
				sourceId: 'preflight',
				repositoryId: 'preflight',
				snapshotId: crypto.randomBytes(32).toString('hex'),
				mode: 'full',
			},
			c
		);
		this.store.update(job.id, { kind: 'preflight', preflightChecks: ['destination-isolation'] });
		this.schedule();
		return this.public(this.store.get(job.id)!);
	}
	async preflightStatus(owner: string, id: string) {
		const job = this.store.get(id);
		if (!job || job.kind !== 'preflight' || job.owner !== owner)
			throw new AppError(404, 'Preflight not found.');
		return this.public(job);
	}
	async cancelPreflight(owner: string, id: string) {
		await this.preflightStatus(owner, id);
		const job = this.store.update(id, { state: 'cancelled', failure: 'cancelled' });
		if (this.active?.id === id) this.active.controller.abort();
		else setImmediate(() => void this.cleanup(job, true).catch(() => this.metadataFault()));
		return this.public(this.store.get(id)!);
	}
	private async owned(owner: string, backupId: string, id: string) {
		if (!/^[a-f0-9-]{36}$/.test(id)) throw new AppError(404, 'Export not found.');
		const job = this.store.get(id);
		if (!job || job.owner !== owner || job.binding.backupId !== backupId)
			throw new AppError(404, 'Export not found.');
		if (
			bindingDigest(await this.recovery.exportBindingFor(backupId, job.binding.mode)) !==
			bindingDigest(job.binding)
		)
			throw new TemporaryExportError('binding-changed');
		return job;
	}
	private public(job: ExportJob) {
		const elapsed = Math.max(
			0,
			(activeExport(job.state) ? Date.now() : job.updatedAt) - job.createdAt
		);
		return {
			id: job.id,
			kind: job.kind || 'archive',
			state: job.state,
			mode: job.binding.mode,
			snapshotId: job.binding.snapshotId,
			createdAt: job.createdAt,
			elapsedMs: elapsed,
			processedBytes: job.processedBytes,
			uploadedBytes: job.uploadedBytes,
			totalBytes: job.summary?.archiveBytes,
			averageBytesPerSecond: job.uploadStartedAt
				? Math.round(
						(job.uploadedBytes * 1000) /
							Math.max(
								1,
								(job.uploadFinishedAt || (activeExport(job.state) ? Date.now() : job.updatedAt)) -
									job.uploadStartedAt
							)
					)
				: 0,
			expiresAt: job.expiresAt,
			integrity: job.state === 'ready' ? 'verified' : 'pending',
			summary: job.state === 'ready' ? job.summary : undefined,
			failure: job.failure,
			failureStage: job.failureStage,
			failureDetail: job.failureDetail,
			preflightChecks: job.preflightChecks,
			failureCapability: job.failureCapability,
			failureCategory: job.failureCategory,
			failureHttpStatus: job.failureHttpStatus,
			cleanupPending: !job.cleaned && ['failed', 'cancelled', 'expired'].includes(job.state),
		};
	}
	async status(owner: string, backupId: string, id: string) {
		let job = await this.owned(owner, backupId, id);
		if (job.state === 'ready' && (job.expiresAt || 0) <= Date.now()) {
			job = this.store.update(id, { state: 'expired', failure: 'expired' });
			this.schedule();
		}
		return this.public(job);
	}
	async cancel(owner: string, backupId: string, id: string) {
		let job = await this.owned(owner, backupId, id);
		job = this.store.update(id, { state: 'cancelled', failure: 'cancelled' });
		if (this.active?.id === id) this.active.controller.abort();
		else setImmediate(() => void this.cleanup(job, true).catch(() => this.metadataFault()));
		return this.public(this.store.get(id)!);
	}
	private async ready(owner: string, backupId: string, id: string, signal: AbortSignal) {
		const job = await this.owned(owner, backupId, id);
		if (
			job.state !== 'ready' ||
			!job.summary ||
			!job.versionId ||
			!job.etag ||
			(job.expiresAt || 0) <= Date.now()
		)
			throw new TemporaryExportError('expired');
		const c = this.config(job);
		await this.isolated(c);
		const storage = this.storageFactory(c);
		try {
			await storage.identity(job, signal);
			const current = this.store.get(job.id);
			if (
				current?.state !== 'ready' ||
				current.versionId !== job.versionId ||
				(current.expiresAt || 0) <= Date.now()
			)
				throw new TemporaryExportError('expired');
			return { job, storage };
		} catch (error) {
			storage.close();
			if (error instanceof TemporaryExportError && error.reason === 'expired') throw error;
			const mismatch =
				(error instanceof TemporaryExportError &&
					['object-mismatch', 'security-capability-missing', 'binding-changed'].includes(
						error.reason
					)) ||
				(error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;
			if (mismatch && this.store.get(job.id)?.state === 'ready') {
				this.store.update(job.id, {
					state: 'failed',
					failure: error instanceof TemporaryExportError ? error.reason : 'object-mismatch',
					failureStage: 'object-verification',
				});
				this.schedule();
			}
			throw new TemporaryExportError(mismatch ? 'object-mismatch' : 'storage-unavailable');
		}
	}
	async authorize(owner: string, backupId: string, id: string) {
		if (this.grants >= 2) throw new TemporaryExportError('queue-full');
		this.grants++;
		try {
			const { job, storage } = await this.ready(owner, backupId, id, AbortSignal.timeout(30_000));
			try {
				const seconds = Math.min(
					EXPORT_LIMITS.authorizationSeconds,
					Math.floor((job.expiresAt! - Date.now()) / 1000)
				);
				if (seconds < 1) throw new TemporaryExportError('expired');
				const url = await storage.authorize(job, seconds);
				if (this.store.get(job.id)?.state !== 'ready') throw new TemporaryExportError('expired');
				return {
					url,
					expiresAt: Date.now() + seconds * 1000,
					bytes: job.summary!.archiveBytes,
					sha256: job.summary!.archiveSha256,
					etag: job.etag,
				};
			} finally {
				storage.close();
			}
		} finally {
			this.grants--;
		}
	}
	async content(
		owner: string,
		backupId: string,
		id: string,
		range: unknown,
		ifRange: unknown,
		headOnly: boolean,
		destination: Writable,
		signal: AbortSignal,
		headers: (value: {
			status: number;
			length: number;
			size: number;
			start: number;
			end: number;
			etag: string;
			sha256: string;
			fileName: string;
		}) => void
	) {
		if (this.downloads >= 2) throw new TemporaryExportError('queue-full');
		this.downloads++;
		let storage: S3ExportStorage | undefined;
		try {
			const ready = await this.ready(owner, backupId, id, signal);
			storage = ready.storage;
			const job = ready.job;
			const etag = `"sha256-${job.summary!.archiveSha256}"`,
				size = job.summary!.archiveBytes;
			const selection = exportRange(range, ifRange, size, etag);
			if (headOnly) {
				headers({
					...selection,
					length: selection.end - selection.start + 1,
					size,
					etag,
					sha256: job.summary!.archiveSha256,
					fileName: exportFileName(job),
				});
				return;
			}
			const result = await storage.get(
				job,
				signal,
				selection.status === 206 ? `bytes=${selection.start}-${selection.end}` : undefined
			);
			if (
				!result.Body ||
				result.ContentLength !== selection.end - selection.start + 1 ||
				(selection.status === 206 &&
					(result.$metadata.httpStatusCode !== 206 ||
						result.ContentRange !== `bytes ${selection.start}-${selection.end}/${size}`))
			) {
				(result.Body as Readable)?.destroy();
				throw new TemporaryExportError('object-mismatch');
			}
			headers({
				...selection,
				length: selection.end - selection.start + 1,
				size,
				etag,
				sha256: job.summary!.archiveSha256,
				fileName: exportFileName(job),
			});
			await pipeline(result.Body as Readable, destination, { end: false, signal });
		} finally {
			storage?.close();
			this.downloads--;
		}
	}
	async recoverInterrupted() {
		try {
			for (const job of this.store.all())
				if (activeExport(job.state))
					this.store.update(job.id, { state: 'failed', failure: 'interrupted' });
		} catch {
			this.metadataFault();
			return;
		}
		this.schedule();
	}
	private metadataFault() {
		if (!this.workerFault)
			this.safeLog({ stage: 'worker-stopped', reason: 'metadata-unavailable' });
		this.workerFault = true;
	}
	private schedule() {
		setImmediate(() => {
			if (!this.stopped && !this.workerFault) void this.tick().catch(() => this.metadataFault());
		});
	}
	tick(): Promise<void> {
		if (this.ticking) return this.ticking;
		this.ticking = this.sweep().finally(() => {
			this.ticking = undefined;
		});
		return this.ticking;
	}
	private async sweep() {
		if (this.stopped || this.workerFault) return;
		for (const original of this.store.all()) {
			let j = original;
			if (j.state === 'ready' && (j.expiresAt || 0) <= Date.now())
				j = this.store.update(j.id, { state: 'expired', failure: 'expired' });
			if (
				!j.cleaned &&
				['failed', 'cancelled', 'expired'].includes(j.state) &&
				this.active?.id !== j.id &&
				j.cleanupAttempts < 10
			)
				await this.cleanup(j);
		}
		if (!this.active) {
			const next = this.store.all().find(j => j.state === 'queued');
			if (next) {
				const controller = new AbortController();
				const done = this.run(next, controller.signal)
					.catch(() => this.metadataFault())
					.finally(() => {
						this.active = undefined;
						if (!this.stopped && !this.workerFault) this.schedule();
					});
				this.active = { id: next.id, controller, done };
			}
		}
	}
	private cleanup(job: ExportJob, explicit = false): Promise<void> {
		if (this.closed) return Promise.resolve();
		const current = this.cleanups.get(job.id);
		if (current) return current;
		const done = this.performCleanup(job, explicit).finally(() => this.cleanups.delete(job.id));
		this.cleanups.set(job.id, done);
		return done;
	}
	private async performCleanup(job: ExportJob, explicit = false) {
		if (job.cleaned || (!explicit && job.cleanupAttempts >= 10)) return;
		let storage: S3ExportStorage | undefined;
		this.store.update(job.id, { cleanupAttempts: job.cleanupAttempts + 1 });
		try {
			const c = this.config(job);
			storage = this.storageFactory(c);
			await storage.cleanup(job, AbortSignal.timeout(60_000));
			this.store.update(job.id, {
				cleaned: true,
				reservedBytes: 0,
				uploadId: undefined,
				probeUploadId: undefined,
			});
			this.safeLog({ stage: 'cleanup', success: true });
		} catch {
			this.safeLog({ stage: 'cleanup', success: false });
		} finally {
			storage?.close();
		}
	}
	private async run(original: ExportJob, signal: AbortSignal) {
		let stage: ExportJob['failureStage'] = 'preflight';
		const deadline = AbortSignal.timeout(EXPORT_LIMITS.deadlineMs),
			bounded = AbortSignal.any([signal, deadline]);
		let storage: S3ExportStorage | undefined;
		try {
			const c = this.config(original);
			await this.isolated(c);
			bounded.throwIfAborted();
			storage = this.storageFactory(c);
			let job = this.store.update(original.id, {
				state: 'validating',
				preflightChecks: ['destination-isolation'],
			});
			await storage.preflight(
				job,
				AbortSignal.any([bounded, AbortSignal.timeout(60_000)]),
				fields => this.store.update(job.id, fields)
			);
			if (original.kind === 'preflight') {
				bounded.throwIfAborted();
				this.store.update(job.id, {
					state: 'ready',
					cleaned: true,
					reservedBytes: 0,
					expiresAt: Date.now() + 15 * 60_000,
				});
				this.safeLog({ stage: 'preflight-passed', jobId: job.id });
				return;
			}
			stage = 'archive-validation';
			await this.recovery.withVerifiedExport(job.binding, bounded, async archive => {
				bounded.throwIfAborted();
				const proof = archive.export;
				if (
					!proof ||
					proof.mode !== job.binding.mode ||
					proof.binding.backupId !== job.binding.backupId ||
					proof.binding.repositoryId !== job.binding.repositoryId ||
					proof.binding.snapshotId !== job.binding.snapshotId
				)
					throw new TemporaryExportError('object-mismatch');
				this.store.reserve(job.id, archive.export.archiveBytes);
				job = this.store.update(job.id, { state: 'exporting', summary: archive.export });
				stage = 'upload';
				await storage!.upload(job, archive, bounded, fields => {
					const latest = this.store.get(job.id)!;
					if (latest.state === 'cancelled') throw new TemporaryExportError('cancelled');
					this.store.update(job.id, fields);
				});
				job = this.store.get(job.id)!;
				stage = 'object-verification';
				await storage!.verify(job, bounded);
			});
			bounded.throwIfAborted();
			stage = 'binding-validation';
			await this.isolated(c);
			if (
				bindingDigest(
					await this.recovery.exportBindingFor(job.binding.backupId, job.binding.mode)
				) !== bindingDigest(job.binding)
			)
				throw new TemporaryExportError('binding-changed');
			// Cancellation may arrive during the final asynchronous binding check.
			// Publication must never resurrect a cancelled or cleaned export.
			bounded.throwIfAborted();
			if (this.store.get(job.id)?.state !== 'verifying')
				throw new TemporaryExportError('cancelled');
			this.store.update(job.id, { state: 'ready', expiresAt: Date.now() + c.ttlSeconds * 1000 });
			this.safeLog({ stage: 'verified', bytes: job.summary!.archiveBytes, success: true });
		} catch (error) {
			const job = this.store.get(original.id)!;
			const reason = this.stopped
				? 'interrupted'
				: signal.aborted || job.state === 'cancelled'
					? 'cancelled'
					: error instanceof TemporaryExportError
						? error.reason
						: bounded.aborted
							? 'interrupted'
							: error instanceof ManagedExportError ||
								  error instanceof ManagedRepositoryAccessError ||
								  stage === 'archive-validation'
								? 'archive-refused'
								: 'storage-unavailable';
			this.store.update(job.id, {
				state: reason === 'cancelled' ? 'cancelled' : 'failed',
				failure: reason,
				failureStage: stage,
				failureCapability: error instanceof ExportPreflightError ? error.capability : undefined,
				failureCategory: error instanceof ExportPreflightError ? error.category : undefined,
				failureHttpStatus: error instanceof ExportPreflightError ? error.httpStatus : undefined,
				uploadFinishedAt: job.uploadFinishedAt || (job.uploadStartedAt ? Date.now() : undefined),
				failureDetail:
					error instanceof SnapshotIndexError || error instanceof ManagedExportError
						? error.reason
						: error instanceof ManagedRepositoryAccessError
							? error.code
							: undefined,
			});
			await this.cleanup(this.store.get(job.id)!);
			this.safeLog({ stage: 'failed', phase: stage, reason, jobId: job.id });
		} finally {
			storage?.close();
		}
	}
	async shutdown() {
		this.stopped = true;
		this.active?.controller.abort();
		await this.active?.done;
		await this.ticking;
		await Promise.allSettled(this.cleanups.values());
		this.closed = true;
		this.store.close();
	}
}

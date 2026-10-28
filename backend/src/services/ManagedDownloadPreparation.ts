import crypto from 'crypto';
import { AppError } from '../utils/AppError';
import { SnapshotIndexError } from '../utils/restic/ManagedSnapshotIndex';
import { ManagedRepositoryAccessError } from '../utils/restic/ManagedSftpRepositorySession';
import {
	ManagedExportError,
	type ManagedExportMode,
	type ManagedExportSummary,
} from '../utils/restic/ManagedExportPolicy';

export type PreparationState =
	| 'queued'
	| 'indexing'
	| 'validating'
	| 'ready'
	| 'failed'
	| 'cancelled'
	| 'expired';
export type PreparationStatus = {
	id: string;
	state: PreparationState;
	createdAt: number;
	elapsedMs: number;
	indexedEntries: number;
	validatedEntries: number;
	retryAfterMs: number;
	error?: string;
	code?: string;
	reason?: string;
	failureStatus?: number;
	exportMode: ManagedExportMode;
	export?: ManagedExportSummary;
};
type Job = {
	id: string;
	key: string;
	state: PreparationState;
	createdAt: number;
	finishedAt?: number;
	controller: AbortController;
	exportMode: ManagedExportMode;
	export?: ManagedExportSummary;
	run: (
		signal: AbortSignal,
		stage: (state: 'indexing' | 'validating') => void
	) => Promise<string | { proof: string; export: ManagedExportSummary }>;
	done?: Promise<void>;
	proof?: string;
	error?: string;
	code?: string;
	reason?: string;
	failureStatus?: number;
};

/** Disposable preparation metadata only. Restart invalidates all proofs; no credentials
 * or ready claims are persisted. One worker, four admitted jobs, 32 retained statuses. */
export class ManagedDownloadPreparation {
	private readonly jobs = new Map<string, Job>();
	private active?: Job;
	private closed = false;
	private readonly timer: ReturnType<typeof setInterval>;
	constructor(private readonly now = Date.now) {
		this.timer = setInterval(() => this.sweep(), 1000);
		this.timer.unref();
	}
	start(
		key: string,
		run: Job['run'],
		validProof: (proof: string) => boolean,
		exportMode: ManagedExportMode = 'full'
	): Job {
		this.sweep();
		if (this.closed) throw new AppError(503, 'Download preparation is shutting down.');
		const existing = [...this.jobs.values()].find(
			job => job.key === key && ['queued', 'indexing', 'validating', 'ready'].includes(job.state)
		);
		if (existing?.state === 'ready' && (!existing.proof || !validProof(existing.proof)))
			this.expire(existing);
		else if (existing) return existing;
		if (
			[...this.jobs.values()].filter(job =>
				['queued', 'indexing', 'validating'].includes(job.state)
			).length >= 4
		)
			throw new AppError(
				429,
				'Download preparation is busy. Retry after another preparation finishes.'
			);
		if (this.jobs.size >= 32) {
			const old = [...this.jobs.values()].find(
				job => job !== this.active && !['queued', 'indexing', 'validating'].includes(job.state)
			);
			if (!old) throw new AppError(429, 'Download preparation is busy.');
			this.jobs.delete(old.id);
		}
		const job: Job = {
			id: crypto.randomUUID(),
			key,
			state: 'queued',
			createdAt: this.now(),
			controller: new AbortController(),
			exportMode,
			run,
		};
		this.jobs.set(job.id, job);
		// Never execute work on the HTTP admission stack.
		setImmediate(() => this.pump());
		return job;
	}
	get(key: string, id: string) {
		if (!/^[a-f0-9-]{36}$/.test(id)) throw new AppError(400, 'Invalid preparation identity.');
		this.sweep();
		const job = this.jobs.get(id);
		if (job && job.key !== key) throw new AppError(404, 'Download preparation not found.');
		return job;
	}
	expire(job: Job) {
		job.state = 'expired';
		job.finishedAt ||= this.now();
		job.controller.abort();
		job.proof = undefined;
		if (job !== this.active) job.run = async () => '';
	}
	cancel(job: Job) {
		if (['queued', 'indexing', 'validating', 'ready'].includes(job.state)) {
			job.state = 'cancelled';
			job.finishedAt = this.now();
			job.controller.abort();
			job.proof = undefined;
			if (job !== this.active) job.run = async () => '';
		}
	}
	status(
		job: Job | undefined,
		id: string,
		entries = 0,
		exportMode: ManagedExportMode = 'full'
	): PreparationStatus {
		return {
			id,
			state: job?.state || 'expired',
			createdAt: job?.createdAt || this.now(),
			elapsedMs: job ? Math.max(0, (job.finishedAt || this.now()) - job.createdAt) : 0,
			indexedEntries: entries,
			validatedEntries: job?.state === 'ready' ? (job.export?.includedEntries ?? entries) : 0,
			retryAfterMs:
				!job || ['ready', 'failed', 'cancelled', 'expired'].includes(job.state)
					? 0
					: Math.min(5000, 1000 + Math.floor((this.now() - job.createdAt) / 30_000) * 1000),
			error: job?.error,
			code: job?.code,
			reason: job?.reason,
			failureStatus: job?.failureStatus,
			exportMode: job?.exportMode || exportMode,
			export: job?.state === 'ready' ? job.export : undefined,
		};
	}
	private sweep() {
		for (const job of this.jobs.values()) {
			if (
				['queued', 'indexing', 'validating'].includes(job.state) &&
				this.now() - job.createdAt >= 30 * 60_000
			)
				this.expire(job);
			if (job.state === 'ready' && this.now() - job.finishedAt! >= 2 * 60_000) this.expire(job);
			if (job !== this.active && job.finishedAt && this.now() - job.finishedAt >= 15 * 60_000)
				this.jobs.delete(job.id);
		}
	}
	private pump() {
		if (this.closed || this.active) return;
		const job = [...this.jobs.values()].find(value => value.state === 'queued');
		if (!job) return;
		this.active = job;
		job.done = (async () => {
			try {
				const result = await job.run(job.controller.signal, state => {
					if (!job.controller.signal.aborted) job.state = state;
				});
				if (!job.controller.signal.aborted) {
					job.proof = typeof result === 'string' ? result : result.proof;
					job.export = typeof result === 'string' ? undefined : result.export;
					job.state = 'ready';
				}
			} catch (error) {
				if (!job.controller.signal.aborted) {
					job.state = 'failed';
					job.error =
						error instanceof AppError
							? error.message
							: 'Download preparation failed. Retry preparation.';
					job.failureStatus = error instanceof AppError ? error.statusCode : 500;
					if (
						error instanceof SnapshotIndexError ||
						error instanceof ManagedRepositoryAccessError ||
						error instanceof ManagedExportError
					) {
						job.code = error.code;
						job.reason = error.reason;
					}
				}
			} finally {
				job.finishedAt = this.now();
				// Release the closure holding the exact context and credentials.
				job.run = async () => '';
				this.active = undefined;
				this.pump();
			}
		})();
	}
	async close() {
		this.closed = true;
		clearInterval(this.timer);
		for (const job of this.jobs.values()) this.cancel(job);
		await this.active?.done;
		this.jobs.clear();
	}
}

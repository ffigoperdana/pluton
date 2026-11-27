import { planLogger } from '../utils/logger';
import type { PreparedIndexAdmission } from './RemoteRepositoryRecoveryService';

/**
 * Prepares the Browse index of large managed snapshots in the background after a
 * backup, so Browse opens without waiting (docs/MANAGED_SNAPSHOT_STREAMING.md,
 * "Prepared indexes").
 *
 * Backups always come first. Preparation reads the repository with `--no-lock` and
 * shares no lock or repository session with a backup, which runs on the Agent, but
 * it does share the storage server and this server. So a preparation starts only
 * while no backup is in progress and no replication transfer runs, one at a time,
 * and a running preparation is stopped and queued again when a backup or
 * replication starts. A request from Browse, a download or a restore also stops it
 * (ManagedSnapshotIndexCache). A stopped build keeps what Restic already cached.
 */
export const PREPARED_INDEX_QUEUE_LIMITS = Object.freeze({
	maxQueued: 64,
	/** After a restart, the latest backups are queued again once the server settles. */
	startupDelayMs: 2 * 60_000,
	/** How often the queue checks for activity and starts the next preparation. */
	tickMs: 30_000,
});

/** Called by RemoteBackupService when a managed backup completes. */
export type PreparedIndexHook = { enqueue(backupId: string): void };

export type PreparedIndexRecovery = {
	prepareSnapshotIndex(backupId: string): Promise<PreparedIndexAdmission>;
	preemptPreparedIndex(key: string): Promise<boolean>;
};

export type PreparedIndexActivity = {
	/** True while a managed backup is in progress or a replication transfer runs. */
	busy(): Promise<boolean>;
	/** The latest completed backup of each plan, for reconciliation after a restart. */
	latestBackups(): Promise<string[]>;
};

/** Closed record: a backup ID, a stage and a closed reason; no path or credential. */
export type PreparedIndexDiagnostic = {
	event: 'prepared_snapshot_index';
	stage: 'queued' | 'started' | 'ready' | 'failed' | 'skipped' | 'requeued' | 'dropped';
	backupId: string;
	reason?: string;
	queued: number;
};

const BACKUP_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class PreparedSnapshotIndexService implements PreparedIndexHook {
	private readonly queue: string[] = [];
	private running?: { backupId: string; key: string };
	private ticking = false;
	private closed = false;

	constructor(
		private readonly recovery: PreparedIndexRecovery,
		private readonly activity: PreparedIndexActivity,
		private readonly report: (record: PreparedIndexDiagnostic) => void = record =>
			planLogger('prepared-snapshot-index').info(record, 'Prepared snapshot index lifecycle.'),
		private readonly limits = PREPARED_INDEX_QUEUE_LIMITS
	) {}

	/** Queues a backup once; the oldest entry is dropped when the queue is full. */
	enqueue(backupId: string) {
		if (this.closed || !BACKUP_ID.test(backupId)) return;
		if (this.running?.backupId === backupId || this.queue.includes(backupId)) return;
		if (this.queue.length >= this.limits.maxQueued) {
			const dropped = this.queue.shift()!;
			this.emit('dropped', dropped, 'queue-full');
		}
		this.queue.push(backupId);
		this.emit('queued', backupId);
	}

	/** Queues the latest backup of each plan again, for example after a restart. */
	async reconcile() {
		const latest = await this.activity.latestBackups().catch(() => [] as string[]);
		for (const backupId of latest) this.enqueue(backupId);
	}

	/** One bounded step, run on an interval; it never overlaps itself. */
	async tick() {
		if (this.ticking || this.closed || (!this.running && !this.queue.length)) return;
		this.ticking = true;
		try {
			// An unknown activity state counts as busy: backups come first.
			const busy = await this.activity.busy().catch(() => true);
			if (this.running) {
				// Its result handler queues it again once the stop has settled.
				if (busy) await this.recovery.preemptPreparedIndex(this.running.key);
				return;
			}
			if (busy || !this.queue.length) return;
			const backupId = this.queue.shift()!;
			const admission = await this.recovery
				.prepareSnapshotIndex(backupId)
				.catch((): PreparedIndexAdmission => ({ status: 'failed' }));
			if (admission.status === 'busy') {
				// Another index is building (Browse or a download): retry on a later tick.
				this.queue.unshift(backupId);
				return;
			}
			if (admission.status === 'skipped') {
				this.emit('skipped', backupId, admission.reason);
				return;
			}
			if (admission.status === 'failed') {
				this.emit('failed', backupId);
				return;
			}
			this.running = { backupId, key: admission.key };
			this.emit('started', backupId);
			void admission.result
				.catch(() => 'failed' as const)
				.then(outcome => {
					if (this.running?.backupId === backupId) this.running = undefined;
					if (outcome === 'cancelled') {
						if (!this.closed && !this.queue.includes(backupId)) this.queue.unshift(backupId);
						this.emit('requeued', backupId, 'preempted');
					} else this.emit(outcome, backupId);
				});
		} finally {
			this.ticking = false;
		}
	}

	/** Stops queuing; a running build is stopped by the index cache's own shutdown. */
	close() {
		this.closed = true;
		this.queue.length = 0;
	}

	private emit(stage: PreparedIndexDiagnostic['stage'], backupId: string, reason?: string) {
		try {
			this.report({
				event: 'prepared_snapshot_index',
				stage,
				backupId,
				...(reason ? { reason } : {}),
				queued: this.queue.length,
			});
		} catch {
			/* Observability never stops the queue. */
		}
	}
}

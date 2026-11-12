import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AssistedRecoveryStore } from '../../src/stores/AssistedRecoveryStore';
import { AssistedRecoveryService } from '../../src/services/AssistedRecoveryService';
import {
	ManagedRepositoryAccessError,
	recoveryProcessFailure,
} from '../../src/utils/restic/ManagedSftpRepositorySession';
import { ReplicaRecoveryError } from '../../src/services/VerifiedReplicaRecoveryService';
import { fixture } from '../integration/persistentRestore.fixture';

const binding = {
	planId: 'plan-01',
	backupId: 'backup-01',
	sourceSnapshotId: 'a'.repeat(64),
	replicationId: 'replica-01',
	destinationSnapshotId: 'd'.repeat(64),
	repositoryConfigId: 'e'.repeat(64),
	treeId: 'f'.repeat(64),
	fingerprint: 'b'.repeat(64),
};
const input = () => ({
	planId: 'plan-01',
	backupId: 'backup-01',
	requestKey: crypto.randomUUID(),
	mode: 'prefer-primary' as const,
	includes: [],
	excludes: [],
});
describe('durable assisted failover authorization and lifecycle', () => {
	let db: ReturnType<typeof fixture>,
		store: AssistedRecoveryStore,
		root: string,
		plan: any,
		primary: any,
		replicas: any,
		service: AssistedRecoveryService,
		clock: number;
	const create = () =>
		new AssistedRecoveryService(
			store,
			{ getById: async () => plan } as any,
			primary,
			replicas,
			root,
			() => clock
		);
	beforeEach(async () => {
		db = fixture();
		store = new AssistedRecoveryStore(db.sqlite);
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'assisted-test-'));
		clock = Date.now();
		plan = {
			id: 'plan-01',
			sourceId: 'app-01',
			sourceType: 'device',
			method: 'backup',
			settings: {
				replication: {
					enabled: true,
					recoveryPolicy: 'assisted',
					storages: [{ replicationId: 'replica-01' }, { replicationId: 'replica-02' }],
				},
			},
		};
		primary = {
			testBinding: jest.fn(async () => ({ snapshotId: binding.sourceSnapshotId })),
			primaryAvailability: jest.fn(async () => {
				throw new ManagedRepositoryAccessError('network-unavailable');
			}),
		};
		replicas = {
			cleanup: jest.fn(async () => {}),
			preflight: jest.fn(async (_backup, _plan, replicationId) => ({ ...binding, replicationId })),
			withReplica: jest.fn(async (_backup, _plan, _replica, _signal, consume, expected) => {
				if (expected !== binding.fingerprint)
					throw new ReplicaRecoveryError('approval-binding-changed');
				return consume(
					{
						testBinding: async () => ({ snapshotId: binding.destinationSnapshotId }),
						replicaStage: async (_binding, _config, target, signal, stage, assertWorkspace) => {
							await assertWorkspace();
							stage('staged-restore');
							if (signal.aborted) throw new ManagedRepositoryAccessError('cancelled');
							await fs.writeFile(path.join(target, 'fixture.txt'), 'verified');
							return { stats: { total_files: 1, total_bytes: 8 } };
						},
					},
					binding
				);
			}),
		};
		service = create();
	});
	afterEach(async () => {
		await service.shutdown();
		db.sqlite.close();
		await fs.rm(root, { recursive: true, force: true });
	});
	const pending = async (owner = 'owner-01', request = input()) => {
		const job = await service.start(owner, request);
		await service.settled(job.id);
		expect(service.get(owner, job.id).status).toBe('awaiting-approval');
		return job;
	};
	it('continues primary normally without replica checks or a second approval', async () => {
		primary.primaryAvailability.mockResolvedValue({ snapshotId: binding.sourceSnapshotId });
		const job = await service.start('owner-01', input());
		await service.settled(job.id);
		expect(service.get('owner-01', job.id).status).toBe('primary-ready');
		expect(replicas.preflight).not.toHaveBeenCalled();
		expect(replicas.withReplica).not.toHaveBeenCalled();
	});
	it.each([undefined, 'primary-only'])(
		'preserves existing policy %s without probes or job admission',
		async policy => {
			plan.settings.replication.recoveryPolicy = policy;
			await expect(service.start('owner-01', input())).rejects.toMatchObject({ statusCode: 409 });
			expect(primary.primaryAvailability).not.toHaveBeenCalled();
			expect(store.list('owner-01', 'plan-01', 'backup-01')).toHaveLength(0);
		}
	);
	it.each([
		'wrong-password',
		'authentication-denied',
		'tls-invalid',
		'repository-unavailable',
		'execution-failed',
		'invalid-output',
		'configuration-invalid',
	])('never offers fallback for %s', async code => {
		primary.primaryAvailability.mockRejectedValue(new ManagedRepositoryAccessError(code as any));
		const job = await service.start('owner-01', input());
		await service.settled(job.id);
		expect(service.get('owner-01', job.id)).toMatchObject({ status: 'failed', failureCode: code });
		expect(replicas.preflight).not.toHaveBeenCalled();
	});
	it('does not guess availability from a raw/unknown error', async () => {
		primary.primaryAvailability.mockRejectedValue(
			new Error('connection refused synthetic-secret-key')
		);
		const job = await service.start('owner-01', input());
		await service.settled(job.id);
		const result = service.get('owner-01', job.id);
		expect(result.failureCode).toBe('unclassified-failure');
		expect(JSON.stringify(result)).not.toContain('synthetic-secret');
		expect(replicas.preflight).not.toHaveBeenCalled();
	});
	it('checks candidates in order, preserves replica1 failure and offers exact replica2', async () => {
		replicas.preflight.mockRejectedValueOnce(
			new ReplicaRecoveryError('repository-identity-mismatch')
		);
		const job = await pending();
		const result = service.get('owner-01', job.id);
		expect(result.candidates).toMatchObject([
			{ position: 1, state: 'failed', code: 'repository-identity-mismatch' },
			{ position: 2, state: 'passed', destinationSnapshotId: binding.destinationSnapshotId },
		]);
		expect(JSON.stringify(result)).not.toContain(binding.fingerprint);
		expect(replicas.withReplica).not.toHaveBeenCalled();
	});
	it('requires explicit owner approval, consumes it once and records verified isolated recovery', async () => {
		const job = await pending();
		expect(await fs.readdir(root)).toEqual([]);
		await service.approve('owner-01', job.id, 'replica-02');
		await expect(service.approve('owner-01', job.id, 'replica-01')).rejects.toMatchObject({
			statusCode: 409,
		});
		await service.settled(job.id);
		const result = service.get('owner-01', job.id);
		expect(result).toMatchObject({
			status: 'completed',
			selected: 'replica-02',
			cleanupPending: false,
			stats: { files: 1, bytes: 8 },
		});
		expect(replicas.withReplica).toHaveBeenCalledTimes(1);
		expect(result.candidates[1].recoveryTested).toBe(true);
		expect(await fs.readFile(path.join(root, 'run-' + job.id, 'files/fixture.txt'), 'utf8')).toBe(
			'verified'
		);
	});
	it('keeps a staged result unverified until the replica session cleanup returns', async () => {
		const job = await pending();
		const implementation = replicas.withReplica.getMockImplementation()!;
		let entered!: () => void;
		let finish!: () => void;
		const cleaning = new Promise<void>(resolve => {
			entered = resolve;
		});
		const release = new Promise<void>(resolve => {
			finish = resolve;
		});
		replicas.withReplica.mockImplementationOnce(async (...args) => {
			await implementation(...args);
			entered();
			await release;
			throw new ManagedRepositoryAccessError('cleanup-failed');
		});
		await service.approve('owner-01', job.id, 'replica-01');
		await cleaning;
		try {
			expect(service.get('owner-01', job.id)).toMatchObject({
				status: 'running',
				phase: 'staging-cleanup',
			});
		} finally {
			finish();
			await service.settled(job.id);
		}
		expect(service.get('owner-01', job.id)).toMatchObject({
			status: 'failed',
			failureCode: 'cleanup-failed',
			cleanupPending: false,
		});
	});
	it('denies owner enumeration, selection, cancellation and approval across identities', async () => {
		const job = await pending();
		expect(service.list('owner-02', 'plan-01', 'backup-01')).toEqual([]);
		expect(() => service.get('owner-02', job.id)).toThrow('not found');
		await expect(service.approve('owner-02', job.id, 'replica-01')).rejects.toMatchObject({
			statusCode: 404,
		});
		await expect(service.cancel('owner-02', job.id)).rejects.toMatchObject({ statusCode: 404 });
		expect(replicas.withReplica).not.toHaveBeenCalled();
	});
	it('expires approval, rejects changed plan policy, and never executes denied operations', async () => {
		const job = await pending();
		clock += 10 * 60_000;
		expect(service.get('owner-01', job.id).expired).toBe(true);
		await expect(service.approve('owner-01', job.id, 'replica-01')).rejects.toMatchObject({
			statusCode: 409,
		});
		clock -= 10 * 60_000;
		plan.settings.replication.recoveryPolicy = 'primary-only';
		await expect(service.approve('owner-01', job.id, 'replica-01')).rejects.toMatchObject({
			statusCode: 409,
		});
		expect(replicas.withReplica).not.toHaveBeenCalled();
	});
	it('survives refresh/restart in pending approval without re-probing or starting restore', async () => {
		const job = await pending();
		const before = replicas.preflight.mock.calls.length;
		service = create();
		const result = service.list('owner-01', 'plan-01', 'backup-01');
		expect(result[0].id).toBe(job.id);
		expect(result[0].status).toBe('awaiting-approval');
		expect(replicas.preflight).toHaveBeenCalledTimes(before);
		await service.approve('owner-01', job.id, 'replica-01');
		await service.settled(job.id);
		expect(service.get('owner-01', job.id).status).toBe('completed');
	});

	it('reopens pending approval from on-disk SQLite and completes only after a new explicit approval', async () => {
		await service.shutdown();
		db.sqlite.close();
		const file = path.join(root, 'durable.sqlite');
		db = fixture(file);
		store = new AssistedRecoveryStore(db.sqlite);
		service = create();
		const job = await pending();
		await service.shutdown();
		db.sqlite.close();
		const reopened = new Database(file);
		db = { ...db, sqlite: reopened };
		store = new AssistedRecoveryStore(reopened);
		service = create();
		expect(service.get('owner-01', job.id).status).toBe('awaiting-approval');
		expect(replicas.withReplica).not.toHaveBeenCalled();
		await service.approve('owner-01', job.id, 'replica-01');
		await service.settled(job.id);
		expect(service.get('owner-01', job.id).status).toBe('completed');
		await service.cancel('owner-01', job.id);
		expect(service.get('owner-01', job.id).candidates[0].recoveryTested).toBe(true);
	});
	it('deduplicates same intent across tabs and rejects idempotency collisions and competing scopes', async () => {
		const request = input();
		const [a, b] = await Promise.all([
			service.start('owner-01', request),
			service.start('owner-01', { ...request, requestKey: crypto.randomUUID() }),
		]);
		expect(a.id).toBe(b.id);
		await service.settled(a.id);
		expect(primary.primaryAvailability).toHaveBeenCalledTimes(1);
		await expect(
			service.start('owner-01', { ...request, includes: ['/srv/other'] })
		).rejects.toMatchObject({ statusCode: 409 });
		await expect(service.start('owner-02', input())).rejects.toMatchObject({ statusCode: 409 });
		expect(service.list('owner-01', 'plan-01', 'backup-01')).toHaveLength(1);
	});
	it('rejects/revokes approval on cancel and safely permits a fresh request', async () => {
		const job = await pending();
		await service.cancel('owner-01', job.id);
		await expect(service.approve('owner-01', job.id, 'replica-01')).rejects.toMatchObject({
			statusCode: 409,
		});
		expect(replicas.withReplica).not.toHaveBeenCalled();
		const next = await pending();
		expect(next.id).not.toBe(job.id);
	});
	it('fails if no candidate passes and never silently falls back after an approved replica fails', async () => {
		replicas.preflight.mockRejectedValue(new ReplicaRecoveryError('replica-unverified'));
		const job = await service.start('owner-01', input());
		await service.settled(job.id);
		expect(service.get('owner-01', job.id).failureCode).toBe('no-eligible-replica');
		replicas.preflight.mockResolvedValue(binding);
		const next = await pending();
		replicas.withReplica.mockRejectedValue(new ReplicaRecoveryError('approval-binding-changed'));
		await service.approve('owner-01', next.id, 'replica-01');
		await service.settled(next.id);
		expect(service.get('owner-01', next.id)).toMatchObject({
			status: 'failed',
			failureCode: 'approval-binding-changed',
			cleanupPending: false,
		});
		expect(replicas.withReplica).toHaveBeenCalledTimes(1);
	});
	it('marks interrupted execution uncertain after restart; never replays and blocks another recovery until explicit cleanup', async () => {
		const job = await pending();
		store.approve(job.id, 'owner-01', 'replica-01', clock);
		service = create();
		expect(service.get('owner-01', job.id)).toMatchObject({
			status: 'uncertain',
			cleanupPending: true,
		});
		await expect(service.approve('owner-01', job.id, 'replica-01')).rejects.toMatchObject({
			statusCode: 409,
		});
		await expect(service.start('owner-01', input())).resolves.toMatchObject({
			id: job.id,
			status: 'uncertain',
		});
		expect(replicas.withReplica).not.toHaveBeenCalled();
		await service.cancel('owner-01', job.id);
		expect(service.get('owner-01', job.id).cleanupPending).toBe(false);
	});

	it('retains a cleanup failure and permits only explicit safe cleanup retry', async () => {
		replicas.cleanup.mockRejectedValue(new Error('synthetic private filesystem failure'));
		const job = await service.start('owner-01', input());
		await service.settled(job.id);
		expect(service.get('owner-01', job.id)).toMatchObject({
			status: 'failed',
			cleanupPending: true,
		});
		replicas.cleanup.mockResolvedValue(undefined);
		await service.cancel('owner-01', job.id);
		expect(service.get('owner-01', job.id)).toMatchObject({
			status: 'cancelled',
			cleanupPending: false,
		});
		expect(JSON.stringify(service.get('owner-01', job.id))).not.toContain('private filesystem');
	});
	it('distinguishes a replica preflight deadline from operator cancellation and preserves candidate order', async () => {
		const deadline = new AbortController();
		const timer = jest.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal);
		replicas.preflight.mockImplementationOnce(async (_backup, _plan, _replica, signal) => {
			deadline.abort(new DOMException('Synthetic preflight deadline', 'TimeoutError'));
			expect(signal.aborted).toBe(true);
			throw new ManagedRepositoryAccessError('cancelled', undefined, {
				operation: 'snapshot-index',
				timeoutCategory: 'caller-deadline',
				elapsedMs: 179990,
			});
		});
		try {
			const job = await pending();
			expect(service.get('owner-01', job.id).candidates).toMatchObject([
				{
					replicationId: 'replica-01',
					state: 'failed',
					code: 'timeout',
					diagnostic: {
						phase: 'replica-check',
						operation: 'snapshot-index',
						timeoutCategory: 'replica-preflight-deadline',
						failureCode: 'timeout',
					},
				},
				{ replicationId: 'replica-02', state: 'passed' },
			]);
		} finally {
			timer.mockRestore();
		}
	});
	it.each([false, true])(
		'persists archive diagnostics through restart (cleanup fails: %s)',
		async cleanupFails => {
			const job = await pending();
			let entered!: () => void, release!: () => void;
			const started = new Promise<void>(resolve => {
				entered = resolve;
			});
			const resume = new Promise<void>(resolve => {
				release = resolve;
			});
			replicas.withReplica.mockImplementation(async (_b, _p, _r, _signal, consume) =>
				consume(
					{
						testBinding: async () => ({ snapshotId: binding.destinationSnapshotId }),
						replicaStage: async (
							_binding: unknown,
							_config: unknown,
							_target: string,
							_jobSignal: AbortSignal,
							phase: (value: string, activity?: string) => void
						) => {
							phase('integrity-preparation', 'awaiting-archive-output');
							phase('integrity-preparation', 'validating-archive-output');
							entered();
							await resume;
							throw Object.assign(new ManagedRepositoryAccessError('timeout'), {
								diagnostic: {
									operation: 'archive-readback',
									timeoutCategory: 'archive-output-idle',
									elapsedMs: 600010,
									archive: {
										firstByteMs: 17,
										bytesReceived: 8192,
										lastOutputAgeMs: 600000,
										consumerPending: false,
										consumerBackpressured: false,
										stdoutEnded: false,
										processAtStop: 'running',
										completion: 'signalled',
										nativeIo: {
											windowMs: 5000,
											sampleAgeMs: 23,
											rclone: {
												readBytes: 0,
												writtenBytes: 0,
												cpuTicks: 1,
												raw: 'synthetic-process-detail',
											},
										},
										backendRetries: {
											retryCount: 12,
											gaveUpCount: 0,
											recoveredCount: 0,
											serverErrorCount: 12,
											errorClasses: { 'unexpected-eof': 12 },
											loads: [
												{
													objectType: 'data',
													packPrefix: '00e0e0ca8b',
													length: 13960,
													offset: 2605056,
													attempts: 12,
													lastErrorClass: 'unexpected-eof',
													raw: 'synthetic-retry-load-secret',
												},
											],
											lastRetryAfterMs: 61000,
											lastServedBytes: 2875,
											lastExpectedBytes: 13960,
											raw: 'synthetic-retry-secret',
										},
										raw: 'synthetic-nested-secret',
									},
									raw: 'synthetic-private',
								},
							});
						},
					},
					binding
				)
			);
			await service.approve('owner-01', job.id, 'replica-01');
			await started;
			if (cleanupFails)
				replicas.cleanup.mockRejectedValueOnce(new Error('synthetic cleanup secret'));
			try {
				expect(service.get('owner-01', job.id)).toMatchObject({
					status: 'running',
					phase: 'integrity-preparation',
					activity: 'validating-archive-output',
					activeSince: expect.any(Number),
				});
			} finally {
				release();
				await service.settled(job.id);
			}
			service = create();
			const restored = service.list('owner-01', 'plan-01', 'backup-01')[0];
			expect(restored).toMatchObject({
				status: 'failed',
				phase: 'recovery-stopped',
				failureCode: 'timeout',
				cleanupPending: cleanupFails,
				diagnostic: {
					phase: 'integrity-preparation',
					operation: 'archive-readback',
					timeoutCategory: 'archive-output-idle',
					elapsedMs: 600010,
					failureCode: 'timeout',
					archive: {
						firstByteMs: 17,
						bytesReceived: 8192,
						lastOutputAgeMs: 600000,
						processAtStop: 'running',
						completion: 'signalled',
						nativeIo: {
							windowMs: 5000,
							sampleAgeMs: 23,
							rclone: { readBytes: 0, writtenBytes: 0, cpuTicks: 1 },
						},
						backendRetries: {
							retryCount: 12,
							serverErrorCount: 12,
							errorClasses: { 'unexpected-eof': 12 },
							loads: [
								{
									objectType: 'data',
									packPrefix: '00e0e0ca8b',
									length: 13960,
									offset: 2605056,
									attempts: 12,
									lastErrorClass: 'unexpected-eof',
								},
							],
							lastRetryAfterMs: 61000,
							lastServedBytes: 2875,
							lastExpectedBytes: 13960,
						},
					},
				},
				phaseTimingsMs: {
					'approval-revalidation': expect.any(Number),
					'staging-preparation': expect.any(Number),
					'integrity-preparation': expect.any(Number),
					'staging-cleanup': expect.any(Number),
				},
			});
			expect(restored.activity).toBeUndefined();
			expect(JSON.stringify(restored)).not.toMatch(
				/synthetic-private|synthetic-nested-secret|synthetic-process-detail|synthetic cleanup secret|synthetic-retry/
			);
			if (cleanupFails) {
				const cancelled = await service.cancel('owner-01', job.id);
				expect(cancelled).toMatchObject({ cleanupPending: false, diagnostic: restored.diagnostic });
			}
			expect(service.list('other-owner', 'plan-01', 'backup-01')).toEqual([]);
			expect(replicas.withReplica).toHaveBeenCalledTimes(1);
		}
	);

	it('manual mode validates replicas read-only even when primary is healthy', async () => {
		const job = await pending('owner-01', { ...input(), mode: 'manual-replica' } as any);
		expect(primary.primaryAvailability).not.toHaveBeenCalled();
		expect(service.get('owner-01', job.id).primary?.state).toBe('not-checked');
		expect(replicas.withReplica).not.toHaveBeenCalled();
	});
	it('cancels an active staged recovery without switching to another replica', async () => {
		const job = await pending();
		let entered!: () => void;
		const started = new Promise<void>(resolve => (entered = resolve));
		replicas.withReplica.mockImplementation(async (_b, _p, _r, signal) => {
			entered();
			await new Promise<void>(resolve =>
				signal.addEventListener('abort', () => resolve(), { once: true })
			);
			throw new ManagedRepositoryAccessError('cancelled');
		});
		await service.approve('owner-01', job.id, 'replica-01');
		await started;
		await service.cancel('owner-01', job.id);
		expect(service.get('owner-01', job.id)).toMatchObject({
			status: 'cancelled',
			cleanupPending: false,
		});
		expect(replicas.withReplica).toHaveBeenCalledTimes(1);
	});
	describe('Automatic Failover', () => {
		beforeEach(() => {
			plan.settings.replication.recoveryPolicy = 'automatic';
		});
		const run = async (owner = 'owner-01', request: ReturnType<typeof input> | any = input()) => {
			const job = await service.start(owner, request);
			await service.settled(job.id);
			return service.get(owner, job.id);
		};
		const until = async (condition: () => boolean) => {
			for (let index = 0; index < 500 && !condition(); index++)
				await new Promise<void>(resolve => setImmediate(resolve));
			expect(condition()).toBe(true);
		};
		const staging = (replicationId: string, fail?: () => Error) =>
			jest.fn(async (_b, _p, selected, _signal, consume) =>
				consume(
					{
						testBinding: async () => ({ snapshotId: binding.destinationSnapshotId }),
						replicaStage: async (_binding, _config, target, _jobSignal, stage, assertWorkspace) => {
							await assertWorkspace();
							stage('integrity-preparation', 'validating-archive-output');
							if (selected === replicationId && fail) {
								await fs.writeFile(path.join(target, `partial-${selected}.txt`), 'partial');
								throw fail();
							}
							expect(await fs.readdir(target)).toEqual([]);
							await fs.writeFile(path.join(target, 'fixture.txt'), 'verified');
							return { stats: { total_files: 1, total_bytes: 8 } };
						},
					},
					{ ...binding, replicationId: selected }
				)
			);

		it('prefers a healthy primary without probing or using any replica', async () => {
			primary.primaryAvailability.mockResolvedValue({ snapshotId: binding.sourceSnapshotId });
			const result = await run();
			expect(result).toMatchObject({ status: 'primary-ready', policy: 'automatic' });
			expect(result.sourceSelection).toBeUndefined();
			expect(replicas.preflight).not.toHaveBeenCalled();
			expect(replicas.withReplica).not.toHaveBeenCalled();
		});

		it('selects the first verified replica after an eligible outage and verifies staging without a second approval', async () => {
			const result = await run();
			expect(result).toMatchObject({
				status: 'completed',
				phase: 'integrity-verified',
				policy: 'automatic',
				selected: 'replica-01',
				cleanupPending: false,
				stats: { files: 1, bytes: 8 },
				primary: { state: 'unavailable', code: 'network-unavailable' },
				sourceSelection: {
					mode: 'automatic',
					reason: 'network-unavailable',
					attempts: [{ replicationId: 'replica-01', position: 1, outcome: 'selected' }],
				},
			});
			const events = result.audit.map(event => event.event);
			expect(events).toEqual(
				expect.arrayContaining([
					'recovery-requested',
					'primary-unavailable',
					'replica-eligibility-checked',
					'automatic-source-selected',
					'recovery-source-approved',
					'staged-recovery-verified',
				])
			);
			expect(events).not.toContain('operator-approved');
			expect(result.audit).toContainEqual(
				expect.objectContaining({ event: 'automatic-source-selected', code: 'network-unavailable' })
			);
			expect(replicas.withReplica).toHaveBeenCalledTimes(1);
			expect(replicas.withReplica.mock.calls[0][2]).toBe('replica-01');
			// The consumed automatic authorization cannot be replayed as an operator approval.
			await expect(service.approve('owner-01', result.id, 'replica-01')).rejects.toMatchObject({
				statusCode: 409,
			});
			// Only the job's private staging workspace was written.
			expect(await fs.readdir(root)).toEqual([`run-${result.id}`]);
		});

		it('evaluates replica 2 when replica 1 fails its preflight and records why', async () => {
			replicas.preflight.mockRejectedValueOnce(new ReplicaRecoveryError('replica-unverified'));
			const result = await run();
			expect(result).toMatchObject({
				status: 'completed',
				selected: 'replica-02',
				candidates: [
					{ position: 1, state: 'failed', code: 'replica-unverified' },
					{ position: 2, state: 'passed' },
				],
				sourceSelection: {
					mode: 'automatic',
					attempts: [{ replicationId: 'replica-02', position: 2, outcome: 'selected' }],
				},
			});
			expect(replicas.withReplica.mock.calls[0][2]).toBe('replica-02');
		});

		it.each([
			['an incomplete receipt', () => new ReplicaRecoveryError('replica-unverified')],
			['an identity mismatch', () => new ReplicaRecoveryError('repository-identity-mismatch')],
			['an unreachable replica', () => new ManagedRepositoryAccessError('network-unavailable')],
		])('stops safely when every replica is rejected for %s', async (_label, failure) => {
			replicas.preflight.mockImplementation(async () => {
				throw failure();
			});
			const result = await run();
			expect(result).toMatchObject({
				status: 'failed',
				phase: 'no-eligible-replica',
				failureCode: 'no-eligible-replica',
				cleanupPending: false,
			});
			expect(result.sourceSelection).toBeUndefined();
			expect(replicas.withReplica).not.toHaveBeenCalled();
		});

		it('rejects a replica whose verified mapping names a different source snapshot', async () => {
			replicas.preflight.mockResolvedValueOnce({ ...binding, sourceSnapshotId: 'c'.repeat(64) });
			const result = await run();
			expect(result.candidates[0]).toMatchObject({ state: 'failed', code: 'source-binding-invalid' });
			expect(result).toMatchObject({ status: 'completed', selected: 'replica-02' });
		});

		it.each(['authentication-denied', 'tls-invalid', 'wrong-password', 'repository-unavailable'])(
			'fails closed on primary %s without evaluating any replica',
			async code => {
				primary.primaryAvailability.mockRejectedValue(new ManagedRepositoryAccessError(code as any));
				const result = await run();
				expect(result).toMatchObject({ status: 'failed', failureCode: code });
				expect(replicas.preflight).not.toHaveBeenCalled();
				expect(replicas.withReplica).not.toHaveBeenCalled();
			}
		);

		it('does not fall back when the primary no longer holds the requested snapshot', async () => {
			primary.primaryAvailability.mockResolvedValue({ snapshotId: 'c'.repeat(64) });
			const result = await run();
			expect(result.status).toBe('failed');
			expect(replicas.preflight).not.toHaveBeenCalled();
		});

		it('moves to the next verified replica only after a transport failure and removal of partial staging', async () => {
			replicas.withReplica = staging('replica-01', () => new ManagedRepositoryAccessError('timeout'));
			service = create();
			const result = await run();
			expect(result).toMatchObject({
				status: 'completed',
				selected: 'replica-02',
				stats: { files: 1, bytes: 8 },
				sourceSelection: {
					mode: 'automatic',
					reason: 'network-unavailable',
					attempts: [
						{ replicationId: 'replica-01', position: 1, outcome: 'failed', code: 'timeout' },
						{ replicationId: 'replica-02', position: 2, outcome: 'selected' },
					],
				},
			});
			expect(result.audit).toContainEqual(
				expect.objectContaining({ event: 'automatic-failover-next-replica', code: 'timeout' })
			);
			expect(replicas.withReplica).toHaveBeenCalledTimes(2);
			// Replica 2 started from an empty workspace; replica 1's partial file is gone.
			expect(await fs.readdir(path.join(root, `run-${result.id}`, 'files'))).toEqual(['fixture.txt']);
		});

		it.each([
			['an integrity failure', () => new ManagedRepositoryAccessError('archive-failed')],
			['an identity change', () => new ReplicaRecoveryError('approval-binding-changed')],
			['an authentication failure', () => new ManagedRepositoryAccessError('authentication-denied')],
		])('never switches source after %s during staging and never reports success', async (_label, failure) => {
			replicas.withReplica = staging('replica-01', failure);
			service = create();
			const result = await run();
			expect(result).toMatchObject({ status: 'failed', phase: 'recovery-stopped', cleanupPending: false });
			expect(result.stats).toBeUndefined();
			expect(result.sourceSelection?.attempts).toEqual([
				expect.objectContaining({ replicationId: 'replica-01', outcome: 'failed', code: result.failureCode }),
			]);
			expect(replicas.withReplica).toHaveBeenCalledTimes(1);
			expect(await fs.readdir(root)).toEqual([]);
		});

		it('stops instead of switching when partial staging could not be removed', async () => {
			replicas.withReplica = staging('replica-01', () => new ManagedRepositoryAccessError('timeout'));
			replicas.cleanup
				.mockResolvedValueOnce(undefined)
				.mockRejectedValue(new Error('synthetic private cleanup failure'));
			service = create();
			const result = await run();
			expect(result).toMatchObject({ status: 'failed', failureCode: 'timeout', cleanupPending: true });
			expect(replicas.withReplica).toHaveBeenCalledTimes(1);
			expect(JSON.stringify(result)).not.toContain('synthetic private');
		});

		it('marks an interrupted automatic recovery uncertain after restart and never replays it', async () => {
			let release!: () => void;
			const hold = new Promise<void>(resolve => {
				release = resolve;
			});
			replicas.withReplica.mockImplementation(async () => {
				await hold;
				throw new ManagedRepositoryAccessError('network-unavailable');
			});
			const job = await service.start('owner-01', input());
			await until(() => service.get('owner-01', job.id).status === 'running');
			const restarted = create();
			expect(restarted.get('owner-01', job.id)).toMatchObject({ status: 'uncertain', cleanupPending: true });
			release();
			await service.settled(job.id);
			// The interrupted instance cannot move an uncertain job to another replica or to success.
			expect(restarted.get('owner-01', job.id)).toMatchObject({ status: 'uncertain' });
			expect(replicas.withReplica).toHaveBeenCalledTimes(1);
			await restarted.cancel('owner-01', job.id);
			expect(restarted.get('owner-01', job.id).cleanupPending).toBe(false);
		});

		it('deduplicates the same automatic intent across tabs and executes once', async () => {
			const request = input();
			const [first, second] = await Promise.all([
				service.start('owner-01', request),
				service.start('owner-01', request),
			]);
			expect(second.id).toBe(first.id);
			await service.settled(first.id);
			expect(service.get('owner-01', first.id).status).toBe('completed');
			expect(replicas.withReplica).toHaveBeenCalledTimes(1);
		});

		it('cancels an automatic recovery, cleans its staging and does not try another replica', async () => {
			let entered!: () => void;
			const started = new Promise<void>(resolve => {
				entered = resolve;
			});
			replicas.withReplica.mockImplementation(async (_b, _p, _r, signal: AbortSignal) => {
				entered();
				await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
				throw new ManagedRepositoryAccessError('cancelled');
			});
			const job = await service.start('owner-01', input());
			await started;
			const cancelled = await service.cancel('owner-01', job.id);
			expect(cancelled).toMatchObject({ status: 'cancelled', cleanupPending: false });
			expect(replicas.withReplica).toHaveBeenCalledTimes(1);
			expect(await fs.readdir(root)).toEqual([]);
		});

		it('requires operator approval again if the plan leaves Automatic Failover during the check', async () => {
			replicas.preflight.mockImplementation(async (_b, _p, replicationId) => {
				plan.settings.replication.recoveryPolicy = 'assisted';
				return { ...binding, replicationId };
			});
			const result = await run();
			expect(result.status).toBe('awaiting-approval');
			expect(replicas.withReplica).not.toHaveBeenCalled();
		});

		it('keeps manual replica checks explicit under Automatic Failover', async () => {
			primary.primaryAvailability.mockResolvedValue({ snapshotId: binding.sourceSnapshotId });
			const result = await run('owner-01', { ...input(), mode: 'manual-replica' });
			expect(result.status).toBe('awaiting-approval');
			expect(replicas.withReplica).not.toHaveBeenCalled();
		});

		it('refuses automatic execution while another recovery holds the execution slot', async () => {
			const time = Date.now();
			store.create({
				id: 'c'.repeat(24),
				owner: 'owner-02',
				planId: 'plan-02',
				backupId: 'backup-02',
				requestKey: crypto.randomUUID(),
				requestHash: 'h'.repeat(64),
				status: 'running',
				phase: 'staged-restore',
				payload: { mode: 'prefer-primary', sourceSnapshotId: 'a'.repeat(64), includes: [], excludes: [], candidates: [] },
				createdAt: time,
				updatedAt: time,
				expiresAt: time + 600_000,
				cleanupPending: true,
				audit: [],
			});
			const result = await run();
			expect(result).toMatchObject({
				status: 'failed',
				failureCode: 'automatic-failover-blocked',
				cleanupPending: false,
			});
			expect(replicas.withReplica).not.toHaveBeenCalled();
		});

		it('does not consume an authorization that expired during replica checks', async () => {
			replicas.preflight.mockImplementation(async (_b, _p, replicationId) => {
				clock += 11 * 60_000;
				return { ...binding, replicationId };
			});
			const result = await run();
			expect(result).toMatchObject({ status: 'failed', failureCode: 'automatic-failover-blocked' });
			expect(replicas.withReplica).not.toHaveBeenCalled();
		});
	});

	it('refuses wildcard selections before network access', async () => {
		await expect(
			service.start('owner-01', { ...input(), includes: ['/srv/*'] })
		).rejects.toMatchObject({ statusCode: 400 });
		expect(primary.primaryAvailability).not.toHaveBeenCalled();
	});
});
describe('closed process categories', () => {
	it.each([
		[1, 'dial tcp: connection refused', 'network-unavailable'],
		[
			1,
			'WARNING no SSH host key verification; dial tcp: connection refused',
			'network-unavailable',
		],
		[1, 'host key verification failed; connection refused', 'tls-invalid'],
		[1, 'ssh: unable to authenticate; connection refused', 'authentication-denied'],
		[1, 'no route to host', 'network-unavailable'],
		[1, 'Permission denied; connection refused', 'authentication-denied'],
		[12, 'connection refused', 'wrong-password'],
		[1, 'x509 certificate signed by unknown authority; connection refused', 'tls-invalid'],
		[10, 'config missing', 'repository-unavailable'],
		[1, 'unknown synthetic provider failure', 'execution-failed'],
	])('classifies %s without returning raw diagnostics', (code, text, expected) => {
		expect(recoveryProcessFailure(code as number, text as string)).toBe(expected);
	});
});

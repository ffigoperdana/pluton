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
				/synthetic-private|synthetic-nested-secret|synthetic-process-detail|synthetic cleanup secret/
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

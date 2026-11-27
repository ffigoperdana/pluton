import {
	PREPARED_INDEX_QUEUE_LIMITS,
	PreparedSnapshotIndexService,
	type PreparedIndexDiagnostic,
} from '../../src/services/PreparedSnapshotIndexService';
import type { PreparedIndexAdmission } from '../../src/services/RemoteRepositoryRecoveryService';
import type { PreparedIndexResult } from '../../src/utils/restic/ManagedSnapshotIndex';

const flush = () => new Promise(resolve => setImmediate(resolve));

/** A controllable build: resolve it with an outcome. */
const deferred = () => {
	let finish!: (outcome: PreparedIndexResult) => void;
	const result = new Promise<PreparedIndexResult>(resolve => (finish = resolve));
	return { result, finish };
};

describe('PreparedSnapshotIndexService', () => {
	let busy: boolean,
		records: PreparedIndexDiagnostic[],
		builds: Map<string, ReturnType<typeof deferred>>;
	let prepare: jest.Mock<Promise<PreparedIndexAdmission>, [string]>;
	let preempt: jest.Mock<Promise<boolean>, [string]>;
	let latest: string[];
	let service: PreparedSnapshotIndexService;
	const stages = () => records.map(record => `${record.stage}:${record.backupId}`);
	beforeEach(() => {
		busy = false;
		records = [];
		latest = [];
		builds = new Map();
		prepare = jest.fn(async (backupId: string) => {
			const build = deferred();
			builds.set(backupId, build);
			return { status: 'started' as const, key: `key-${backupId}`, result: build.result };
		});
		preempt = jest.fn(async (key: string) => {
			builds.get(key.slice(4))?.finish('cancelled');
			return true;
		});
		service = new PreparedSnapshotIndexService(
			{ prepareSnapshotIndex: prepare, preemptPreparedIndex: preempt },
			{ busy: async () => busy, latestBackups: async () => latest },
			record => records.push(record)
		);
	});

	it('waits while a backup or replication runs, then prepares one backup at a time', async () => {
		service.enqueue('backup-01');
		service.enqueue('backup-02');
		busy = true;
		await service.tick();
		expect(prepare).not.toHaveBeenCalled();
		busy = false;
		await service.tick();
		expect(prepare).toHaveBeenCalledTimes(1);
		expect(prepare).toHaveBeenLastCalledWith('backup-01');
		// The next one waits for the running build.
		await service.tick();
		expect(prepare).toHaveBeenCalledTimes(1);
		builds.get('backup-01')!.finish('ready');
		await flush();
		await service.tick();
		expect(prepare).toHaveBeenLastCalledWith('backup-02');
		builds.get('backup-02')!.finish('failed');
		await flush();
		expect(stages()).toEqual([
			'queued:backup-01',
			'queued:backup-02',
			'started:backup-01',
			'ready:backup-01',
			'started:backup-02',
			'failed:backup-02',
		]);
	});

	it('stops a running preparation when a backup starts and prepares it again afterwards', async () => {
		service.enqueue('backup-01');
		await service.tick();
		busy = true;
		await service.tick();
		expect(preempt).toHaveBeenCalledWith('key-backup-01');
		await flush();
		expect(records.at(-1)).toMatchObject({
			stage: 'requeued',
			backupId: 'backup-01',
			reason: 'preempted',
		});
		await service.tick();
		expect(prepare).toHaveBeenCalledTimes(1);
		busy = false;
		await service.tick();
		expect(prepare).toHaveBeenCalledTimes(2);
		expect(prepare).toHaveBeenLastCalledWith('backup-01');
	});

	it('queues a preparation again at the front when Browse took the build slot', async () => {
		service.enqueue('backup-01');
		service.enqueue('backup-02');
		prepare.mockResolvedValueOnce({ status: 'busy' });
		await service.tick();
		await service.tick();
		expect(prepare.mock.calls.map(([id]) => id)).toEqual(['backup-01', 'backup-01']);
		// A build that a user request preempted is also prepared again first.
		builds.get('backup-01')!.finish('cancelled');
		await flush();
		await service.tick();
		expect(prepare).toHaveBeenLastCalledWith('backup-01');
	});

	it('reports skipped and refused backups without retrying them', async () => {
		prepare
			.mockResolvedValueOnce({ status: 'skipped', reason: 'small' })
			.mockResolvedValueOnce({ status: 'failed' })
			.mockRejectedValueOnce(new Error('private detail'));
		for (const id of ['backup-01', 'backup-02', 'backup-03']) service.enqueue(id);
		for (let i = 0; i < 4; i++) await service.tick();
		expect(prepare).toHaveBeenCalledTimes(3);
		expect(records.filter(record => record.stage !== 'queued')).toEqual([
			expect.objectContaining({ stage: 'skipped', backupId: 'backup-01', reason: 'small' }),
			expect.objectContaining({ stage: 'failed', backupId: 'backup-02' }),
			expect.objectContaining({ stage: 'failed', backupId: 'backup-03' }),
		]);
		expect(JSON.stringify(records)).not.toContain('private detail');
	});

	it('treats an unknown activity state as busy', async () => {
		service = new PreparedSnapshotIndexService(
			{ prepareSnapshotIndex: prepare, preemptPreparedIndex: preempt },
			{
				busy: async () => {
					throw new Error('database unavailable');
				},
				latestBackups: async () => [],
			},
			record => records.push(record)
		);
		service.enqueue('backup-01');
		await service.tick();
		expect(prepare).not.toHaveBeenCalled();
	});

	it('queues each backup once, ignores invalid IDs and drops the oldest when full', async () => {
		service.enqueue('backup-01');
		service.enqueue('backup-01');
		service.enqueue('../escape');
		service.enqueue('');
		expect(stages()).toEqual(['queued:backup-01']);
		for (let i = 2; i <= PREPARED_INDEX_QUEUE_LIMITS.maxQueued + 1; i++)
			service.enqueue(`backup-${String(i).padStart(2, '0')}`);
		expect(records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ stage: 'dropped', backupId: 'backup-01', reason: 'queue-full' }),
			])
		);
		await service.tick();
		expect(prepare).toHaveBeenLastCalledWith('backup-02');
		// A backup that is preparing is not queued twice.
		service.enqueue('backup-02');
		expect(
			records.filter(record => record.backupId === 'backup-02' && record.stage === 'queued')
		).toHaveLength(1);
	});

	it('queues the latest backup of each plan again after a restart', async () => {
		latest = ['backup-01', 'backup-02'];
		await service.reconcile();
		expect(stages()).toEqual(['queued:backup-01', 'queued:backup-02']);
	});

	it('stops queuing when closed and tolerates an unavailable logger', async () => {
		service = new PreparedSnapshotIndexService(
			{ prepareSnapshotIndex: prepare, preemptPreparedIndex: preempt },
			{ busy: async () => false, latestBackups: async () => [] },
			() => {
				throw new Error('logger offline');
			}
		);
		service.enqueue('backup-01');
		await service.tick();
		expect(prepare).toHaveBeenCalledTimes(1);
		service.close();
		service.enqueue('backup-02');
		await service.tick();
		expect(prepare).toHaveBeenCalledTimes(1);
		builds.get('backup-01')!.finish('cancelled');
		await flush();
		await service.tick();
		expect(prepare).toHaveBeenCalledTimes(1);
	});
});

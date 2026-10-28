import { ManagedDownloadPreparation } from '../../src/services/ManagedDownloadPreparation';
import { SnapshotIndexError } from '../../src/utils/restic/ManagedSnapshotIndex';
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
describe('bounded asynchronous download preparation', () => {
	let now: number;
	let jobs: ManagedDownloadPreparation;
	beforeEach(() => {
		now = 1000;
		jobs = new ManagedDownloadPreparation(() => now);
	});
	afterEach(async () => jobs.close());
	it('returns queued without executing work, deduplicates, and exposes genuine stages', async () => {
		let release!: () => void;
		const run = jest.fn(async (_signal, stage) => {
			stage('indexing');
			await new Promise<void>(resolve => {
				release = resolve;
			});
			stage('validating');
			return 'generation-01';
		});
		const first = jobs.start('exact-context', run, () => true);
		expect(jobs.start('exact-context', run, () => true)).toBe(first);
		expect(run).not.toHaveBeenCalled();
		expect(jobs.status(first, first.id).state).toBe('queued');
		await turn();
		expect(jobs.status(first, first.id, 100).state).toBe('indexing');
		expect(jobs.status(first, first.id, 100).validatedEntries).toBe(0);
		release();
		await first.done;
		expect(jobs.status(first, first.id, 100)).toMatchObject({
			state: 'ready',
			validatedEntries: 100,
			retryAfterMs: 0,
		});
		expect(run).toHaveBeenCalledTimes(1);
	});
	it('admits four jobs with one worker, refuses overflow and cancels queued work', async () => {
		const run = jest.fn(async (signal: AbortSignal) => {
			await new Promise<void>(resolve =>
				signal.addEventListener('abort', () => resolve(), { once: true })
			);
			return 'proof';
		});
		const admitted = Array.from({ length: 4 }, (_, n) =>
			jobs.start(`binding-${n}`, run, () => true)
		);
		expect(() => jobs.start('overflow', run, () => true)).toThrow(/busy/);
		await turn();
		expect(run).toHaveBeenCalledTimes(1);
		jobs.cancel(admitted[1]);
		jobs.cancel(admitted[0]);
		await admitted[0].done;
		expect(admitted[1].state).toBe('cancelled');
		expect(run).toHaveBeenCalledTimes(2);
	});
	it('expires running jobs and ready proofs, then admits an explicit retry', async () => {
		const run = async () => 'proof';
		const ready = jobs.start('binding', run, () => true);
		await turn();
		await ready.done;
		now += 120_000;
		expect(jobs.get('binding', ready.id)?.state).toBe('expired');
		expect(jobs.start('binding', run, () => true).id).not.toBe(ready.id);
	});
	it('never reuses ready proof when its exact index generation is gone', async () => {
		const ready = jobs.start(
			'binding',
			async () => 'old-index',
			() => true
		);
		await turn();
		await ready.done;
		const next = jobs.start(
			'binding',
			async () => 'new-index',
			() => false
		);
		expect(next.id).not.toBe(ready.id);
		expect(ready.state).toBe('expired');
	});
	it('bounds retained terminal and ready statuses to 32 jobs', async () => {
		const ids: string[] = [];
		for (let n = 0; n < 40; n++) {
			const job = jobs.start(
				`binding-${n}`,
				async () => 'proof',
				() => true
			);
			ids.push(job.id);
			await turn();
			await job.done;
		}
		expect(jobs.get('binding-0', ids[0])).toBeUndefined();
		expect(jobs.get('binding-7', ids[7])).toBeUndefined();
		expect(jobs.get('binding-8', ids[8])?.state).toBe('ready');
		expect(jobs.get('binding-39', ids[39])?.state).toBe('ready');
	});
	it('fails closed on identity mismatch and reconciles unknown restart IDs as expired', () => {
		const job = jobs.start(
			'binding',
			async () => 'proof',
			() => true
		);
		expect(() => jobs.get('other-binding', job.id)).toThrow(/not found/);
		expect(() => jobs.get('binding', '../escape')).toThrow(/identity/);
		expect(jobs.status(jobs.get('binding', 'a'.repeat(36)), 'a'.repeat(36)).state).toBe('expired');
	});
	it.each([
		new Error('secret private diagnostic'),
		new SnapshotIndexError('metadata-invalid', 'unsafe-path'),
	])('sanitizes worker failure and never claims ready', async error => {
		const job = jobs.start(
			'binding',
			async () => {
				throw error;
			},
			() => true
		);
		await turn();
		await job.done;
		const result = jobs.status(job, job.id);
		expect(result.state).toBe('failed');
		expect(result.error).not.toMatch(/secret|private diagnostic/);
		if (error instanceof SnapshotIndexError) expect(result.reason).toBe('unsafe-path');
	});
	it('expires running work after its absolute lifetime despite polling', async () => {
		const job = jobs.start(
			'binding',
			async (signal, stage) => {
				stage('indexing');
				await new Promise<void>(resolve =>
					signal.addEventListener('abort', () => resolve(), { once: true })
				);
				return 'proof';
			},
			() => true
		);
		await turn();
		now += 30 * 60_000;
		expect(jobs.get('binding', job.id)?.state).toBe('expired');
		await job.done;
		expect(job.proof).toBeUndefined();
	});
});

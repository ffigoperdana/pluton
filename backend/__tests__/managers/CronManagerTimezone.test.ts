import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CronManager } from '../../src/managers/CronManager';
import { cronLogger } from '../../src/utils/logger';

jest.mock('../../src/utils/logger', () => ({ cronLogger: { error: jest.fn() } }));
describe('real Croner timer, restart and callback safety', () => {
	let root: string;
	let manager: CronManager<any>;
	const options = (callback: any, active = true) => ({ isActive: active, taskCallback: callback, settings: { interval: { timeZone: 'Asia/Jakarta' } } });
	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), 'pluton-clock-'));
		(CronManager as any).instance = undefined;
		jest.useFakeTimers({ now: new Date('2026-10-23T20:59:00Z') });
	});
	afterEach(async () => {
		if (manager) for (const entries of (await manager.getSchedules()).values()) for (const entry of entries) entry.cron.stop();
		jest.useRealTimers();
		await rm(root, { recursive: true, force: true });
	});
	it('fires 04:00 WIB exactly once and duplicate registration cannot create a second timer', async () => {
		const callback = jest.fn();
		manager = CronManager.getInstance({ backup: callback }, path.join(root, 'schedules.json'));
		await manager.getSchedules();
		await manager.scheduleTask('plan-01', '0 4 * * *', options(callback), 'backup');
		await manager.scheduleTask('plan-01', '0 4 * * *', options(callback), 'backup');
		await jest.advanceTimersByTimeAsync(60000);
		expect(callback).toHaveBeenCalledTimes(1);
	});
	it('cached timers cannot run before recovery/reconciliation; restart does not replay missed slots', async () => {
		const file = path.join(root, 'schedules.json');
		await writeFile(file, JSON.stringify([{ id: 'plan-01', cronExpression: '0 4 * * *', scheduleType: 'backup', options: options(undefined) }]));
		const callback = jest.fn();
		manager = CronManager.getInstance({ backup: callback }, file);
		await manager.getSchedules();
		await jest.advanceTimersByTimeAsync(120000);
		expect(callback).not.toHaveBeenCalled();
		await manager.activateLoadedSchedule('plan-01', 'backup');
		await jest.advanceTimersByTimeAsync(60000);
		expect(callback).not.toHaveBeenCalled();
		const entry = (await manager.getSchedule('plan-01'))![0];
		expect(entry.cron.nextRun()?.toISOString()).toBe('2026-10-24T21:00:00.000Z');
	});
	it('restart before the slot and release of the authorized plan runs once; paused plans remain paused', async () => {
		const file = path.join(root, 'schedules.json');
		await writeFile(file, JSON.stringify(['active', 'paused'].map(id => ({ id, cronExpression: '0 4 * * *', scheduleType: 'backup', options: options(undefined, id === 'active') }))));
		const callback = jest.fn();
		manager = CronManager.getInstance({ backup: callback }, file);
		await manager.getSchedules();
		await manager.activateLoadedSchedule('active', 'backup');
		await manager.activateLoadedSchedule('paused', 'backup');
		await jest.advanceTimersByTimeAsync(60000);
		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback.mock.calls[0][0]).toBe('active');
	});
	it('concurrent ticks across timer replacement cannot overlap an asynchronous dispatch', async () => {
		let finish!: () => void;
		const callback = jest.fn(() => new Promise<void>(resolve => { finish = resolve; }));
		manager = CronManager.getInstance({ backup: callback }, path.join(root, 'schedules.json'));
		await manager.getSchedules();
		await manager.scheduleTask('plan-01', '0 4 * * *', options(callback), 'backup');
		const first = (await manager.getSchedule('plan-01'))![0].cron.trigger();
		await manager.updateSchedule('plan-01', '0 5 * * *', options(callback), 'backup');
		await (await manager.getSchedule('plan-01'))![0].cron.trigger();
		expect(callback).toHaveBeenCalledTimes(1);
		finish(); await first;
	});
	it('callback errors are handled without sensitive output; invalid replacement preserves the valid timer', async () => {
		const callback = jest.fn().mockRejectedValue(new Error('synthetic-private-provider-value'));
		manager = CronManager.getInstance({ backup: callback }, path.join(root, 'schedules.json'));
		await manager.getSchedules();
		await manager.scheduleTask('plan-01', '0 4 * * *', options(callback), 'backup');
		const entry = (await manager.getSchedule('plan-01'))![0];
		await entry.cron.trigger();
		expect(JSON.stringify((cronLogger.error as jest.Mock).mock.calls)).not.toContain('synthetic-private-provider-value');
		await expect(manager.updateSchedule('plan-01', '0 4 * * *', { ...options(callback), timeZone: 'invalid/zone' }, 'backup')).rejects.toThrow();
		expect((await manager.getSchedule('plan-01'))![0].cron).toBe(entry.cron);
		expect(entry.cron.isStopped()).toBe(false);
	});
});

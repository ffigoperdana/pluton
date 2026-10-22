import { ScheduleReconciler } from '../../src/services/ScheduleReconciler';

describe('authoritative schedule timezone reconciliation', () => {
	const plan = { id: 'plan-01', title: 'Example', sourceId: 'main', storageId: 'storage-01', isActive: true, settings: { interval: { type: 'daily', time: '04:00AM', timeZone: 'Asia/Jakarta' } } } as any;
	function fixture(existing: any, saved = plan) {
		const cronManager = { getSchedules: jest.fn().mockResolvedValue(new Map([['plan-01', [existing]]])), activateLoadedSchedule: jest.fn(), removeSchedule: jest.fn() };
		const manager = { cronManager, createOrUpdateSchedules: jest.fn() };
		const storages = { getById: jest.fn().mockResolvedValue({ id: 'storage-01', name: 'Example storage', type: 'local', settings: {}, credentials: {} }) };
		const reconciler = new ScheduleReconciler(manager as any, { getAll: jest.fn().mockResolvedValue([saved]) } as any, storages as any);
		return { manager, cronManager, storages, reconciler };
	}
	it('repairs a stale cached timezone, without creating a second schedule, then releases its startup hold', async () => {
		const f = fixture({ type: 'backup', cronExpression: '00 4 * * *', options: { isActive: true, settings: { interval: { ...plan.settings.interval, timeZone: 'UTC' } } } });
		await f.reconciler.reconcileSchedules();
		expect(f.manager.createOrUpdateSchedules).toHaveBeenCalledWith('plan-01', expect.objectContaining({ settings: plan.settings }), 'update');
		expect(f.cronManager.activateLoadedSchedule).toHaveBeenCalledWith('plan-01', 'backup');
		expect(f.manager.createOrUpdateSchedules.mock.invocationCallOrder[0]).toBeLessThan(f.cronManager.activateLoadedSchedule.mock.invocationCallOrder[0]);
	});
	it('does not alter an existing legacy server-time plan', async () => {
		const legacy = { ...plan, settings: { interval: { type: 'daily', time: '04:00AM' } } };
		const f = fixture({ type: 'backup', cronExpression: '00 4 * * *', options: { isActive: true, settings: legacy.settings } }, legacy);
		await f.reconciler.reconcileSchedules();
		expect(f.manager.createOrUpdateSchedules).not.toHaveBeenCalled();
		expect(f.cronManager.activateLoadedSchedule).toHaveBeenCalledTimes(1);
		expect(legacy.settings.interval).not.toHaveProperty('timeZone');
	});
	it('keeps a failed reconciliation on hold instead of dispatching stale cached work', async () => {
		const f = fixture({ type: 'backup', cronExpression: '0 9 * * *', options: {} });
		f.storages.getById.mockResolvedValue(null as any);
		await f.reconciler.reconcileSchedules();
		expect(f.cronManager.activateLoadedSchedule).not.toHaveBeenCalled();
	});
	it('does not create backup timers for another scheduler-owned sync workflow', async () => {
		const f = fixture({ type: 'sync', options: {} }, { ...plan, sourceType: 'storage', method: 'sync' });
		await f.reconciler.reconcileSchedules();
		expect(f.manager.createOrUpdateSchedules).not.toHaveBeenCalled();
		expect(f.cronManager.activateLoadedSchedule).not.toHaveBeenCalled();
	});
});

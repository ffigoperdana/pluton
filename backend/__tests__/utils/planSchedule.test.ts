import { Cron } from 'croner';
import { preparePlanInterval, previewPlanSchedule, scheduleTimeZone } from '../../src/utils/planSchedule';
import type { PlanInterval } from '../../src/types/plans';

const daily: PlanInterval = { type: 'daily', time: '04:00AM', timeZone: 'Asia/Jakarta' };
describe('explicit backup schedule timezone', () => {
	it.each([
		['2026-10-23T12:00:00Z', '2026-10-23T21:00:00.000Z'],
		['2026-10-31T22:00:00Z', '2026-11-01T21:00:00.000Z'],
		['2026-12-31T12:00:00Z', '2026-12-31T21:00:00.000Z'],
		['2026-12-31T22:00:00Z', '2027-01-01T21:00:00.000Z'],
	])('calculates 04:00 WIB from %s without changing UTC timestamps', (now, next) => {
		expect(previewPlanSchedule(daily, new Date(now)).nextRunAt).toBe(next);
	});
	it('reproduces the old UTC-container interpretation as 11:00 WIB', () => {
		const cron = new Cron('0 4 * * *', { timezone: 'UTC', paused: true });
		const next = cron.nextRun(new Date('2026-10-23T12:00:00Z'))!;
		expect(next.toISOString()).toBe('2026-10-24T04:00:00.000Z');
		expect(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', hourCycle: 'h23' }).format(next)).toBe('11');
		cron.stop();
	});
	it('weekly Monday 04:00 WIB falls on Sunday UTC, including legacy Thursday spelling', () => {
		expect(previewPlanSchedule({ ...daily, type: 'weekly', days: 'mon' }, new Date('2026-10-23T12:00:00Z')).nextRunAt).toBe('2026-10-25T21:00:00.000Z');
		expect(previewPlanSchedule({ ...daily, type: 'weekly', days: 'thur' }, new Date('2026-10-23T12:00:00Z')).nextRunAt).toBe('2026-10-28T21:00:00.000Z');
	});
	it('monthly and AM/PM boundaries are interpreted in the selected zone', () => {
		expect(previewPlanSchedule({ ...daily, type: 'monthly', days: 'first' }, new Date('2026-10-31T12:00:00Z')).nextRunAt).toBe('2026-10-31T21:00:00.000Z');
		expect(previewPlanSchedule({ ...daily, time: '12:00AM' }, new Date('2026-10-31T12:00:00Z')).nextRunAt).toBe('2026-10-31T17:00:00.000Z');
	});
	it('uses IANA rules for another zone across DST, rather than a hardcoded offset', () => {
		expect(previewPlanSchedule({ ...daily, timeZone: 'America/New_York' }, new Date('2026-03-07T12:00:00Z')).nextRunAt).toBe('2026-03-08T08:00:00.000Z');
	});
	it('defaults only new plans; unrelated old-client edits retain explicit or absent zones', () => {
		const old: PlanInterval = { type: 'daily', time: '04:00AM' };
		expect(preparePlanInterval(old).timeZone).toBe('Asia/Jakarta');
		expect(preparePlanInterval(old, old)).toEqual(old);
		expect(preparePlanInterval(old, { ...old, timeZone: 'UTC' }).timeZone).toBe('UTC');
		expect(preparePlanInterval(daily, old).timeZone).toBe('Asia/Jakarta');
		expect(old).not.toHaveProperty('timeZone');
		expect(previewPlanSchedule(old).timeZone).toBe(scheduleTimeZone());
		expect(previewPlanSchedule(old).legacyTimeZone).toBe(true);
	});
	it.each(['+07:00', 'invalid/zone', '', null, 7])('rejects invalid timezone %s without a fallback', timeZone => {
		expect(() => preparePlanInterval({ ...daily, timeZone } as any)).toThrow();
	});
	it.each([null, {}, { type: 'custom' }, { ...daily, time: '25:00AM' }, { ...daily, minutes: 500 }])('rejects malformed preview input', interval => {
		expect(() => previewPlanSchedule(interval as any)).toThrow();
	});
	it('restart/downtime previews are strictly future-only, with no catch-up or automatic replay', () => {
		const before = previewPlanSchedule(daily, new Date('2026-10-23T20:59:59Z'));
		const after = previewPlanSchedule(daily, new Date('2026-10-23T21:00:01Z'));
		expect(before.nextRunAt).toBe('2026-10-23T21:00:00.000Z');
		expect(after.nextRunAt).toBe('2026-10-24T21:00:00.000Z');
		expect(after.missedRunPolicy).toBe('skip');
	});
});

import { Cron } from 'croner';
import type { PlanInterval } from '../types/plans';
import { AppError } from './AppError';
import { intervalToCron } from './intervalToCron';

export const DEFAULT_PLAN_TIME_ZONE = 'Asia/Jakarta';

/** Missing timezone means the historical process-local schedule, never WIB by inference. */
export function scheduleTimeZone(value?: unknown): string {
	const zone = value === undefined ? Intl.DateTimeFormat().resolvedOptions().timeZone : value;
	if (typeof zone !== 'string' || zone.length > 100 || !zone || /^[+-]/.test(zone))
		throw new AppError(400, 'Use a valid IANA schedule timezone, for example Asia/Jakarta or UTC.');
	try {
		return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
	} catch {
		throw new AppError(400, 'Use a valid IANA schedule timezone, for example Asia/Jakarta or UTC.');
	}
}

export function previewPlanSchedule(interval: PlanInterval, now = new Date()) {
	if (!interval || typeof interval !== 'object' ||
		!['hourly', 'daily', 'weekly', 'monthly', 'days', 'hours', 'minutes'].includes(interval.type))
		throw new AppError(400, 'Invalid backup interval.');
	if (interval.time !== undefined && interval.time !== '' &&
		(typeof interval.time !== 'string' || !/^(0?[1-9]|1[0-2]):[0-5]\d(?:AM|PM)$/i.test(interval.time)))
		throw new AppError(400, 'Schedule time must use HH:MMAM or HH:MMPM.');
	if (interval.days !== undefined && (typeof interval.days !== 'string' || interval.days.length > 100))
		throw new AppError(400, 'Invalid schedule days.');
	if (interval.hours !== undefined && (typeof interval.hours !== 'string' || interval.hours.length > 10))
		throw new AppError(400, 'Invalid schedule hours.');
	if (interval.minutes !== undefined && (typeof interval.minutes !== 'number' ||
		!Number.isInteger(interval.minutes) || interval.minutes < 1 || interval.minutes > 59))
		throw new AppError(400, 'Schedule minutes must be between 1 and 59.');
	const timeZone = scheduleTimeZone(interval.timeZone);
	let cron: Cron | undefined;
	try {
		cron = new Cron(intervalToCron(interval), { timezone: timeZone, paused: true });
		return {
			timeZone,
			legacyTimeZone: interval.timeZone === undefined,
			nextRunAt: cron.nextRun(now)?.toISOString() ?? null,
			evaluatedAt: now.toISOString(),
			missedRunPolicy: 'skip' as const,
		};
	} catch {
		throw new AppError(400, 'Invalid backup schedule.');
	} finally {
		cron?.stop();
	}
}

/** Creation defaults are explicit; old-client edits preserve the stored zone (including absence). */
export function preparePlanInterval(interval: PlanInterval, previous?: PlanInterval): PlanInterval {
	const timeZone = interval?.timeZone !== undefined ? interval.timeZone : (previous ? previous.timeZone : DEFAULT_PLAN_TIME_ZONE);
	const result = { ...interval, ...(timeZone !== undefined ? { timeZone } : {}) };
	previewPlanSchedule(result);
	return result;
}

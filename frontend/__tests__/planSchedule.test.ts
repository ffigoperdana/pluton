import assert from 'node:assert/strict';
import test from 'node:test';
import { scheduleSummary } from '../src/utils/planSchedule.ts';
import type { SchedulePreview } from '../src/utils/planSchedule.ts';

const preview: SchedulePreview = { timeZone: 'Asia/Jakarta', legacyTimeZone: false, nextRunAt: '2026-10-23T21:00:00.000Z', evaluatedAt: '2026-10-23T12:00:00.000Z', missedRunPolicy: 'skip' };
test('the backend UTC instant is rendered as 04:00 WIB on the next local date, independent of browser timezone', () => {
   assert.match(scheduleSummary(preview), /24 Oct 2026, 04:00/);
   assert.match(scheduleSummary(preview), /Asia\/Jakarta \(WIB\)/);
   assert.match(scheduleSummary({ ...preview, timeZone: 'UTC' }), /23 Oct 2026, 21:00.*UTC/);
});
test('paused and exhausted schedules do not promise an execution', () => {
   assert.match(scheduleSummary(preview, false), /^Paused/);
   assert.match(scheduleSummary({ ...preview, nextRunAt: null }), /^No future calendar slot/);
});

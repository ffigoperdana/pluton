import type { PlanInterval } from '../../../@types/plans';
import { useSchedulePreview } from '../../../services/plans';
import { scheduleSummary } from '../../../utils/planSchedule';
import IntervalField from '../../common/form/IntervalField/IntervalField';
import classes from './PlanScheduleField.module.scss';

export function PlanScheduleSummary({ interval, active = true }: { interval: PlanInterval; active?: boolean }) {
   const preview = useSchedulePreview(interval);
   return <p className={classes.summary} role="status" aria-live="polite">
      {preview.data ? scheduleSummary(preview.data, active) : preview.isError ? 'Schedule preview unavailable. Review the saved timezone before relying on the schedule.' : 'Calculating next scheduled time…'}
   </p>;
}

export default function PlanScheduleField({ interval, onUpdate }: { interval: PlanInterval; onUpdate: (value: PlanInterval) => void }) {
   const preview = useSchedulePreview(interval);
   const zones = [...new Set(['Asia/Jakarta', 'UTC', interval.timeZone].filter((zone): zone is string => !!zone))];
   return <div className={classes.schedule}>
      <IntervalField label="Backup Interval" fieldValue={interval} onUpdate={onUpdate} />
      <label className={classes.timeZone}>
         Schedule timezone
         <select value={interval.timeZone ?? ''} onChange={event => onUpdate({ ...interval, timeZone: event.target.value })}>
            {!interval.timeZone && <option value="">Keep legacy server timezone{preview.data ? ` (${preview.data.timeZone})` : ''}</option>}
            {zones.map(zone => <option key={zone} value={zone}>{zone === 'Asia/Jakarta' ? 'Asia/Jakarta — WIB' : zone}</option>)}
         </select>
      </label>
      {preview.data?.legacyTimeZone && <p className={classes.note}>This existing plan still uses server time ({preview.data.timeZone}). Selecting a timezone changes its interpretation only when you save. Review the next time before saving.</p>}
      <PlanScheduleSummary interval={interval} />
      <p className={classes.note}>Calendar preview from the server. Downtime is skipped without automatic catch-up. A busy queue or offline Agent can delay or refuse execution; check backup history.</p>
   </div>;
}

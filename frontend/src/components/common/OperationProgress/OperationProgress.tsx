import { useEffect, useState } from 'react';
import { elapsedLabel, elapsedSeconds, timestamp } from '../../../utils/recoveryProgress';
import type { OperationProgressState } from '../../../utils/recoveryProgress';
import classes from './OperationProgress.module.scss';

export function ElapsedTime({
   start,
   end,
   running,
   label = 'Elapsed since request',
}: {
   start?: number | string | null;
   end?: number | string | null;
   running: boolean;
   label?: string;
}) {
   const [now, setNow] = useState(Date.now);
   const first = timestamp(start),
      last = timestamp(end);
   useEffect(() => {
      if (!running || first === null || end != null) return;
      const timer = window.setInterval(() => setNow((previous) => Math.max(previous, Date.now())), 1000);
      return () => window.clearInterval(timer);
   }, [first, last, end, running]);
   return (
      <span aria-live="off" className={classes.elapsed}>
         {label}: <span>{elapsedLabel(!running && end == null ? null : elapsedSeconds(start, end, now))}</span>
      </span>
   );
}
export default function OperationProgress({
   state,
   start,
   end,
   timeLabel,
}: {
   state: OperationProgressState;
   start?: number | string | null;
   end?: number | string | null;
   timeLabel?: string;
}) {
   return (
      <section className={classes.progress} aria-label="Operation progress">
         <div role="status" aria-live="polite" aria-atomic="true">
            {state.label}
         </div>
         <div className={classes.track} aria-busy={state.busy}>
            {(state.busy || state.complete) && <progress aria-label={state.label} max={1} value={state.complete ? 1 : undefined} />}
         </div>
         <div className={classes.caption}>
            {state.busy
               ? 'In progress — percentage is not measurable.'
               : state.complete
                 ? 'Completion reported by the server.'
                 : 'No successful completion reported.'}
         </div>
         <ElapsedTime start={start} end={end} running={state.busy} label={timeLabel} />
      </section>
   );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { DownloadFailure } from '../utils/downloadFailure';

/** One request at a time. Background reads never toggle action controls or discard evidence. */
export function useDownloadJob<T extends { id: string }>(
   request: (id: string | undefined, cancel: boolean, signal: AbortSignal) => Promise<T>,
   interval: (job: T) => number | false,
   enabled = true,
   initialId?: string,
) {
   const [job, setJob] = useState<T>();
   const [error, setError] = useState('');
   const [actionError, setActionError] = useState('');
   const [busy, setBusy] = useState(false);
   const [revision, setRevision] = useState(0);
   const [observedAt, setObservedAt] = useState(() => Date.now());
   const current = useRef<T>();
   const rememberedId = useRef(initialId);
   const polling = useRef<AbortController>();
   const action = useRef<AbortController>();
   const save = useCallback((value: T) => {
      current.current = value;
      setJob(value);
      setObservedAt(Date.now());
      setError('');
   }, []);
   useEffect(
      () => () => {
         action.current?.abort();
      },
      [],
   );
   useEffect(() => {
      if (!enabled) return;
      const stop = new AbortController();
      polling.current = stop;
      let timer: ReturnType<typeof setTimeout>;
      let failures = 0;
      const schedule = (ms: number) => {
         // Oversized Retry-After values must not overflow into an immediate retry loop.
         if (!stop.signal.aborted) timer = setTimeout(poll, Math.min(2147483647, ms));
      };
      const poll = async () => {
         if (stop.signal.aborted) return;
         const attempt = new AbortController();
         const abort = () => {
            clearTimeout(deadline);
            attempt.abort();
         };
         stop.signal.addEventListener('abort', abort, { once: true });
         const deadline = setTimeout(() => attempt.abort(), 30000);
         try {
            const next = await request(current.current?.id || rememberedId.current, false, attempt.signal);
            if (stop.signal.aborted) return;
            if (attempt.signal.aborted) throw new Error('Status request timed out.');
            save(next);
            failures = 0;
            const delay = interval(next);
            if (delay !== false) schedule(delay);
         } catch (failure) {
            if (stop.signal.aborted) return;
            setError(attempt.signal.aborted ? 'Status request timed out.' : failure instanceof Error ? failure.message : 'Status unavailable.');
            const retryAt = Number((failure as { retryAt?: number })?.retryAt) || 0;
            if (!(failure instanceof DownloadFailure) || failure.transient)
               schedule(Math.max(Math.min(30000, 2000 * 2 ** Math.min(failures++, 4)), retryAt - Date.now()));
         } finally {
            clearTimeout(deadline);
            stop.signal.removeEventListener('abort', abort);
         }
      };
      void poll();
      return () => {
         stop.abort();
         clearTimeout(timer);
      };
   }, [request, interval, enabled, revision, save]);
   const refresh = useCallback(() => {
      if (action.current) return;
      polling.current?.abort();
      setRevision((value) => value + 1);
   }, []);
   const perform = async <R>(operation: (signal: AbortSignal) => Promise<R>): Promise<R | undefined> => {
      if (action.current) return;
      const stop = new AbortController();
      action.current = stop;
      polling.current?.abort();
      setBusy(true);
      setActionError('');
      try {
         const result = await operation(stop.signal);
         if (stop.signal.aborted) return;
         setError('');
         return result;
      } catch (failure) {
         if (!stop.signal.aborted) setActionError(failure instanceof Error ? failure.message : 'Action was not confirmed.');
      } finally {
         if (!stop.signal.aborted) {
            action.current = undefined;
            setBusy(false);
            setRevision((value) => value + 1);
         }
      }
   };
   const cancel = () =>
      perform(async (signal) => {
         if (!current.current) return;
         const next = await request(current.current.id, true, signal);
         if (!signal.aborted) save(next);
         return true;
      });
   const restart = () => {
      if (action.current) return;
      polling.current?.abort();
      current.current = undefined;
      rememberedId.current = undefined;
      setJob(undefined);
      setError('');
      setActionError('');
      setRevision((value) => value + 1);
   };
   return { job, error, actionError, busy, observedAt, refresh, cancel, restart, perform };
}

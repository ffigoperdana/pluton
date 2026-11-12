import { createTemporaryId } from '../../../utils/temporaryId';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL } from '../../../utils/constants';
import { mutationResponse } from '../../../utils/httpResponse';
import {
   recoveryRequestId,
   recoveryBlocking,
   recoveryCanApprove,
   recoveryPolling,
   recoveryStatus,
   recoveryWorkDetail,
   recoveryTone,
   recoveryLabel,
   recoveryInProgress,
   recoveryFailureAdvice,
   recoveryRetrySummary,
   recoveryDecision,
   recoverySteps,
   type AssistedRecoveryDiagnostic,
   type AssistedRecoveryJob,
} from '../../../utils/assistedRecovery';
import { ElapsedTime } from '../../common/OperationProgress/OperationProgress';
import { elapsedLabel } from '../../../utils/recoveryProgress';
import classes from './AssistedRecovery.module.scss';

interface Props {
   planId: string;
   backupId: string;
   manual?: boolean;
   initialIncludes?: string[];
   /** Plan recovery source policy; the server enforces it independently. */
   policy?: 'assisted' | 'automatic';
   /** Wait for an explicit "Start recovery" instead of checking on open. */
   requireStart?: boolean;
   onPrimaryReady?: () => void;
   close?: () => void;
}
async function request<T>(suffix: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
   const data = await mutationResponse<{ success: true; result: T }>(API_URL + '/assisted-recovery' + suffix, {
      method,
      signal,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
   });
   return data.result;
}
function DiagnosticDetails({ diagnostic, showCode = false }: { diagnostic: AssistedRecoveryDiagnostic; showCode?: boolean }) {
   const retries = recoveryRetrySummary(diagnostic);
   return (
      <>
         <span className={classes.diagnostic}>
            Phase: {recoveryLabel(diagnostic.phase)} · Operation: {recoveryLabel(diagnostic.operation)} · Elapsed:{' '}
            {elapsedLabel(Math.floor(diagnostic.elapsedMs / 1000))}
            {showCode && (
               <>
                  {' · Code: '}
                  <code>{diagnostic.failureCode}</code>
               </>
            )}
            {diagnostic.timeoutCategory && (
               <>
                  {' · Timeout: '}
                  {recoveryLabel(diagnostic.timeoutCategory)} <code>{diagnostic.timeoutCategory}</code>
               </>
            )}
         </span>
         {retries && <span className={classes.diagnostic}>{retries}</span>}
      </>
   );
}
export default function AssistedRecovery({
   planId,
   backupId,
   manual = false,
   initialIncludes = [],
   policy = 'assisted',
   requireStart = false,
   onPrimaryReady,
   close,
}: Props) {
   const client = useQueryClient();
   const [epoch, setEpoch] = useState(() => createTemporaryId());
   const key = ['assisted-recovery', planId, backupId, epoch];
   const requests = useRef(new AbortController());
   const scopedRequest = async <T,>(suffix: string, method = 'GET', body?: unknown, querySignal?: AbortSignal) => {
      const signal = querySignal ? AbortSignal.any([querySignal, requests.current.signal]) : requests.current.signal;
      const result = await request<T>(suffix, method, body, signal);
      if (signal.aborted) throw new Error('Session changed. Refresh recovery status.');
      return result;
   };

   const automaticCheck = useRef(false);
   const deliveredPrimary = useRef<string>();
   const [path, setPath] = useState(''),
      [selected, setSelected] = useState(''),
      [jobId, setJobId] = useState<string>();
   const jobs = useQuery({
      queryKey: key,
      queryFn: ({ signal }) => scopedRequest<AssistedRecoveryJob[]>('?' + new URLSearchParams({ planId, backupId }), 'GET', undefined, signal),
      gcTime: 0,
      retry: false,
      refetchOnWindowFocus: true,
      refetchInterval: (query) => (query.state.error ? false : recoveryPolling(query.state.data || [])),
   });
   const latestJob = jobs.data?.find((row) => row.id === jobId) || jobs.data?.find(recoveryBlocking) || jobs.data?.[0];
   // An explicit-start dialog never presents an earlier job as the current recovery.
   const awaitingStart = requireStart && !manual && !jobId && !jobs.data?.some(recoveryBlocking);
   const job = awaitingStart ? undefined : latestJob;
   const update = (row: AssistedRecoveryJob) => {
      setJobId(row.id);
      client.setQueryData<AssistedRecoveryJob[]>(key, (old) => [row, ...(old || []).filter((item) => item.id !== row.id)]);
      void client.invalidateQueries({ queryKey: key });
   };
   const start = useMutation({
      mutationFn: (mode: 'prefer-primary' | 'manual-replica') =>
         scopedRequest<AssistedRecoveryJob>('', 'POST', {
            planId,
            backupId,
            requestKey: recoveryRequestId(),
            mode,
            includes: path.trim() ? [path.trim()] : initialIncludes,
            excludes: [],
         }),
      retry: false,
      onSuccess: update,
   });
   const approve = useMutation({
      mutationFn: () => scopedRequest<AssistedRecoveryJob>('/' + job!.id + '/approve', 'POST', { replicationId: selected }),
      retry: false,
      onSuccess: update,
      onError: () => {
         void jobs.refetch();
      },
   });
   const cancel = useMutation({
      mutationFn: () => scopedRequest<AssistedRecoveryJob>('/' + job!.id + '/cancel', 'POST', {}),
      retry: false,
      onSuccess: update,
   });
   const retryPrimary = useMutation({
      mutationFn: async () => {
         if (job) await scopedRequest('/' + job.id + '/cancel', 'POST', {});
         return scopedRequest<AssistedRecoveryJob>('', 'POST', {
            planId,
            backupId,
            requestKey: recoveryRequestId(),
            mode: 'prefer-primary',
            includes: manual ? job?.includes || [] : initialIncludes,
            excludes: manual ? job?.excludes || [] : [],
         });
      },
      retry: false,
      onSuccess: update,
   });
   useEffect(() => {
      let disposed = false;
      queueMicrotask(() => {
         if (disposed || manual || !jobs.isSuccess || automaticCheck.current) return;
         const active = jobs.data.find(recoveryBlocking);
         // An Automatic Failover recovery may restore from a replica without another click,
         // so it starts only from an explicit operator action, never from opening the dialog.
         if (requireStart && !active) return;
         automaticCheck.current = true;
         if (active) setJobId(active.id);
         else start.mutate('prefer-primary');
      });
      return () => {
         disposed = true;
      };
   }, [manual, jobs.isSuccess]);
   useEffect(() => {
      if (job?.status === 'primary-ready' && job.id === jobId && !manual && automaticCheck.current && deliveredPrimary.current !== job.id) {
         deliveredPrimary.current = job.id;
         onPrimaryReady?.();
      }
   }, [job?.id, job?.status, jobId, manual, onPrimaryReady]);
   useEffect(() => {
      const passed = job?.candidates.filter((candidate) => candidate.state === 'passed') || [];
      if (!passed.some((candidate) => candidate.replicationId === selected)) setSelected(passed[0]?.replicationId || '');
   }, [job?.id, job?.candidates, selected]);
   useEffect(() => {
      const changed = () => {
         requests.current.abort();
         requests.current = new AbortController();
         automaticCheck.current = true;
         setJobId(undefined);
         setSelected('');
         setEpoch(createTemporaryId());
      };
      let channel: BroadcastChannel | undefined;
      try {
         channel = new BroadcastChannel('pluton-export-activity');
         channel.onmessage = (event) => {
            if (event.data === 'session-changed') changed();
            if (event.data === 'refresh') void client.invalidateQueries({ queryKey: ['assisted-recovery', planId, backupId] });
         };
      } catch {
         /* Optional; focus GET remains available. */
      }
      window.addEventListener('pluton-export-session', changed);
      return () => {
         requests.current.abort();
         requests.current = new AbortController();
         channel?.close();
         window.removeEventListener('pluton-export-session', changed);
      };
   }, [planId, backupId, client]);
   const intentMatches =
      manual || !job || (JSON.stringify([...job.includes].sort()) === JSON.stringify([...initialIncludes].sort()) && job.excludes.length === 0);
   const busy = start.isPending || approve.isPending || cancel.isPending || retryPrimary.isPending;
   const active = job && recoveryInProgress(job);
   const workDetail = job && recoveryWorkDetail(job);
   const steps = job && job.policy === 'automatic' && job.primary && job.primary.state !== 'not-checked' ? recoverySteps(job) : [];
   const decision = job && recoveryDecision(job);
   const error = jobs.error || start.error || approve.error || cancel.error || retryPrimary.error;
   const beginRecovery = () => {
      automaticCheck.current = true;
      start.mutate('prefer-primary');
   };
   return (
      <section aria-label="Assisted recovery" className={classes.recovery}>
         <header className={classes.head}>
            <h4>
               {job?.primary?.state === 'unavailable'
                  ? job.policy === 'automatic'
                     ? 'Primary Repository Unavailable · Automatic Failover'
                     : 'Primary Repository Unavailable'
                  : manual
                    ? 'Manual Verified Replica Recovery'
                    : policy === 'automatic'
                      ? 'Automatic Failover Recovery'
                      : 'Checking Recovery Sources'}
            </h4>
            <p className={classes.context}>
               Plan: {job?.planName || planId} · Backup: <code>{backupId}</code>
            </p>
         </header>
         <p className={classes.note}>
            Replica validation is read-only. Recovery writes only to private staging. Database import and production-target recovery require their
            existing separate authorization.
         </p>
         {error && (
            <p role="alert" className={classes.alert}>
               {error instanceof Error ? error.message : 'Recovery request failed safely.'} Refresh to check server state before retrying.
            </p>
         )}
         {jobs.isPending && (
            <p role="status" className={classes.note}>
               Loading owner-authorized recovery history…
            </p>
         )}
         {awaitingStart && (
            <div className={classes.manual}>
               <p className={classes.note}>
                  This plan uses Automatic Failover. Pluton checks the primary SFTP first and opens the normal restore when it is available. If
                  the primary is unreachable, Pluton continues automatically with the first S3 replica that passes identity and integrity checks,
                  restoring only into isolated staging. No database is imported and no live target is overwritten.
               </p>
               <button type="button" className={classes.primary} disabled={busy || jobs.isPending || !!jobs.error} onClick={beginRecovery}>
                  Start recovery
               </button>
            </div>
         )}
         {job && (
            <>
               <div className={`${classes.status} ${classes[recoveryTone(job)]}`}>
                  {active && <span className={classes.spinner} data-recovery-spinner aria-hidden="true" />}
                  <div>
                     <div role="status" aria-live="polite" aria-atomic="true">
                        {active && <strong>{recoveryLabel(job.phase)}</strong>}
                        <p>{recoveryStatus(job)}</p>
                        {job.status === 'checking' && <p>Closing this window does not cancel server work.</p>}
                        {workDetail && <p>{workDetail}</p>}
                     </div>
                     {active && (
                        <ElapsedTime
                           start={
                              job.activeSince ??
                              (job.status === 'checking'
                                 ? job.createdAt
                                 : job.audit.find((event) => event.event === 'operator-approved' || event.event === 'automatic-source-selected')
                                      ?.at)
                           }
                           running
                           label="Elapsed"
                        />
                     )}
                  </div>
               </div>
               {steps.length > 0 && (
                  <ol className={classes.steps} aria-label="Recovery progress">
                     {steps.map((step, index) => (
                        <li key={index} className={classes[step.state]} data-step-state={step.state}>
                           {step.label}
                        </li>
                     ))}
                  </ol>
               )}
               {!intentMatches && (
                  <p role="alert" className={classes.alert}>
                     This pending job has a different selection. Review and cancel it before checking the newly requested selection. Its old approval
                     cannot authorize the new selection.
                  </p>
               )}
               <dl className={classes.meta}>
                  <dt>Job</dt>
                  <dd>
                     <code>{job.id}</code>
                  </dd>
                  <dt>Requested snapshot</dt>
                  <dd>
                     <code>{job.sourceSnapshotId}</code>
                  </dd>
                  <dt>Phase</dt>
                  <dd title={job.phase}>{recoveryLabel(job.phase)}</dd>
                  <dt>Primary</dt>
                  <dd title={job.primary?.state || 'checking'}>
                     {recoveryLabel(job.primary?.state || 'checking')}
                     {job.primary?.code && (
                        <>
                           {' · '}
                           {recoveryLabel(job.primary.code)} <code>{job.primary.code}</code>
                        </>
                     )}
                     {job.primary?.diagnostic && <DiagnosticDetails diagnostic={job.primary.diagnostic} />}
                  </dd>
                  <dt>Operation</dt>
                  <dd>{job.operation}</dd>
                  <dt>Target</dt>
                  <dd>{job.target}</dd>
                  <dt>Selection</dt>
                  <dd>{job.includes.length ? job.includes.join(', ') : 'Full snapshot'}</dd>
                  {job.policy === 'automatic' && (
                     <>
                        <dt>Policy</dt>
                        <dd>Automatic Failover</dd>
                     </>
                  )}
               </dl>
               {job.failureCode && (
                  <div role="alert" className={classes.alert}>
                     <p>
                        Diagnostic: {recoveryLabel(job.failureCode)} <code>{job.failureCode}</code>.
                     </p>
                     {job.diagnostic && <DiagnosticDetails diagnostic={job.diagnostic} showCode={job.failureCode !== job.diagnostic.failureCode} />}
                     <p>{recoveryFailureAdvice(job)}</p>
                  </div>
               )}
               {!!job.candidates.length && (
                  <fieldset className={classes.replicas} disabled={busy || job.status !== 'awaiting-approval' || job.expired}>
                     <legend>Available replicas (configured priority)</legend>
                     {job.candidates.map((candidate) => (
                        <div key={candidate.replicationId} className={classes.replica}>
                           <label>
                              <input
                                 type="radio"
                                 name={'replica-' + job.id}
                                 value={candidate.replicationId}
                                 checked={selected === candidate.replicationId}
                                 disabled={candidate.state !== 'passed'}
                                 onChange={() => setSelected(candidate.replicationId)}
                              />
                              <span>
                                 S3 Replica {candidate.position} —{' '}
                                 {candidate.state === 'passed' ? (
                                    'Replica verified; recovery preflight passed'
                                 ) : (
                                    <>
                                       Unavailable: {recoveryLabel(candidate.code)} <code>{candidate.code}</code>
                                    </>
                                 )}
                              </span>
                           </label>
                           {candidate.diagnostic && <DiagnosticDetails diagnostic={candidate.diagnostic} />}
                           {candidate.destinationSnapshotId && (
                              <p>
                                 Destination snapshot: <code>{candidate.destinationSnapshotId}</code>
                              </p>
                           )}
                           <p>Staged recovery tested: {candidate.recoveryTested ? 'Passed' : 'Not yet tested in this request'}</p>
                        </div>
                     ))}
                  </fieldset>
               )}
               {job.status === 'awaiting-approval' && (
                  <p className={classes.note}>
                     Approval is tied to this owner, plan, source snapshot, selected destination snapshot, operation, selection and private staging
                     target. It expires at {new Date(job.expiresAt).toLocaleTimeString()} and can be used once.
                  </p>
               )}
               {job.stats && (
                  <p className={classes.note}>
                     Verified: {job.stats.files} files · {job.stats.bytes.toLocaleString()} bytes. The result remains in private staging until
                     discarded.
                  </p>
               )}
               {decision && <p className={classes.note}>{decision}</p>}
               <div className={classes.actions}>
                  {job.status === 'awaiting-approval' && (
                     <button
                        type="button"
                        className={classes.primary}
                        disabled={busy || !intentMatches || !recoveryCanApprove(job, selected)}
                        onClick={() => approve.mutate()}
                     >
                        Continue with S3 Replica
                     </button>
                  )}
                  {job.status !== 'cancelled' && (
                     <button type="button" className={classes.danger} disabled={busy} onClick={() => cancel.mutate()}>
                        {job.status === 'completed' ? 'Discard staged result' : 'Cancel Recovery'}
                     </button>
                  )}
                  {job.status !== 'running' && (
                     <button type="button" className={classes.secondary} disabled={busy} onClick={() => retryPrimary.mutate()}>
                        Retry Primary
                     </button>
                  )}
               </div>
               <details className={classes.audit}>
                  <summary>Safe audit history</summary>
                  <ul>
                     {job.audit.map((event, index) => (
                        <li key={index}>
                           {new Date(event.at).toLocaleTimeString()} — {recoveryLabel(event.event)}
                           {event.code && (
                              <>
                                 {' · '}
                                 {recoveryLabel(event.code)} <code>{event.code}</code>
                              </>
                           )}
                        </li>
                     ))}
                  </ul>
               </details>
            </>
         )}
         {manual && !jobs.data?.some(recoveryBlocking) && (
            <div className={classes.manual}>
               {job && <h5 className={classes.subhead}>Start a new replica check</h5>}
               <label>
                  Exact file or directory path in the snapshot (optional)
                  <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="/srv/example-app" />
               </label>
               <p className={classes.note}>
                  Leave empty for the full snapshot, including recorded database artifacts. SQL artifact recovery does not import a database.
               </p>
               <button
                  type="button"
                  className={classes.primary}
                  disabled={busy || jobs.isPending || !!jobs.error}
                  onClick={() => start.mutate('manual-replica')}
               >
                  Check replica recovery
               </button>
            </div>
         )}
         <div className={classes.footer}>
            <button
               type="button"
               className={classes.secondary}
               disabled={jobs.isFetching}
               onClick={() => {
                  void jobs.refetch();
               }}
            >
               Refresh recovery status
            </button>
            {close && (
               <button type="button" className={classes.secondary} onClick={close}>
                  Close
               </button>
            )}
            <p className={classes.note}>
               Closing or navigating leaves server work and pending approval intact. Reopen Restore or replica details for this backup to recover its
               authorized job state.
            </p>
         </div>
      </section>
   );
}

import { useState } from 'react';
import type { SourceAccessRequest, SourceAccessValidation } from '../../../@types/agentSourceAccess';
import { useCancelSourceAccess, useRefreshSourceAccess, useSourceAccess, useSourceAccessMutation } from '../../../services/agentSourceAccess';
import {
   affectedSourcePlans,
   currentSourceValidation,
   effectiveSourceRoots,
   hostApprovalCommand,
   parseSourceRoots,
   selectedSourceRoots,
   sourceAccessReady,
   sourceAccessStatus,
   sourceAccessProblem,
   sourceAuthorizationLabel,
   sourceAuthorizationMode,
   sourceInsideRoot,
   sourceMaximumRoots,
   sourcePathError,
   sourceRequestPending,
   sourceModeSetupPending,
   sourceWithinDelegation,
} from '../../../utils/agentSourceAccess';
import { copyToClipboard } from '../../../utils/clipboard';
import Button from '../../common/Button/Button';
import classes from './SourceAccess.module.scss';
import SourceAuthorizationSetup from './SourceAuthorizationSetup';
import SourceAccessHistory from './SourceAccessHistory';

const SourceAccess = ({ deviceId, agentId }: { deviceId: string; agentId: string }) => {
   const query = useSourceAccess(deviceId);
   const validate = useSourceAccessMutation(deviceId, 'validate');
   const apply = useSourceAccessMutation(deviceId, 'requests');
   const refresh = useRefreshSourceAccess(deviceId);
   const cancel = useCancelSourceAccess(deviceId);
   const [draft, setDraft] = useState('');
   const [selection, setSelection] = useState<{ version: number; revision: string; roots: string[] } | null>(null);
   const [confirmedPlanIds, setConfirmedPlanIds] = useState<string[] | null>(null);
   const [confirmedGrantReview, setConfirmedGrantReview] = useState('');
   const [notice, setNotice] = useState('');
   const [error, setError] = useState('');
   const [copiedRequest, setCopiedRequest] = useState('');
   const [validationId, setValidationId] = useState('');
   const view = query.error ? undefined : query.data;
   const report = view?.report;
   const serverManaged = sourceAuthorizationMode(report) === 'server-managed';
   const maximumRoots = sourceMaximumRoots(report);
   const parsed = parseSourceRoots(draft);
   const reportedSelected = selectedSourceRoots(view);
   const selected =
      selection?.version === report?.effectiveVersion && selection?.revision === report?.hostPolicyRevision
         ? selection?.roots || []
         : reportedSelected;
   const selectableRoots = [...new Set([...(serverManaged ? [] : report?.approvedRoots || []), ...reportedSelected])];
   const currentValidation = currentSourceValidation(view, validationId, parsed.roots);
   const validatedPaths = currentValidation?.every(
      (item) =>
         item.status === 'approved' &&
         item.canonicalPath &&
         sourceWithinDelegation(item.canonicalPath, report) &&
         !sourcePathError(item.canonicalPath),
   )
      ? currentValidation.map((item) => item.canonicalPath!)
      : undefined;
   const removed = affectedSourcePlans(view?.affectedPlans || [], selected);
   const removedIds = removed.map((plan) => plan.id).sort();
   const confirmed = confirmedPlanIds !== null && JSON.stringify(confirmedPlanIds) === JSON.stringify(removedIds);
   const activeAffected = removed.some((plan) => plan.isActive);
   const pending = view?.requests.some(sourceRequestPending) === true;
   const busy = validate.isPending || apply.isPending || pending || sourceModeSetupPending(view);
   const ready = sourceAccessReady(view);
   const effective = effectiveSourceRoots(view);
   const selectionChanged = JSON.stringify([...selected].sort()) !== JSON.stringify([...reportedSelected].sort());
   const changedGrants =
      report?.rootStatuses.filter(
         (item) =>
            selected.includes(item.path) &&
            (item.code === 'source-host-approval-changed' || item.code === 'source-host-approval-revoked') &&
            maximumRoots.some((maximum) => sourceInsideRoot(item.path, maximum)),
      ) || [];
   const grantReviewKey = `${report?.hostPolicyRevision}:${report?.effectiveVersion}:${changedGrants
      .map((item) => item.path)
      .sort()
      .join('\n')}`;
   const requiresGrantReview = changedGrants.length > 0;
   const grantReviewConfirmed = confirmedGrantReview === grantReviewKey;
   const selectedOutsideHostPolicy = selected.some((root) => !maximumRoots.some((maximum) => sourceInsideRoot(root, maximum)));
   const selectionOverlaps = selected.some((root, index) =>
      selected.some((other, otherIndex) => index !== otherIndex && sourceInsideRoot(root, other)),
   );

   const send = async (kind: 'validate' | 'requests', roots: string[], confirmRemoval = false) => {
      if (!report || !ready || busy) return;
      setError('');
      setNotice('');
      try {
         const accepted = await (kind === 'validate' ? validate : apply).mutateAsync({
            expectedVersion: report.effectiveVersion,
            expectedHostPolicyRevision: report.hostPolicyRevision,
            roots,
            ...(confirmRemoval ? { confirmedAffectedPlanIds: removed.map((plan) => plan.id).sort() } : {}),
         });
         setNotice(`Request accepted: ${sourceAccessStatus(accepted.status)}. Approval and effective access are confirmed by the agent report.`);
         if (kind === 'validate') setValidationId(accepted.requestId);
         if (kind === 'requests') setSelection(null);
         if (kind === 'requests') setConfirmedGrantReview('');
      } catch (failure) {
         setError(failure instanceof Error ? failure.message : 'Could not submit source access. Refresh its status before trying again.');
      }
   };

   const requestPaths = () => {
      if (parsed.error || (serverManaged && !validatedPaths)) return;
      const combined = [...selected];
      for (const path of serverManaged ? validatedPaths! : parsed.roots)
         if (!combined.some((root) => sourceInsideRoot(path, root))) combined.push(path);
      if (
         combined.length > 32 ||
         combined.some((root, index) => combined.some((other, otherIndex) => index !== otherIndex && sourceInsideRoot(root, other)))
      ) {
         setError('The enabled and requested roots overlap or exceed 32 roots. Adjust the enabled selection before requesting access.');
         return;
      }
      void send('requests', combined, removed.length > 0);
   };

   const requestHistory = (request: SourceAccessRequest) => {
      const canonicalPending =
         request.validation?.filter((item) => item.status === 'pending-host-approval' && item.canonicalPath).map((item) => item.canonicalPath!) || [];
      const validationRows: SourceAccessValidation[] =
         request.validation || request.roots.map((path) => ({ requestedPath: path, status: 'pending-host-approval' }));
      return (
         <article className={classes.request} key={request.requestId}>
            <strong>
               {request.kind === 'validate' ? 'Validation' : request.kind === 'mode-setup' ? 'Policy change' : 'Access change'}:{' '}
               {sourceAccessStatus(request.status)}
            </strong>
            <p className={classes.muted}>{new Date(request.createdAt).toLocaleString()}</p>
            <dl className={classes.requestMetadata}>
               <dt>Request ID</dt>
               <dd>
                  <code>{request.requestId}</code>
               </dd>
               <dt>Type</dt>
               <dd>{request.kind}</dd>
               <dt>Expected version</dt>
               <dd>{request.expectedVersion}</dd>
               <dt>Host policy revision</dt>
               <dd>
                  <code>{request.expectedHostPolicyRevision}</code>
               </dd>
               {request.completedAt && (
                  <>
                     <dt>Completed</dt>
                     <dd>{new Date(request.completedAt).toLocaleString()}</dd>
                  </>
               )}
               {request.requestedMode && (
                  <>
                     <dt>Requested mode</dt>
                     <dd>{request.requestedMode}</dd>
                  </>
               )}
               {request.setupExpiresAt && (
                  <>
                     <dt>Setup expires</dt>
                     <dd>{new Date(request.setupExpiresAt).toLocaleString()}</dd>
                  </>
               )}
            </dl>
            <ul>
               {validationRows.map((item, index) => (
                  <li key={`${item.requestedPath}-${index}`}>
                     <code>{item.requestedPath}</code>
                     {item.canonicalPath && (
                        <>
                           {' '}
                           → <code>{item.canonicalPath}</code>
                        </>
                     )}
                     {request.validation && (
                        <>
                           {' '}
                           — {sourceAccessStatus(item.status)} {sourceAccessProblem(item.code) || ''}
                           {item.code && (
                              <details>
                                 <summary>Validation details</summary>
                                 <code>{item.code}</code>
                              </details>
                           )}
                        </>
                     )}
                  </li>
               ))}
            </ul>
            {request.resultCode === 'source-outcome-unconfirmed' && (
               <p className={classes.warning}>Outcome unconfirmed. Refresh the host report before making further changes.</p>
            )}
            {request.resultCode && (
               <details>
                  <summary>Request details</summary>
                  <code>{request.resultCode}</code>
               </details>
            )}
            {(request.status === 'queued' || request.status === 'pending-host-approval') && (
               <Button
                  text="Cancel request"
                  variant="tertiary"
                  size="sm"
                  disabled={cancel.isPending}
                  onClick={() => {
                     setError('');
                     void cancel
                        .mutateAsync(request.requestId)
                        .catch(() => setError('Could not cancel this request. Refresh its current status before trying again.'));
                  }}
               />
            )}
            {request.status === 'pending-host-approval' && (
               <div className={classes.warning}>
                  <p>
                     Pending paths cannot be backed up. A host administrator must review the canonical directories and grant read/traverse
                     permissions. Pluton does not change ownership, ACLs or sudo access.
                  </p>
                  {report && canonicalPending.length > 0 && (
                     <>
                        <p>Run on this agent host after reviewing these directories:</p>
                        <pre className={classes.command}>{hostApprovalCommand(agentId, report.hostPolicyRevision, canonicalPending)}</pre>
                        <Button
                           text={
                              copiedRequest === `${request.requestId}:${report.hostPolicyRevision}`
                                 ? 'Copied host approval command'
                                 : 'Copy host approval command'
                           }
                           variant="secondary"
                           size="sm"
                           icon="copy"
                           onClick={() => {
                              setError('');
                              void copyToClipboard(hostApprovalCommand(agentId, report.hostPolicyRevision, canonicalPending)).then(
                                 () => setCopiedRequest(`${request.requestId}:${report.hostPolicyRevision}`),
                                 () => setError('Could not copy the host approval command. Select and copy it manually.'),
                              );
                           }}
                        />
                     </>
                  )}
                  <p>
                     Then refresh the agent report, select the newly host-approved roots, and choose Apply enabled roots. Host approval alone does not
                     enable backup access.
                  </p>
               </div>
            )}
         </article>
      );
   };

   return (
      <section className={classes.panel} aria-label="Source Access">
         <div className={classes.heading}>
            <h3>Source Access</h3>
            <Button
               text={refresh.isPending ? 'Requesting report…' : 'Refresh agent report'}
               variant="secondary"
               size="sm"
               disabled={refresh.isPending || !view?.online}
               onClick={() => {
                  setError('');
                  void refresh.mutateAsync().catch(() => setError('Could not request a fresh agent report.'));
               }}
            />
         </div>
         <p>
            Current authorization mode: <strong>{sourceAuthorizationLabel(report)}</strong>
            {!report && ' — awaiting agent confirmation'}
         </p>
         <p>
            {serverManaged
               ? 'Manage backup source directories in Pluton within the scope delegated by this host. Each path still needs validation, explicit Apply and Linux read permissions.'
               : 'Host administrators approve the maximum access. Pluton enables a subset of those roots.'}{' '}
            Validation reads only explicitly submitted paths and does not start a backup.
         </p>
         {view && <SourceAuthorizationSetup key={`${deviceId}:${report?.hostPolicyRevision}`} deviceId={deviceId} agentId={agentId} access={view} />}
         {query.isPending && <p role="status">Loading source access…</p>}
         {query.error && (
            <p className={classes.error} role="alert">
               Source access details require an authenticated administrator session. Reconnect or refresh before continuing.
            </p>
         )}
         {view && !view.supported && (
            <p className={classes.notice}>Upgrade the agent to manage Source Access. Existing backups keep their host-configured access.</p>
         )}
         {view?.supported && (
            <>
               {!view.online && (
                  <p className={classes.warning} role="status">
                     Agent offline. Changes require a connected agent and a fresh report.
                  </p>
               )}
               {!view.reportFresh && (
                  <p className={classes.warning} role="status">
                     Awaiting a fresh agent report. Listed roots are the last reported state.
                  </p>
               )}
               {report?.policyError && (
                  <p className={classes.error} role="alert">
                     Host policy requires review: {report.policyError}. Refresh after the host administrator resolves it.
                  </p>
               )}
               {pending && (
                  <p className={classes.notice} role="status">
                     Awaiting agent validation or reload. Requested roots are not effective until the agent confirms them.
                  </p>
               )}
               {sourceModeSetupPending(view) && (
                  <p className={classes.warning} role="status">
                     Authorization mode setup is pending. Keep affected plans paused; source changes and new backups are blocked until the exact host
                     setup is confirmed or expires.
                  </p>
               )}
               {report && (
                  <>
                     <details className={classes.muted}>
                        <summary>Advanced policy details</summary>
                        <p>
                           Effective version: {report.effectiveVersion} · Host policy revision: <code>{report.hostPolicyRevision}</code>
                           {report.receivedAt && <> · Reported: {new Date(report.receivedAt).toLocaleString()}</>}
                        </p>
                     </details>
                     {serverManaged && (
                        <div className={classes.notice}>
                           <h4>Host-delegated scope</h4>
                           <ul>
                              {(report.delegatedRoots || []).map((root) => (
                                 <li key={root}>
                                    <code>{root}</code>
                                 </li>
                              ))}
                           </ul>
                           <p>
                              Pluton administrators can enable readable application directories within these prefixes without another host command.
                              The server cannot expand this scope. Directories outside it require a separately reviewed host change.
                           </p>
                        </div>
                     )}
                     <div className={classes.grid}>
                        <div>
                           <h4>{serverManaged ? 'Selected backup directories' : 'Host-approved and enabled roots'}</h4>
                           <p className={classes.muted}>Select the roots Pluton should enable.</p>
                           <ul className={classes.rootList}>
                              {selectableRoots.map((root) => {
                                 const status = report.rootStatuses.find((item) => item.path === root);
                                 const withinHostPolicy = maximumRoots.some((maximum) => sourceInsideRoot(root, maximum));
                                 return (
                                    <li className={classes.rootRow} key={root}>
                                       <label>
                                          <input
                                             type="checkbox"
                                             aria-label={`Enable ${root}`}
                                             checked={selected.includes(root)}
                                             disabled={!ready || busy || (!selected.includes(root) && !withinHostPolicy)}
                                             onChange={(event) => {
                                                setSelection({
                                                   version: report.effectiveVersion,
                                                   revision: report.hostPolicyRevision,
                                                   roots: event.target.checked ? [...selected, root] : selected.filter((value) => value !== root),
                                                });
                                                setConfirmedPlanIds(null);
                                                setConfirmedGrantReview('');
                                             }}
                                          />
                                          <code>{root}</code>
                                       </label>
                                       <span className={!status || status.status === 'readable' ? classes.muted : classes.error}>
                                          {status?.status || 'Not checked'} {sourceAccessProblem(status?.code)}
                                          {!withinHostPolicy && ' — host approval revoked'}
                                       </span>
                                    </li>
                                 );
                              })}
                           </ul>
                           {!selectableRoots.length && <p>No {serverManaged ? 'selected directories' : 'host-approved roots'} reported.</p>}
                           {report.approvedRoots.some((root) => sourcePathError(root)) && (
                              <p className={classes.warning}>
                                 This host has a broad or protected static root. Ask the host administrator to narrow the local configuration
                                 manually; Pluton cannot add such roots.
                              </p>
                           )}
                        </div>
                        <div>
                           <h4>Effective roots</h4>
                           <p className={classes.muted}>Enabled roots reported by the agent; permission failures remain unavailable.</p>
                           <ul className={classes.rootList}>
                              {report.effectiveRoots.map((root) => (
                                 <li className={classes.rootRow} key={root}>
                                    <code>{root}</code>
                                    <span className={effective.includes(root) ? classes.success : classes.error}>
                                       {effective.includes(root) ? 'Readable' : 'Unavailable'}
                                    </span>
                                 </li>
                              ))}
                           </ul>
                           {!report.effectiveRoots.length && <p>No roots are enabled.</p>}
                        </div>
                     </div>
                     {removed.length > 0 && (
                        <div className={classes.warning}>
                           <p>Removing access affects these plans. Pause them and finish any queued or running backups before applying.</p>
                           <ul>
                              {removed.map((plan) => (
                                 <li key={plan.id}>
                                    {plan.title} — {plan.isActive ? 'Active — pause required' : 'Paused'} — <code>{plan.sourcePath}</code>
                                 </li>
                              ))}
                           </ul>
                           <label className={classes.confirmation}>
                              <input
                                 type="checkbox"
                                 checked={confirmed}
                                 onChange={(event) => setConfirmedPlanIds(event.target.checked ? removedIds : null)}
                              />
                              I reviewed every affected plan and confirm the loss of source access.
                           </label>
                        </div>
                     )}
                     {selectionOverlaps && (
                        <p className={classes.error} role="alert">
                           Enabled roots overlap. Select the parent root or its children before applying.
                        </p>
                     )}
                     {requiresGrantReview && (
                        <div className={classes.warning} role="status">
                           <p>
                              The host approval changed for these selected roots. They are unavailable until you review the new grant and explicitly
                              apply enabled roots.
                           </p>
                           <ul>
                              {changedGrants.map((item) => (
                                 <li key={item.path}>
                                    <code>{item.path}</code>
                                 </li>
                              ))}
                           </ul>
                           <label className={classes.confirmation}>
                              <input
                                 type="checkbox"
                                 checked={grantReviewConfirmed}
                                 onChange={(event) => setConfirmedGrantReview(event.target.checked ? grantReviewKey : '')}
                              />
                              I reviewed the changed host approval and want to enable these selected roots again.
                           </label>
                        </div>
                     )}
                     {selectedOutsideHostPolicy && (
                        <p className={classes.warning}>
                           Remove selected roots outside the current host approval before applying enabled access. Request access separately if
                           needed.
                        </p>
                     )}
                     <div className={classes.actions}>
                        <Button
                           text="Apply enabled roots"
                           variant="primary"
                           size="sm"
                           disabled={
                              !ready ||
                              busy ||
                              (!selectionChanged && !requiresGrantReview) ||
                              (requiresGrantReview && !grantReviewConfirmed) ||
                              selectedOutsideHostPolicy ||
                              selectionOverlaps ||
                              activeAffected ||
                              (removed.length > 0 && !confirmed)
                           }
                           onClick={() => void send('requests', selected, removed.length > 0)}
                        />
                     </div>
                  </>
               )}
               <label className={classes.label} htmlFor={`source-paths-${deviceId}`}>
                  Application source paths — one absolute Linux path per line
               </label>
               <textarea
                  id={`source-paths-${deviceId}`}
                  className={classes.paths}
                  value={draft}
                  onChange={(event) => {
                     setDraft(event.target.value);
                     setValidationId('');
                     setNotice('');
                     setError('');
                  }}
                  placeholder={'/srv/example-app\n/srv/example-worker'}
                  spellCheck={false}
               />
               {draft && parsed.error && (
                  <p className={classes.error} role="alert">
                     {parsed.error}
                  </p>
               )}
               <p className={classes.muted}>
                  Validate paths leaves enabled access unchanged.{' '}
                  {serverManaged
                     ? 'Review the canonical results, then Apply validated paths. Paths outside delegated scope cannot be applied.'
                     : 'Request access keeps the currently selected roots and submits these paths for host approval when needed.'}
               </p>
               {serverManaged && currentValidation && (
                  <div className={classes.notice} role="status">
                     <h4>Canonical path preview</h4>
                     <ul>
                        {currentValidation.map((item) => (
                           <li key={item.requestedPath}>
                              <code>{item.requestedPath}</code> → <code>{item.canonicalPath || 'Unavailable'}</code> —{' '}
                              {item.status === 'approved' ? 'Within delegated scope and readable' : 'Unavailable for Apply'}
                           </li>
                        ))}
                     </ul>
                  </div>
               )}
               <div className={classes.actions}>
                  <Button
                     text="Validate paths"
                     variant="secondary"
                     size="sm"
                     disabled={!ready || busy || Boolean(parsed.error)}
                     onClick={() => void send('validate', parsed.roots)}
                  />
                  <Button
                     text={serverManaged ? 'Apply validated paths' : 'Request access'}
                     variant="primary"
                     size="sm"
                     disabled={
                        !ready ||
                        busy ||
                        Boolean(parsed.error) ||
                        (serverManaged && !validatedPaths) ||
                        activeAffected ||
                        (removed.length > 0 && !confirmed)
                     }
                     onClick={requestPaths}
                  />
               </div>
               <SourceAccessHistory key={deviceId} deviceId={deviceId} requests={view.requests} renderDetails={requestHistory} />
            </>
         )}
         {notice && (
            <p role="status" className={classes.notice}>
               {notice}
            </p>
         )}
         {error && (
            <p role="alert" className={classes.error}>
               {error}
            </p>
         )}
      </section>
   );
};

export default SourceAccess;

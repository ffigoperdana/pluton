import { useState } from 'react';
import type { SourceAccessView, SourceAuthorizationMode } from '../../../@types/agentSourceAccess';
import { useSourceModeSetup } from '../../../services/agentSourceAccess';
import {
   hostModeSetupCommand,
   parseSourceRoots,
   sourceAccessReady,
   sourceAccessStatus,
   sourceAuthorizationMode,
   sourceRequestPending,
} from '../../../utils/agentSourceAccess';
import { copyToClipboard } from '../../../utils/clipboard';
import Button from '../../common/Button/Button';
import classes from './SourceAccess.module.scss';

/** A requested UI preference never substitutes for a locally authorized host policy. */
const SourceAuthorizationSetup = ({ deviceId, agentId, access }: { deviceId: string; agentId: string; access: SourceAccessView }) => {
   const current = sourceAuthorizationMode(access.report);
   const [desired, setDesired] = useState<SourceAuthorizationMode>(current);
   const [prefixes, setPrefixes] = useState((access.report?.delegatedRoots || []).join('\n'));
   const [reviewedKey, setReviewedKey] = useState('');
   const [requestId, setRequestId] = useState('');
   const [error, setError] = useState('');
   const [copied, setCopied] = useState(false);
   const setup = useSourceModeSetup(deviceId);
   const parsed = parseSourceRoots(prefixes);
   const report = access.report;
   const existing = access.requests.find(
      (item) => item.kind === 'mode-setup' && (item.status === 'pending-host-setup' || sourceRequestPending(item)),
   );
   const request = access.requests.find((item) => item.requestId === requestId) || existing;
   const scopesChanged =
      desired === 'server-managed' && JSON.stringify([...parsed.roots].sort()) !== JSON.stringify([...(report?.delegatedRoots || [])].sort());
   const changed = desired !== current || scopesChanged;
   const plans = access.modeChangePlans || [];
   const reviewKey = JSON.stringify([
      deviceId,
      report?.hostPolicyRevision,
      report?.effectiveVersion,
      desired,
      parsed.roots,
      plans.map((plan) => [plan.id, plan.sourcePath, plan.isActive]).sort(),
      access.activeOperationCount,
   ]);
   const reviewed = reviewedKey === reviewKey;
   const knownDrain = access.modeChangeBlocked === false && typeof access.activeOperationCount === 'number' && access.activeOperationCount === 0;
   const ready =
      sourceAccessReady(access) &&
      access.modeSetupSupported === true &&
      knownDrain &&
      !plans.some((plan) => plan.isActive) &&
      !access.requests.some(sourceRequestPending);
   const currentReceipt =
      sourceAccessReady(access) &&
      access.activeOperationCount === 0 &&
      !plans.some((plan) => plan.isActive) &&
      request?.kind === 'mode-setup' &&
      request.status === 'pending-host-setup' &&
      Boolean(request.setupExpiresAt && Date.parse(request.setupExpiresAt) > Date.now()) &&
      request.expectedHostPolicyRevision === report?.hostPolicyRevision &&
      request.expectedVersion === report?.effectiveVersion;

   return (
      <details className={classes.modeSetup} open={changed || Boolean(request)}>
         <summary>Authorization Mode</summary>
         <fieldset className={classes.modes}>
            <legend>Requested authorization mode</legend>
            <label>
               <input
                  type="radio"
                  name={`authorization-mode-${deviceId}`}
                  checked={desired === 'server-managed'}
                  onChange={() => {
                     setDesired('server-managed');
                     setReviewedKey('');
                     setError('');
                  }}
               />{' '}
               <strong>Server-Managed</strong>
               <span>Manage backup source directories directly from Pluton after the host administrator delegates the allowed scope.</span>
            </label>
            <label>
               <input
                  type="radio"
                  name={`authorization-mode-${deviceId}`}
                  checked={desired === 'host-approved'}
                  onChange={() => {
                     setDesired('host-approved');
                     setReviewedKey('');
                     setError('');
                  }}
               />{' '}
               <strong>Host-Approved</strong>
               <span>Require local host administrator approval whenever a source extends beyond the currently approved directories.</span>
            </label>
         </fieldset>
         {desired === 'server-managed' && (
            <div className={classes.warning}>
               <label className={classes.label} htmlFor={`delegation-scope-${deviceId}`}>
                  Canonical delegated directory prefixes — one per line
               </label>
               <textarea
                  id={`delegation-scope-${deviceId}`}
                  className={classes.paths}
                  value={prefixes}
                  placeholder={'/srv/example-apps\n/srv/example-workers'}
                  spellCheck={false}
                  onChange={(event) => {
                     setPrefixes(event.target.value);
                     setReviewedKey('');
                  }}
               />
               {prefixes && parsed.error && (
                  <p className={classes.error} role="alert">
                     {parsed.error}
                  </p>
               )}
               <p>
                  Every Pluton administrator can enable readable application directories inside this scope. Choose narrow canonical prefixes; the
                  server cannot expand them. Protected system paths, private agent state and known private credential directories are blocked.
                  Sensitive application files inside this scope can still be backed up. A host operator must deliberately authorize this trust boundary.
               </p>
            </div>
         )}
         {changed && (
            <div className={classes.warning} role="status">
               <p>
                  Pending host setup. The current {current === 'server-managed' ? 'Server-Managed' : 'Host-Approved'} mode remains in effect. This
                  selection does not grant access.
               </p>
               <p>
                  Pause every listed plan and finish queued or running operations before changing modes. A host mode change can remove existing
                  access; switching back does not retain roots that require delegation.
               </p>
               <ul>
                  {plans.map((plan) => (
                     <li key={plan.id}>
                        {plan.title} — {plan.isActive ? 'Active — pause required' : 'Paused'} — <code>{plan.sourcePath}</code>
                     </li>
                  ))}
               </ul>
               {access.activeOperationCount !== undefined && <p>Queued or running operations: {access.activeOperationCount}</p>}
               {!knownDrain && <p>Waiting for server confirmation that all affected operations are drained.</p>}
               {!access.modeSetupSupported && (
                  <p>Upgrade the agent before requesting this one-time host setup. Existing access remains Host-Approved.</p>
               )}
               <label className={classes.confirmation}>
                  <input type="checkbox" checked={reviewed} onChange={(event) => setReviewedKey(event.target.checked ? reviewKey : '')} />I reviewed
                  the scope and every affected plan, and will keep operations paused until the host setup and report are confirmed.
               </label>
               <div className={classes.actions}>
                  <Button
                     text={setup.isPending ? 'Requesting host setup…' : 'Request one-time host setup'}
                     variant="primary"
                     size="sm"
                     disabled={!ready || !reviewed || setup.isPending || Boolean(existing) || (desired === 'server-managed' && Boolean(parsed.error))}
                     onClick={() => {
                        if (!report) return;
                        setError('');
                        void setup
                           .mutateAsync({
                              expectedVersion: report.effectiveVersion,
                              expectedHostPolicyRevision: report.hostPolicyRevision,
                              authorizationMode: desired,
                              roots: desired === 'server-managed' ? parsed.roots : [],
                              confirmedAffectedPlanIds: plans.map((plan) => plan.id).sort(),
                           })
                           .then(
                              (accepted) => {
                                 setRequestId(accepted.requestId);
                                 setCopied(false);
                              },
                              (failure) => setError(failure instanceof Error ? failure.message : 'Could not request host setup.'),
                           );
                     }}
                  />
               </div>
            </div>
         )}
         {request && (
            <div className={classes.notice} role="status">
               <p>
                  Mode setup: {sourceAccessStatus(request.status)}. The mode changes only after the host operator applies the exact setup receipt and
                  the agent reports it.
               </p>
               {currentReceipt && (
                  <>
                     <p>Run this one-time command on the enrolled agent host after reviewing the immutable scope and drain:</p>
                     <pre className={classes.command}>{hostModeSetupCommand(agentId, request)}</pre>
                     <Button
                        text={copied ? 'Copied mode setup command' : 'Copy one-time host setup command'}
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                           setError('');
                           if (!request.setupExpiresAt || Date.parse(request.setupExpiresAt) <= Date.now()) {
                              setError('The host setup receipt expired. Refresh and request a new setup after reviewing the scope and drain.');
                              return;
                           }
                           void copyToClipboard(hostModeSetupCommand(agentId, request)).then(
                              () => setCopied(true),
                              () => setError('Could not copy the setup command. Select and copy it manually.'),
                           );
                        }}
                     />
                     <p>
                        This receipt expires after 15 minutes{request.setupExpiresAt && <> ({new Date(request.setupExpiresAt).toLocaleString()})</>}.
                        Keep plans paused, refresh the agent report after the host command, and review enabled directories before resuming.
                     </p>
                  </>
               )}
               {request.resultCode && (
                  <details>
                     <summary>Setup details</summary>
                     <code>{request.resultCode}</code>
                  </details>
               )}
            </div>
         )}
         {error && (
            <p className={classes.error} role="alert">
               {error}
            </p>
         )}
      </details>
   );
};

export default SourceAuthorizationSetup;

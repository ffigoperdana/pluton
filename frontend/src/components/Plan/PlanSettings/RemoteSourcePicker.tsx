import { useState } from 'react';
import type { SourceAccessView } from '../../../@types/agentSourceAccess';
import { useSourceAccessMutation } from '../../../services/agentSourceAccess';
import {
   effectiveSourceRoots,
   currentSourceValidation,
   selectedSourceRoots,
   sourceAccessReady,
   sourceAccessStatus,
   sourceAccessProblem,
   sourceAuthorizationMode,
   sourceAuthorizationLabel,
   sourceInsideRoot,
   sourcePathError,
   sourceRequestPending,
   sourceWithinDelegation,
   sourceModeSetupPending,
} from '../../../utils/agentSourceAccess';
import Button from '../../common/Button/Button';
import classes from '../../Device/SourceAccess/SourceAccess.module.scss';

type RemoteSourcePickerProps = {
   deviceId: string;
   sourcePath: string;
   isEditing: boolean;
   access?: SourceAccessView;
   accessError?: boolean;
   onUpdate: (path: string) => void;
   onDraftBlocked: (blocked: boolean) => void;
};

const RemoteSourcePicker = ({
   deviceId,
   sourcePath,
   isEditing,
   access: suppliedAccess,
   accessError,
   onUpdate,
   onDraftBlocked,
}: RemoteSourcePickerProps) => {
   const access = accessError ? undefined : suppliedAccess;
   const [draft, setDraft] = useState(sourcePath);
   const [validationId, setValidationId] = useState('');
   const [requestId, setRequestId] = useState('');
   const [error, setError] = useState('');
   const validate = useSourceAccessMutation(deviceId, 'validate');
   const request = useSourceAccessMutation(deviceId, 'requests');
   const report = access?.report;
   const serverManaged = sourceAuthorizationMode(report) === 'server-managed';
   const roots = effectiveSourceRoots(access);
   const ready = sourceAccessReady(access) && !sourceModeSetupPending(access);
   const validation = access?.requests.find((item) => item.requestId === validationId);
   const result = validation?.validation?.find((item) => item.requestedPath === draft || item.requestedPath === draft.replace(/\/+$/, ''));
   const pendingRequest = access?.requests.find((item) => item.requestId === requestId);
   const awaitingAgent = Boolean(
      (validationId && (!validation || sourceRequestPending(validation))) || (requestId && (!pendingRequest || sourceRequestPending(pendingRequest))),
   );
   const canonical = result?.canonicalPath;
   const validationCurrent = Boolean(currentSourceValidation(access, validationId, [draft.replace(/\/+$/, '') || '/']));
   const appliedCurrent = Boolean(
      canonical &&
         pendingRequest?.kind === 'apply' &&
         pendingRequest.status === 'applied' &&
         report &&
         report.lastAppliedRequestId === pendingRequest.requestId &&
         report.effectiveVersion === pendingRequest.expectedVersion + 1 &&
         report.hostPolicyRevision === pendingRequest.expectedHostPolicyRevision &&
         pendingRequest.roots.includes(canonical),
   );
   const canUseCanonical =
      (validationCurrent || appliedCurrent) && result?.status === 'approved' && canonical && roots.some((root) => sourceInsideRoot(canonical, root));
   const canEnableDelegated =
      validationCurrent &&
      result?.status === 'approved' &&
      Boolean(canonical) &&
      sourceWithinDelegation(canonical!, report) &&
      !sourcePathError(canonical!) &&
      (!isEditing || canonical === sourcePath);
   const pathError = sourcePathError(draft, true);

   const submit = async (kind: 'validate' | 'requests') => {
      if (!ready || !report || pathError || !draft || (serverManaged && kind === 'requests' && !canEnableDelegated)) return;
      setError('');
      const normalized = draft.replace(/\/+$/, '') || '/';
      const candidate = validationCurrent && canonical ? canonical : normalized;
      const desired = selectedSourceRoots(access);
      if (kind === 'requests' && !desired.some((root) => sourceInsideRoot(candidate, root))) desired.push(candidate);
      try {
         const accepted = await (kind === 'validate' ? validate : request).mutateAsync({
            expectedVersion: report.effectiveVersion,
            expectedHostPolicyRevision: report.hostPolicyRevision,
            roots: kind === 'validate' ? [normalized] : desired,
         });
         if (kind === 'validate') setValidationId(accepted.requestId);
         else setRequestId(accepted.requestId);
      } catch (failure) {
         setError(failure instanceof Error ? failure.message : 'Source validation could not be submitted.');
      }
   };

   return (
      <div className={classes.editor}>
         {accessError && (
            <p className={classes.error} role="alert">
               Source access requires an authenticated administrator session. Refresh before selecting a new source.
            </p>
         )}
         {!access && !accessError && <p role="status">Loading approved source roots…</p>}
         {access && !access.supported && (
            <p className={classes.notice}>
               This agent uses host-configured static roots. Enter an absolute source path; the agent's local preflight remains the final authority.
               Upgrade the agent to use Source Access controls in Pluton.
            </p>
         )}
         {access?.supported && (
            <>
               <p>
                  Authorization mode: <strong>{sourceAuthorizationLabel(report)}</strong>
               </p>
               {serverManaged && (
                  <div className={classes.notice}>
                     <p>
                        Enable readable sources inside the host-delegated scope through Pluton after validation. No further SSH approval is needed
                        within this scope.
                     </p>
                     <ul>
                        {(report?.delegatedRoots || []).map((root) => (
                           <li key={root}>
                              <code>{root}</code>
                           </li>
                        ))}
                     </ul>
                  </div>
               )}
               {sourceModeSetupPending(access) && (
                  <p role="status" className={classes.warning}>
                     One-time host mode setup is pending. Keep plans paused until the agent confirms the change.
                  </p>
               )}
               {!access.online && (
                  <p className={classes.warning} role="status">
                     Agent offline. A new source requires online validation.
                  </p>
               )}
               {!access.reportFresh && (
                  <p className={classes.warning} role="status">
                     Awaiting a fresh agent policy report.
                  </p>
               )}
               {report?.policyError && (
                  <p className={classes.error} role="alert">
                     Host policy review required: {report.policyError}
                  </p>
               )}
               <label className={classes.label} htmlFor={`approved-source-${deviceId}`}>
                  Effective approved source root
               </label>
               <select
                  id={`approved-source-${deviceId}`}
                  className={classes.select}
                  value={roots.includes(sourcePath) ? sourcePath : ''}
                  disabled={isEditing || !ready}
                  onChange={(event) => {
                     if (!event.target.value) return;
                     setDraft(event.target.value);
                     setValidationId('');
                     setRequestId('');
                     onUpdate(event.target.value);
                     onDraftBlocked(false);
                  }}
               >
                  <option value="">{roots.length ? 'Select an effective root or validate an explicit path' : 'No readable effective roots'}</option>
                  {roots.map((root) => (
                     <option key={root} value={root}>
                        {root}
                     </option>
                  ))}
               </select>
            </>
         )}
         <label className={classes.label} htmlFor={`remote-source-${deviceId}`}>
            Remote Backup Source*
         </label>
         <input
            id={`remote-source-${deviceId}`}
            className={classes.pathInput}
            type="text"
            value={draft}
            placeholder="/srv/example-app"
            disabled={isEditing || !access}
            onChange={(event) => {
               setDraft(event.target.value);
               setValidationId('');
               setRequestId('');
               setError('');
               if (access?.supported === false) {
                  onUpdate(event.target.value.trim());
                  onDraftBlocked(false);
               } else onDraftBlocked(true);
            }}
         />
         {draft && pathError && (
            <p className={classes.error} role="alert">
               {pathError}
            </p>
         )}
         {isEditing && (
            <p className={classes.muted}>
               The existing source path is fixed for this plan. Validation checks it without changing other plan settings.
            </p>
         )}
         {access?.supported && (
            <p className={classes.muted}>
               Choose an effective root, or validate one explicit Linux path and use its canonical result.{' '}
               {serverManaged
                  ? 'Apply a validated source inside delegated scope, wait for confirmation, then use it for this plan.'
                  : 'Pending host approval does not permit backup.'}{' '}
               No remote file browser is exposed.
            </p>
         )}
         <div className={classes.actions}>
            <Button
               text={validate.isPending ? 'Submitting validation…' : 'Validate source path'}
               variant="secondary"
               size="sm"
               disabled={!ready || !draft || Boolean(pathError) || validate.isPending || awaitingAgent}
               onClick={() => void submit('validate')}
            />
            {(!isEditing || serverManaged) && (
               <Button
                  text={serverManaged ? 'Apply source access' : 'Request access for this path'}
                  variant="secondary"
                  size="sm"
                  disabled={
                     !ready ||
                     !draft ||
                     Boolean(pathError) ||
                     request.isPending ||
                     awaitingAgent ||
                     (serverManaged && !canEnableDelegated) ||
                     Boolean(result?.status === 'rejected')
                  }
                  onClick={() => void submit('requests')}
               />
            )}
            {!isEditing && canUseCanonical && (
               <Button
                  text="Use validated canonical path"
                  variant="primary"
                  size="sm"
                  onClick={() => {
                     setDraft(canonical);
                     onUpdate(canonical);
                     onDraftBlocked(false);
                  }}
               />
            )}
         </div>
         {validation && (
            <div role="status" className={classes.notice}>
               <p>
                  {validation.status === 'validated' ? 'Validation complete — source access was not changed' : sourceAccessStatus(validation.status)}
               </p>
               {result && (
                  <div>
                     <code>{result.requestedPath}</code>
                     {canonical && (
                        <>
                           {' '}
                           → <code>{canonical}</code>
                        </>
                     )}{' '}
                     — {sourceAccessStatus(result.status)} {sourceAccessProblem(result.code)}{' '}
                     {result.code && (
                        <details>
                           <summary>Validation details</summary>
                           <code>{result.code}</code>
                        </details>
                     )}
                  </div>
               )}
               {result?.status === 'approved' && !canUseCanonical && (
                  <p>
                     {serverManaged
                        ? 'This canonical path is validated. Apply source access and wait for the agent to confirm it before using it.'
                        : "This path is host-approved but is not within a readable effective root. Enable access in the machine's Source Access section before using it."}
                  </p>
               )}
               {validation.resultCode && <p className={classes.error}>{validation.resultCode}</p>}
               {!validationCurrent && !appliedCurrent && <p>The host policy changed. Validate this source again before using its result.</p>}
            </div>
         )}
         {requestId && (
            <p role="status" className={classes.notice}>
               {pendingRequest ? sourceAccessStatus(pendingRequest.status) : 'Request accepted — awaiting agent'}; this request does not select a
               backup source.{' '}
               {serverManaged
                  ? 'Wait for confirmed effective access, then choose Use validated canonical path. Review current access in '
                  : 'Review host approval in '}
               <a href={`/device/${deviceId}`} target="_blank" rel="noreferrer">
                  Source Access
               </a>
               {serverManaged ? '.' : ', then validate and use the effective canonical path.'}
            </p>
         )}
         {error && (
            <p role="alert" className={classes.error}>
               {error}
            </p>
         )}
      </div>
   );
};

export default RemoteSourcePicker;

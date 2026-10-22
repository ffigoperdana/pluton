import { useEffect, useRef, useState } from 'react';
import Modal from '../../common/Modal/Modal';
import Input from '../../common/form/Input/Input';
import Button from '../../common/Button/Button';
import { useCreateAgentEnrollment, useRevokeAgentEnrollment, type AgentEnrollment } from '../../../services/devices';
import classes from './AgentEnrollment.module.scss';
import { parseSourceRoots } from '../../../utils/agentSourceAccess';
import { buildStandaloneAgentCommand } from '../../../utils/agentEnrollment';
import { copyToClipboard } from '../../../utils/clipboard';
import type { SourceAuthorizationMode } from '../../../@types/agentSourceAccess';

type AgentEnrollmentProps = {
   close: () => void;
};

const AgentEnrollmentModal = ({ close }: AgentEnrollmentProps) => {
   const [name, setName] = useState('');
   const [allowedRoots, setAllowedRoots] = useState('');
   const [authorizationMode, setAuthorizationMode] = useState<SourceAuthorizationMode>('host-approved');
   const [delegationScope, setDelegationScope] = useState('');
   const [delegationReviewed, setDelegationReviewed] = useState(false);
   const [enrollment, setEnrollment] = useState<AgentEnrollment | null>(null);
   const [revokeError, setRevokeError] = useState('');
   const [copyError, setCopyError] = useState('');
   const [copied, setCopied] = useState(false);
   const [tokenVisible, setTokenVisible] = useState(false);
   const [expired, setExpired] = useState(false);
   useEffect(() => {
      if (!enrollment) return;
      const remaining = Date.parse(enrollment.expiresAt) - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
         setExpired(true);
         return;
      }
      const timer = setTimeout(
         () => {
            setExpired(true);
            setTokenVisible(false);
         },
         Math.min(remaining, 2147483647),
      );
      return () => clearTimeout(timer);
   }, [enrollment]);
   const createEnrollment = useCreateAgentEnrollment();
   const enrollmentErrorRef = useRef<HTMLDivElement>(null);
   useEffect(() => {
      if (createEnrollment.isError) enrollmentErrorRef.current?.focus();
   }, [createEnrollment.isError]);
   const revokeEnrollment = useRevokeAgentEnrollment();
   const serverUrl = enrollment?.serverUrl || (typeof window === 'undefined' ? '' : window.location.origin);
   const parsedRoots = parseSourceRoots(allowedRoots);
   const hasValidSourceRoots = !parsedRoots.error;
   const delegated = parseSourceRoots(delegationScope);
   let installCommand = '';
   let commandError = '';
   if (enrollment && hasValidSourceRoots && !expired) {
      try {
         installCommand = buildStandaloneAgentCommand(enrollment.distribution, serverUrl, parsedRoots.roots);
      } catch {
         commandError = 'Installation instructions unavailable. Review the standalone distribution configuration and HTTPS Agent URL.';
      }
   }

   const create = async () => {
      try {
         const result = await createEnrollment.mutateAsync(name);
         setEnrollment(result);
      } catch {
         // The UI renders a safe, generic error below.
      }
   };

   const copyCommand = async (command: string) => {
      setCopyError('');
      try {
         await copyToClipboard(command);
         setCopied(true);
      } catch {
         setCopied(false);
         setCopyError('Could not copy the command. Select and copy it manually.');
      }
   };

   const revoke = async () => {
      if (!enrollment) return;
      try {
         await revokeEnrollment.mutateAsync(enrollment.id);
         close();
      } catch {
         setRevokeError('Could not revoke enrollment token. It may still be active.');
      }
   };

   return (
      <Modal title="Add Remote Machine" width="min(960px, calc(100vw - 32px))" closeModal={close} disableBackdropClick={Boolean(enrollment)}>
         {!enrollment ? (
            <div className={classes.content}>
               <p>
                  Create a single-use enrollment token for a self-hosted Pluton Agent. A capable agent can run the limited remote filesystem backup
                  workflow.
               </p>
               {createEnrollment.isError && (
                  <div ref={enrollmentErrorRef} className={classes.enrollmentError} role="alert" tabIndex={-1}>
                     Could not create enrollment token. Ask the administrator to verify the standalone Agent distribution configuration.
                  </div>
               )}
               <Input
                  label="Machine name"
                  required={true}
                  full={true}
                  fieldValue={name}
                  placeholder="app-01"
                  onUpdate={setName}
               />
               <fieldset className={classes.modes}>
                  <legend>Authorization Mode</legend>
                  <label>
                     <input
                        type="radio"
                        name="enrollment-authorization-mode"
                        checked={authorizationMode === 'server-managed'}
                        onChange={() => {
                           setAuthorizationMode('server-managed');
                           setDelegationReviewed(false);
                        }}
                     />
                     <strong>Server-Managed</strong>
                     <span>Manage backup source directories directly from Pluton after the host administrator delegates the allowed scope.</span>
                  </label>
                  <label>
                     <input
                        type="radio"
                        name="enrollment-authorization-mode"
                        checked={authorizationMode === 'host-approved'}
                        onChange={() => {
                           setAuthorizationMode('host-approved');
                           setDelegationReviewed(false);
                        }}
                     />
                     <strong>Host-Approved</strong>
                     <span>Require local host administrator approval whenever a source extends beyond the currently approved directories.</span>
                  </label>
               </fieldset>
               {authorizationMode === 'server-managed' && (
                  <div className={classes.setup}>
                     <label className={classes.label} htmlFor="enrollment-delegation-scope">
                        Planned canonical delegated prefixes — one per line
                     </label>
                     <textarea
                        id="enrollment-delegation-scope"
                        className={classes.roots}
                        value={delegationScope}
                        placeholder={'/srv/example-apps\n/srv/example-workers'}
                        spellCheck={false}
                        onChange={(event) => {
                           setDelegationScope(event.target.value);
                           setDelegationReviewed(false);
                        }}
                     />
                     {delegationScope && delegated.error && (
                        <p className={classes.error} role="alert">
                           {delegated.error}
                        </p>
                     )}
                     <p>
                        Every Pluton administrator can enable readable directories within the host's delegated scope. Start with narrow prefixes.
                        Installation starts in Host-Approved mode; after the agent is online, request and copy the one-time host setup from Source
                        Access. This choice alone grants no access.
                     </p>
                     <label>
                        <input type="checkbox" checked={delegationReviewed} onChange={(event) => setDelegationReviewed(event.target.checked)} />I
                        reviewed this trust boundary and will have the host administrator authorize the scope once after enrollment.
                     </label>
                  </div>
               )}
               <div className={classes.actions}>
                  <Button text="Cancel" variant="tertiary" onClick={close} />
                  <Button
                     text={createEnrollment.isPending ? 'Creating…' : 'Create enrollment token'}
                     variant="primary"
                     disabled={
                        !name.trim() ||
                        createEnrollment.isPending ||
                        (authorizationMode === 'server-managed' && (!delegationReviewed || Boolean(delegated.error)))
                     }
                     onClick={create}
                  />
               </div>
            </div>
         ) : (
            <div className={classes.content}>
               <p className={classes.warning}>
                  Keep this single-use token private. Paste it only into the installer's hidden terminal prompt. Closing this dialog removes it from
                  view.
               </p>
               <p>
                  Token expires: <time dateTime={enrollment.expiresAt}>{new Date(enrollment.expiresAt).toLocaleString()}</time>. Expired, used or
                  revoked tokens cannot enroll another Agent.
               </p>
               <p>
                  Requested authorization mode:{' '}
                  <strong>{authorizationMode === 'server-managed' ? 'Server-Managed — pending one-time host setup' : 'Host-Approved'}</strong>
               </p>
               <label className={classes.label}>One-time enrollment token</label>
               {expired && (
                  <p className={classes.error} role="status">
                     Token expired. Close this dialog and create a new one when ready.
                  </p>
               )}
               <code className={classes.token}>{tokenVisible && !expired ? enrollment.token : '••••••••••••••••'}</code>
               <Button
                  text={tokenVisible ? 'Hide token' : 'Show token'}
                  variant="tertiary"
                  size="sm"
                  disabled={expired}
                  onClick={() => setTokenVisible(!tokenVisible)}
               />
               <label className={classes.label} htmlFor="enrollment-source-roots">
                  Planned initial source roots — one application directory per line
               </label>
               <textarea
                  id="enrollment-source-roots"
                  className={classes.roots}
                  required
                  value={allowedRoots}
                  placeholder={'/srv/example-app\n/srv/example-worker'}
                  spellCheck={false}
                  onChange={(event) => {
                     setAllowedRoots(event.target.value);
                     setCopied(false);
                     setCopyError('');
                  }}
               />
               {allowedRoots && parsedRoots.error && (
                  <p className={classes.error} role="alert">
                     {parsedRoots.error}
                  </p>
               )}
               <p className={classes.help}>
                  Each path produces a separate --allowed-root option and is validated on the host. A single agent can serve multiple application
                  plans. Choose specific directories and provision read/traverse permissions for pluton-agent; the installer does not broaden
                  permissions.
               </p>
               {installCommand ? (
                  <section className={classes.installOption} aria-labelledby="standalone-install-title">
                     <h4 className={classes.installTitle} id="standalone-install-title">
                        Clone, pin, install and enroll the standalone Agent
                     </h4>
                     <p className={classes.help}>
                        On a fresh Ubuntu 22.04 host with Bash, Git, Python 3 and sudo, run this complete block as your normal administrator. It
                        checks the reviewed commit and Agent version before asking for sudo. The installer prompts privately for the token. For a
                        private repository, configure Git access separately; never put a Git password or token in these commands.
                     </p>
                     <pre className={classes.command}>{installCommand}</pre>
                     <Button
                        text={copied ? 'Copied' : 'Copy installation commands'}
                        variant="secondary"
                        size="sm"
                        icon={copied ? 'check' : 'copy'}
                        onClick={() => copyCommand(installCommand)}
                     />
                  </section>
               ) : hasValidSourceRoots ? null : (
                  <p className={classes.help}>Enter absolute application source roots to generate complete copy-paste installation commands.</p>
               )}
               {commandError && (
                  <p className={classes.error} role="alert">
                     {commandError}
                  </p>
               )}
               {copyError && <p className={classes.error}>{copyError}</p>}
               <label className={classes.label}>Agent service commands</label>
               <p className={classes.help}>
                  After enrollment, open the machine's Source Access section to validate paths and manage enabled roots. Additional directories
                  require host approval followed by an explicit enable action in Pluton. A pending request cannot be used for backup.
               </p>
               {authorizationMode === 'server-managed' && (
                  <div className={classes.setup} role="status">
                     <h4>Finish Server-Managed setup after the agent is online</h4>
                     <p>
                        Open Sources → this remote machine → Source Access → Authorization Mode. Select Server-Managed, review these planned canonical
                        prefixes, pause any plans, and request the one-time host setup. Copy the exact receipt-bound command and have the host
                        administrator run it. Refresh the agent report to confirm Server-Managed mode.
                     </p>
                     <pre className={classes.command}>{delegated.roots.join('\n')}</pre>
                     <p>
                        The installation uses only the reviewed initial static roots. It does not silently delegate this scope. Once host setup is
                        confirmed, future readable directories inside the scope can be validated and applied entirely in Pluton.
                     </p>
                  </div>
               )}
               <pre className={classes.command}>systemctl is-active pluton-agent.service{'\n'}systemctl status --no-pager pluton-agent.service</pre>
               <p className={classes.help}>
                  Refresh Sources and confirm this Agent is Online with version 0.7.0 and its reported capabilities. Planned roots do not authorize
                  backup by themselves. Existing monorepo Agents keep their existing reviewed upgrade path.
               </p>
               {revokeError && (
                  <p className={classes.error} role="alert">
                     {revokeError}
                  </p>
               )}
               <div className={classes.actions}>
                  <Button text="Revoke token" variant="danger" onClick={revoke} disabled={revokeEnrollment.isPending} />
                  <Button text="Done" variant="primary" onClick={close} />
               </div>
            </div>
         )}
      </Modal>
   );
};

export default AgentEnrollmentModal;

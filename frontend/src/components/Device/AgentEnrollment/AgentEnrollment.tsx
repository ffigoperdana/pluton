import { useState } from 'react';
import Modal from '../../common/Modal/Modal';
import Input from '../../common/form/Input/Input';
import Button from '../../common/Button/Button';
import { useCreateAgentEnrollment, useRevokeAgentEnrollment, type AgentEnrollment } from '../../../services/devices';
import classes from './AgentEnrollment.module.scss';
import { buildAgentInstallCommand, parseSourceRoots } from '../../../utils/agentSourceAccess';
import { copyToClipboard } from '../../../utils/clipboard';
import type { SourceAuthorizationMode } from '../../../@types/agentSourceAccess';

type AgentEnrollmentProps = {
   close: () => void;
};

type InstallVariant = 'quick' | 'secure';

const communityForkUrl = 'https://github.com/ffigoperdana/pluton.git';

const AgentEnrollmentModal = ({ close }: AgentEnrollmentProps) => {
   const [name, setName] = useState('');
   const [allowedRoots, setAllowedRoots] = useState('');
   const [authorizationMode, setAuthorizationMode] = useState<SourceAuthorizationMode>('host-approved');
   const [delegationScope, setDelegationScope] = useState('');
   const [delegationReviewed, setDelegationReviewed] = useState(false);
   const [enrollment, setEnrollment] = useState<AgentEnrollment | null>(null);
   const [revokeError, setRevokeError] = useState('');
   const [copyError, setCopyError] = useState('');
   const [copiedVariant, setCopiedVariant] = useState<InstallVariant | null>(null);
   const createEnrollment = useCreateAgentEnrollment();
   const revokeEnrollment = useRevokeAgentEnrollment();
   const serverUrl = enrollment?.serverUrl || (typeof window === 'undefined' ? '' : window.location.origin);
   const requiresInsecureHttp = serverUrl.startsWith('http:') && enrollment?.insecureHttpAllowed === true;
   const insecureHttpBlocked = serverUrl.startsWith('http:') && enrollment?.insecureHttpAllowed !== true;
   const parsedRoots = parseSourceRoots(allowedRoots);
   const hasValidSourceRoots = !parsedRoots.error;
   const canGenerateCommands = enrollment && hasValidSourceRoots && !insecureHttpBlocked;
   const delegated = parseSourceRoots(delegationScope);
   const quickInstallCommand = canGenerateCommands
      ? buildAgentInstallCommand(serverUrl, parsedRoots.roots, requiresInsecureHttp, enrollment.token)
      : '';
   const secureInstallCommand = canGenerateCommands ? buildAgentInstallCommand(serverUrl, parsedRoots.roots, requiresInsecureHttp) : '';

   const create = async () => {
      try {
         const result = await createEnrollment.mutateAsync(name);
         setEnrollment(result);
      } catch {
         // The UI renders a safe, generic error below.
      }
   };

   const copyCommand = async (variant: InstallVariant, command: string) => {
      setCopyError('');
      try {
         await copyToClipboard(command);
         setCopiedVariant(variant);
      } catch {
         setCopiedVariant(null);
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
               <Input
                  label="Machine name"
                  required={true}
                  full={true}
                  fieldValue={name}
                  placeholder="app-01"
                  onUpdate={setName}
                  error={createEnrollment.isError ? 'Could not create enrollment token.' : ''}
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
               <p className={classes.warning}>Copy this token now. It is not stored in the browser after this dialog closes.</p>
               <p>
                  Requested authorization mode:{' '}
                  <strong>{authorizationMode === 'server-managed' ? 'Server-Managed — pending one-time host setup' : 'Host-Approved'}</strong>
               </p>
               <label className={classes.label}>One-time enrollment token</label>
               <code className={classes.token}>{enrollment.token}</code>
               <label className={classes.label}>Step 1 — Clone your Pluton community fork</label>
               <pre className={classes.command}>{`git clone ${communityForkUrl} pluton\ncd pluton`}</pre>
               <label className={classes.label} htmlFor="enrollment-source-roots">
                  Allowed source roots — one application directory per line
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
                     setCopiedVariant(null);
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
               {canGenerateCommands ? (
                  <div className={classes.installOptions}>
                     <section className={classes.installOption} aria-labelledby="quick-install-title">
                        <h4 className={classes.installTitle} id="quick-install-title">
                           Step 2 — Quick install
                        </h4>
                        <p className={classes.quickWarning}>
                           The easiest option for a trusted internal/admin environment. The token is one-time and short-lived, but may be stored in
                           shell history and briefly appear in process listings.
                        </p>
                        <pre className={classes.command}>{quickInstallCommand}</pre>
                        <div className={classes.copyAction}>
                           <Button
                              text={copiedVariant === 'quick' ? 'Copied' : 'Copy quick install command'}
                              variant="secondary"
                              size="sm"
                              icon={copiedVariant === 'quick' ? 'check' : 'copy'}
                              onClick={() => copyCommand('quick', quickInstallCommand)}
                           />
                        </div>
                     </section>
                     <section className={classes.installOption} aria-labelledby="secure-install-title">
                        <h4 className={classes.installTitle} id="secure-install-title">
                           Step 3 — Secure install
                        </h4>
                        <p className={classes.help}>
                           Preferred for public, VPS, or less-trusted environments. The installer requests the token interactively and keeps it out of
                           shell history and process arguments.
                        </p>
                        <pre className={classes.command}>{secureInstallCommand}</pre>
                        <div className={classes.copyAction}>
                           <Button
                              text={copiedVariant === 'secure' ? 'Copied' : 'Copy secure install command'}
                              variant="secondary"
                              size="sm"
                              icon={copiedVariant === 'secure' ? 'check' : 'copy'}
                              onClick={() => copyCommand('secure', secureInstallCommand)}
                           />
                        </div>
                     </section>
                  </div>
               ) : hasValidSourceRoots ? null : (
                  <p className={classes.help}>Enter absolute application source roots to generate complete copy-paste installation commands.</p>
               )}
               {insecureHttpBlocked && (
                  <p className={classes.error}>
                     This Pluton server is not configured to accept agent HTTP. Use HTTPS or enable the explicit server-side trusted-LAN setting
                     before installing an agent.
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
                        The install command below uses the reviewed initial static roots. It does not silently delegate this scope. Once host setup is
                        confirmed, future readable directories inside the scope can be validated and applied entirely in Pluton.
                     </p>
                  </div>
               )}
               <pre className={classes.command}>
                  systemctl status pluton-agent{`\n`}sudo ./installers/install-agent.sh uninstall{`\n`}sudo ./installers/install-agent.sh uninstall
                  --purge
               </pre>
               {revokeError && <p className={classes.error}>{revokeError}</p>}
               <p className={classes.help}>
                  For HTTP on a trusted LAN, the server and agent must each explicitly allow insecure HTTP. Backup source metadata and temporary
                  storage credentials cross the control channel, so use HTTPS for every untrusted or public network.
               </p>
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

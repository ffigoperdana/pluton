import { useState } from 'react';
import Modal from '../../common/Modal/Modal';
import Input from '../../common/form/Input/Input';
import Button from '../../common/Button/Button';
import { useCreateAgentEnrollment, useRevokeAgentEnrollment, type AgentEnrollment } from '../../../services/devices';
import classes from './AgentEnrollment.module.scss';

type AgentEnrollmentProps = {
   close: () => void;
};

const AgentEnrollmentModal = ({ close }: AgentEnrollmentProps) => {
   const [name, setName] = useState('');
   const [enrollment, setEnrollment] = useState<AgentEnrollment | null>(null);
   const [revokeError, setRevokeError] = useState('');
   const createEnrollment = useCreateAgentEnrollment();
   const revokeEnrollment = useRevokeAgentEnrollment();
   const serverUrl = typeof window === 'undefined' ? '' : window.location.origin;
   const requiresInsecureHttp = serverUrl.startsWith('http:');

   const create = async () => {
      try {
         const result = await createEnrollment.mutateAsync(name);
         setEnrollment(result);
      } catch {
         // The UI renders a safe, generic error below.
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
      <Modal title="Add Remote Machine" width="680px" closeModal={close} disableBackdropClick={Boolean(enrollment)}>
         {!enrollment ? (
            <div className={classes.content}>
               <p>Create a single-use enrollment token for a self-hosted Pluton Agent. Remote filesystem backup is not enabled yet.</p>
               <Input
                  label="Machine name"
                  required={true}
                  full={true}
                  fieldValue={name}
                  placeholder="app-01"
                  onUpdate={setName}
                  error={createEnrollment.isError ? 'Could not create enrollment token.' : ''}
               />
               <div className={classes.actions}>
                  <Button text="Cancel" variant="tertiary" onClick={close} />
                  <Button text={createEnrollment.isPending ? 'Creating…' : 'Create enrollment token'} variant="primary" disabled={!name.trim() || createEnrollment.isPending} onClick={create} />
               </div>
            </div>
         ) : (
            <div className={classes.content}>
               <p className={classes.warning}>Copy this token now. It is not stored in the browser after this dialog closes.</p>
               <label className={classes.label}>One-time enrollment token</label>
               <code className={classes.token}>{enrollment.token}</code>
               <label className={classes.label}>Enroll on the remote machine</label>
               <code className={classes.command}>
                  pluton-agent enroll --server {serverUrl} --token {enrollment.token}
                  {requiresInsecureHttp ? ' --allow-insecure-http' : ''}
               </code>
               {revokeError && <p className={classes.error}>{revokeError}</p>}
               <p className={classes.help}>For HTTP on a trusted LAN, the server and agent must each explicitly allow insecure HTTP. Use HTTPS for every untrusted or public network.</p>
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

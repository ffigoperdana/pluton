import { useEffect, useRef, useState } from 'react';
import Modal from '../../common/Modal/Modal';
import { usePrimaryPromotionAction, usePrimaryPromotions } from '../../../services/primaryPromotions';
import type { PrimaryPromotion, PromotionReplica } from '../../../@types/primaryPromotions';
import {
   currentPromotion,
   promotionFailureText,
   promotionIsActive,
   promotionProgressText,
   promotionStatusLabel,
   promotionSteps,
   storageKindLabel,
} from '../../../utils/primaryPromotion';
import classes from '../PlanRelocation/PlanRelocation.module.scss';

interface PlanPromotionModalProps {
   planId: string;
   primaryName: string;
   close: () => void;
   /** The plan's primary changed (switched); refresh plan data. */
   onBindingChanged?: () => void;
}

const location = (name: string | undefined, id: string, path: string) => (
   <>
      {name || id} · <code>{path}</code>
   </>
);

/** Stage 4 (docs/PRIMARY_PROMOTION.md): promote the plan's verified replica to primary. */
const PlanPromotionModal = ({ planId, primaryName, close, onBindingChanged }: PlanPromotionModalProps) => {
   const overview = usePrimaryPromotions(planId);
   const action = usePrimaryPromotionAction(planId);
   const [confirming, setConfirming] = useState('');
   const latest = currentPromotion(overview.data);
   const active = promotionIsActive(latest);
   const lastStatus = useRef<string | undefined>(undefined);

   useEffect(() => {
      const status = latest?.status;
      if (lastStatus.current && status !== lastStatus.current && status === 'switched') onBindingChanged?.();
      lastStatus.current = status;
   }, [latest?.status, onBindingChanged]);

   const busy = action.isPending;
   const start = (replica: PromotionReplica) =>
      action.mutate({ action: 'start', replicationId: replica.replicationId }, { onSuccess: () => setConfirming('') });

   const panel = (promotion: PrimaryPromotion) => {
      const progress = promotionProgressText(promotion);
      const working = promotionIsActive(promotion);
      return (
         <>
            <dl className={classes.meta}>
               <dt>New primary</dt>
               <dd>{location(promotion.promotedStorageName, promotion.promotedStorageId, promotion.promotedStoragePath)}</dd>
               <dt>New replica</dt>
               <dd>{location(promotion.previousStorageName, promotion.previousStorageId, promotion.previousStoragePath)}</dd>
               <dt>Status</dt>
               <dd>{promotionStatusLabel(promotion.status)}</dd>
            </dl>

            {working && (
               <div className={`${classes.status} ${classes.progress}`} role="status" aria-live="polite">
                  <span className={classes.spinner} aria-hidden="true" />
                  <span>
                     {promotionStatusLabel(promotion.status)}
                     {progress && <span className={classes.detail}>{progress}</span>}
                     <span className={classes.detail}>
                        {promotion.status === 'switching'
                           ? 'Backups wait until the switch finishes; the plan resumes afterwards.'
                           : 'Backups keep running. Copies run one at a time on the Pluton server.'}
                     </span>
                  </span>
               </div>
            )}

            {promotion.status === 'failed' && (
               <div className={`${classes.status} ${classes.error}`} role="alert">
                  <span>
                     {promotionFailureText(promotion.lastErrorCode)}
                     <span className={classes.detail}>
                        Code <code>{promotion.lastErrorCode}</code>. The plan keeps its current primary
                        {promotion.planWasActive ? ' and was resumed' : ''}.
                     </span>
                  </span>
               </div>
            )}

            {promotion.status === 'switched' && (
               <div className={`${classes.status} ${classes.success}`}>
                  <span>
                     New backups go to {promotion.promotedStorageName || 'the new primary'}. The previous primary is now the replica; nothing was
                     deleted. To switch back, promote it again.
                  </span>
               </div>
            )}

            {promotion.leftBehind.length > 0 && (
               <details className={classes.audit} open={promotion.status === 'switched'}>
                  <summary>Backups that stay in the previous primary ({promotion.leftBehind.length})</summary>
                  <ul>
                     {promotion.leftBehind.map((item) => (
                        <li key={item.backupId}>
                           <code>{item.backupId}</code> · {item.code}
                           {promotion.status === 'switched' &&
                              (item.restorable
                                 ? ' · restorable through Verified Replica Recovery'
                                 : ' · the previous primary was unreachable; not restorable from Pluton until it is promoted again')}
                        </li>
                     ))}
                  </ul>
               </details>
            )}

            {promotion.actions.cancel && (
               <div className={classes.actions}>
                  <button
                     type="button"
                     className={classes.secondary}
                     disabled={busy}
                     onClick={() => action.mutate({ action: 'cancel', id: promotion.id })}
                  >
                     Cancel promotion
                  </button>
               </div>
            )}
         </>
      );
   };

   const replicas = overview.data?.replicas || [];

   return (
      <Modal title="Promote replica to primary" closeModal={close} width="600px">
         <div className={classes.relocation}>
            {overview.isLoading && (
               <div className={`${classes.status} ${classes.progress}`} role="status">
                  <span className={classes.spinner} aria-hidden="true" />
                  <span>Loading</span>
               </div>
            )}
            {overview.error && (
               <div className={`${classes.status} ${classes.error}`} role="alert">
                  <span>{(overview.error as Error).message || 'Replica promotion status is unavailable.'}</span>
               </div>
            )}
            {overview.data && !overview.data.supported && <p>{overview.data.reason}</p>}

            {latest && panel(latest)}

            {overview.data?.supported && !active && (
               <>
                  <p>
                     Make the verified replica the primary of this plan. The current primary ({primaryName}) becomes the replica, and snapshot history
                     is kept. The Agent needs no update for an SFTP primary.
                  </p>
                  {replicas.map((replica) => (
                     <div key={replica.replicationId} className={classes.confirm}>
                        <p>
                           <strong>{replica.storageName}</strong> ({storageKindLabel(replica.storageType)}) · <code>{replica.storagePath}</code>
                        </p>
                        {!replica.eligible && replica.reason && <p className={classes.note}>{replica.reason}</p>}
                        {confirming === replica.replicationId ? (
                           <>
                              <ol>
                                 {promotionSteps({
                                    replicaName: replica.storageName,
                                    replicaType: replica.storageType,
                                    primaryName,
                                 }).map((step) => (
                                    <li key={step}>{step}</li>
                                 ))}
                              </ol>
                              <div className={classes.actions}>
                                 <button type="button" className={classes.primary} disabled={busy} onClick={() => start(replica)}>
                                    Promote to primary
                                 </button>
                                 <button type="button" className={classes.secondary} disabled={busy} onClick={() => setConfirming('')}>
                                    Back
                                 </button>
                              </div>
                           </>
                        ) : (
                           <div className={classes.actions}>
                              <button
                                 type="button"
                                 className={classes.primary}
                                 disabled={busy || !replica.eligible}
                                 onClick={() => setConfirming(replica.replicationId)}
                              >
                                 Promote…
                              </button>
                           </div>
                        )}
                     </div>
                  ))}
               </>
            )}

            {action.error && (
               <div className={`${classes.status} ${classes.error}`} role="alert">
                  <span>{action.error.message}</span>
               </div>
            )}
            <div className={classes.actions}>
               <button type="button" className={classes.secondary} onClick={close}>
                  Close
               </button>
            </div>
         </div>
      </Modal>
   );
};

export default PlanPromotionModal;

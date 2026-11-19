import type { AttachmentCatalogSettings, NewPlanSettings, Plan } from '../../../@types/plans';
import { useGetPlans } from '../../../services/plans';
import { catalogDatabaseOptions, catalogPlanOptions } from '../../../utils/attachmentCatalogSettings';
import styles from './PlanRemoteLifecycleSettings.module.scss';

/**
 * Pairs this filestore plan with the plan that dumps its Odoo database, so Browse
 * can show attachments under their original names.
 */
export default function PlanAttachmentCatalogSettings({
   plan,
   value,
   onUpdate,
}: {
   plan: NewPlanSettings;
   value?: AttachmentCatalogSettings | null;
   onUpdate: (value: AttachmentCatalogSettings | null) => void;
}) {
   const plans = useGetPlans();
   const candidates = catalogPlanOptions((plans.data?.result || []) as Plan[], plan.id);
   const selectedPlan = candidates.find((entry) => entry.id === value?.databasePlanId);
   const databases = selectedPlan ? catalogDatabaseOptions(selectedPlan) : [];
   const source = plan.sourceConfig?.includes?.[0] || '';
   const enable = () => {
      const first = candidates[0];
      const database = first ? catalogDatabaseOptions(first)[0] : undefined;
      onUpdate({ version: 1, adapter: 'odoo', databasePlanId: first?.id || '', databaseId: database?.databaseId || '' });
   };
   return (
      <div className={styles.lifecycle}>
         <h3>Odoo attachments</h3>
         <p>
            Odoo stores each attachment in its filestore under a content hash. Pair this plan with the plan that backs up the Odoo database, and
            Browse shows every attachment with its original name, type and record, and which ones this snapshot holds.
         </p>
         <label>
            <input type="checkbox" checked={!!value} onChange={(event) => (event.target.checked ? enable() : onUpdate(null))} /> Show Odoo attachment
            names in Browse
         </label>
         {value && (
            <section className={styles.card}>
               {candidates.length === 0 && (
                  <p role="alert">No Managed Agent plan backs up a PostgreSQL database yet. Create the database plan first.</p>
               )}
               <div className={styles.grid}>
                  <label>
                     Database plan
                     <select
                        value={value.databasePlanId}
                        onChange={(event) => {
                           const next = candidates.find((entry) => entry.id === event.target.value);
                           onUpdate({
                              ...value,
                              databasePlanId: event.target.value,
                              databaseId: next ? catalogDatabaseOptions(next)[0]?.databaseId || '' : '',
                           });
                        }}
                     >
                        {!selectedPlan && <option value="">Select a plan</option>}
                        {candidates.map((entry) => (
                           <option key={entry.id} value={entry.id}>
                              {entry.title}
                           </option>
                        ))}
                     </select>
                  </label>
                  <label>
                     Odoo database
                     <select value={value.databaseId} onChange={(event) => onUpdate({ ...value, databaseId: event.target.value })}>
                        {!databases.some((entry) => entry.databaseId === value.databaseId) && <option value="">Select a database</option>}
                        {databases.map((entry) => (
                           <option key={entry.databaseId} value={entry.databaseId}>
                              {entry.database} ({entry.dumpFilename})
                           </option>
                        ))}
                     </select>
                  </label>
                  <label>
                     Filestore folder in the snapshot
                     <input
                        value={value.filestoreRoot || ''}
                        placeholder={source || '/srv/example-app/filestore/example_db'}
                        autoComplete="off"
                        onChange={(event) => {
                           const filestoreRoot = event.target.value.trim();
                           const { filestoreRoot: _previous, ...rest } = value;
                           onUpdate(filestoreRoot ? { ...rest, filestoreRoot } : rest);
                        }}
                     />
                  </label>
               </div>
               <p>
                  Leave the folder empty when the plan source is the database&apos;s filestore folder itself (the folder that holds the two-character
                  hash folders). Each snapshot is paired with the database backup nearest in time; schedule both plans close together.
               </p>
            </section>
         )}
      </div>
   );
}

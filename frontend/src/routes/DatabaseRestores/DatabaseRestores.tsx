import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useDatabaseRestores, restoreRequest } from '../../services/databaseRestores';
import { restoreStatus } from '../../utils/databaseRestores';
import type { DatabaseRestoreView } from '../../@types/databaseRestores';
import PageHeader from '../../components/common/PageHeader/PageHeader';
import { formatBytes } from '../../utils/helpers';
import classes from '../../components/Restore/DatabaseRestore/DatabaseRestore.module.scss';

export function RestoreDetails({
   row,
   act,
   pending,
}: {
   row: DatabaseRestoreView;
   act: (operation: string, body?: unknown) => void;
   pending: boolean;
}) {
   const [confirmation, setConfirmation] = useState('');
   const inspectable = row.status === 'active' && !row.expired && !row.cancelRequested;
   return (
      <div className={classes.card}>
         <h3>{restoreStatus(row)}</h3>
         <p>
            Stage: {row.stage} · Cleanup: {row.cleanup}
            {row.errorCode && ` · Error: ${row.errorCode}`}
         </p>
         <p>
            Restore: <code>{row.id}</code> · {row.mode} · {row.engine}
            <br />
            Exact snapshot: <code>{row.snapshotId}</code>
            <br />
            Backup: <code>{row.backupId}</code> · Repository: <code>{row.repositoryId}</code>
            <br />
            Archived database: {row.logicalDatabase} · Stable ID: <code>{row.databaseId}</code>
            <br />
            Retained database: {row.database || 'Not imported'}
            <br />
            Approved target: <code>{row.targetId}</code>
            <br />
            SQL: {formatBytes(row.sqlBytes)} · SHA-256: <code>{row.sha256}</code>
         </p>
         <p>
            Created {new Date(row.createdAt).toLocaleString()} · Expires {new Date(row.expiresAt).toLocaleString()}
            <br />
            Last validated: {row.lastValidatedAt ? new Date(row.lastValidatedAt).toLocaleString() : 'Not yet'}
         </p>
         {row.mode === 'internal' && row.status !== 'deleted' && (
            <div className={classes.card}>
               <p>
                  Lifecycle is manual operator-managed. Buttons submit a bounded request, not a Docker command or completion claim. Operator status is
                  the last verified observation, not a live container probe.
               </p>
               {row.status === 'provisioning_required' && (
                  <button disabled={pending} onClick={() => act('provision', {})}>
                     Request provisioning
                  </button>
               )}
               {row.status === 'active' && (
                  <button disabled={pending || row.expired} onClick={() => act('stop', {})}>
                     Request stop
                  </button>
               )}
               {row.status === 'stopped' && (
                  <button disabled={pending || row.expired} onClick={() => act('resume', {})}>
                     Request resume
                  </button>
               )}
               {(row.cancelRequested || row.expired) && (
                  <p>
                     Cleanup Required: an operator may need to resume the target for ownership-checked database cleanup, then approve exact
                     infrastructure removal. No resource is considered Deleted from a missing connection.
                  </p>
               )}
               <p>Ask the Linux operator to review this restore ID and its private request. See the persistent restore runbook.</p>
            </div>
         )}
         <button disabled={pending || !inspectable} onClick={() => act('inspect', {})}>
            Refresh metadata inspection
         </button>
         <p>No row data or SQL execution is exposed. Inspection is revoked at expiration.</p>
         {inspectable && row.inspection && (
            <div>
               <h4>Validated catalog</h4>
               <p>
                  {row.inspection.engine} {row.inspection.version} · {row.inspection.tables} tables · {row.inspection.views} views · Size{' '}
                  {row.inspection.bytes === null ? 'Not measurable' : formatBytes(row.inspection.bytes)} · Observed{' '}
                  {new Date(row.inspection.observedAt).toLocaleString()}
               </p>
               <div className={classes.scroll}>
                  <table>
                     <thead>
                        <tr>
                           <th>Schema</th>
                           <th>Name</th>
                           <th>Type</th>
                        </tr>
                     </thead>
                     <tbody>
                        {row.inspection.catalog.map((item) => (
                           <tr key={item.schema + ':' + item.name}>
                              <td>{item.schema}</td>
                              <td>{item.name}</td>
                              <td>{item.type}</td>
                           </tr>
                        ))}
                     </tbody>
                  </table>
               </div>
               {row.inspection.catalogTruncated && <p>Catalog display limited to 200 entries; counts cover all entries.</p>}
            </div>
         )}
         {row.status !== 'deleted' && (
            <div className={classes.card}>
               <h4>Delete / cancel this restore</h4>
               <p>
                  Deletes only the exact owned restored database and requests owned infrastructure removal. Original backups and snapshots are
                  untouched. Uncertain resources are retained for investigation.
               </p>
               <label>
                  Type the exact restore ID
                  <input
                     aria-label="Restore ID confirmation"
                     value={confirmation}
                     onChange={(event) => setConfirmation(event.target.value)}
                     autoComplete="off"
                  />
               </label>
               <button disabled={pending || confirmation !== row.id} onClick={() => act('delete', { confirmation })}>
                  Confirm owned deletion
               </button>
            </div>
         )}
      </div>
   );
}
export default function DatabaseRestores() {
   const { id } = useParams(),
      query = useDatabaseRestores(id),
      client = useQueryClient();
   const action = useMutation({
      mutationFn: ({ operation, body }: { operation: string; body?: unknown }) =>
         restoreRequest(`/${encodeURIComponent(id!)}/${operation}`, body || {}),
      onSuccess: () => client.invalidateQueries({ queryKey: ['databaseRestores'] }),
   });
   const [notice, setNotice] = useState('');
   const act = (operation: string, body?: unknown) => {
      setNotice('');
      action.mutate(
         { operation, body },
         {
            onSuccess: () =>
               setNotice(
                  ['provision', 'stop', 'resume'].includes(operation)
                     ? 'Request saved. Manual operator action is still required.'
                     : 'State updated; verify the current status below.',
               ),
         },
      );
   };
   return (
      <>
         <PageHeader title="Database Restore Management" icon="restore" />
         <div className={classes.panel}>
            <p>Retained restores are separate from disposable Recovery Tests. Start a restore from a completed backup’s menu.</p>
            {id && <Link to="/database-restores">All restores</Link>}
            <button disabled={query.isFetching} onClick={() => void query.refetch()}>
               Refresh
            </button>
            {query.isLoading && <p>Loading restores…</p>}
            {query.error && <p role="alert">{query.error.message}</p>}
            {action.error && <p role="alert">{action.error.message}</p>}
            {notice && <p role="status">{notice}</p>}
            {query.data &&
               (Array.isArray(query.data) ? (
                  <>
                     {!query.data.length && <p>No persistent database restores yet.</p>}
                     {query.data.map((row) => (
                        <div key={row.id} className={classes.card}>
                           <Link to={`/database-restores/${row.id}`}>
                              {row.logicalDatabase} · {row.engine} · {row.mode}
                           </Link>
                           <p>
                              {restoreStatus(row)} · Cleanup: {row.cleanup}
                              <br />
                              Expires {new Date(row.expiresAt).toLocaleString()} · <code>{row.id}</code>
                           </p>
                        </div>
                     ))}
                  </>
               ) : (
                  <RestoreDetails row={query.data} act={act} pending={action.isPending} />
               ))}
         </div>
      </>
   );
}

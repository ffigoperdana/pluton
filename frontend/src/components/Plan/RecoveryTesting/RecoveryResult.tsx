import type { RecoveryTest } from '../../../@types/recoveryTests';
import { recoveryActive, recoveryStatusLabel } from '../../../utils/recoveryTests';
import { formatBytes } from '../../../utils/helpers';
import Modal from '../../common/Modal/Modal';
import classes from './RecoveryTesting.module.scss';
export default function RecoveryResult({
   test,
   close,
   cancel,
   pending,
}: {
   test: RecoveryTest;
   close: () => void;
   cancel: () => void;
   pending: boolean;
}) {
   const seconds = test.startedAt
      ? Math.max(0, Math.round(((test.completedAt ? new Date(test.completedAt).getTime() : Date.now()) - new Date(test.startedAt).getTime()) / 1000))
      : 0;
   return (
      <Modal width="760px" title="Recovery Test Result" closeModal={close}>
         <div className={`${classes.panel} styled__scrollbar`}>
            <div className={classes.detail}>
               <div>
                  Backup: <code>{test.backupId}</code>
               </div>
               <div>
                  Test: <code>{test.id}</code> · {test.trigger === 'manual' ? 'Manual' : 'After backup'}
               </div>
               <div>
                  Exact snapshot: <code>{test.snapshotId}</code>
               </div>
               <div>
                  Recovery: {recoveryStatusLabel[test.status]} · Duration: {seconds}s
               </div>
               <div>Tested at: {test.completedAt ? new Date(test.completedAt).toLocaleString() : 'Not completed'}</div>
               {test.failureCode && (
                  <div role="alert">
                     {test.failureStage} / {test.failureCode}
                  </div>
               )}
            </div>
            <h4>Filesystem</h4>
            {test.result?.filesystem ? (
               <p>
                  Exact snapshot restored and structurally validated: {test.result.filesystem.files} regular files ·{' '}
                  {formatBytes(test.result.filesystem.bytes)} · {test.result.filesystem.sourceTrees} source trees.
               </p>
            ) : (
               <p>Not yet validated.</p>
            )}
            <p>Restic restore integrity and file/path/size checks are not application semantic checks or per-file hash comparisons.</p>
            <h4>Databases</h4>
            {test.result?.databases.map((database) => (
               <div key={database.path} className={classes.card}>
                  <div>
                     {database.engine || 'Historical engine not recorded'} · {database.databaseId || 'Historical single-DB artifact'} ·{' '}
                     {database.database || database.path}
                  </div>
                  <div>
                     Artifact: {database.artifactValidation} · {formatBytes(database.bytes)}
                  </div>
                  <code>SHA-256: {database.sha256}</code>
                  <div>
                     Import: {database.importValidation.replace(/_/g, ' ')} {database.failureCode && `· ${database.failureCode}`}
                  </div>
                  {database.tables !== undefined && (
                     <div>
                        Catalog verified: {database.tables} tables · {database.views || 0} views
                     </div>
                  )}
               </div>
            ))}
            {!test.result?.databases.length && <p>No database artifact checks recorded.</p>}
            <h4>Cleanup</h4>
            <p>
               Workspace: {test.result?.cleanup.workspace ? 'Complete' : 'Not confirmed'} · Temporary databases:{' '}
               {test.result?.cleanup.databases ? 'Complete' : 'Not confirmed'}
            </p>
            {test.warnings.map((warning, index) => (
               <p key={index}>
                  {warning.stage} / {warning.code}
               </p>
            ))}
            {recoveryActive(test) && (
               <button type="button" disabled={pending} onClick={cancel}>
                  Cancel Recovery Test
               </button>
            )}
            <p>Closing this view does not cancel the server-side job. Backup status is unchanged by its recovery result.</p>
         </div>
      </Modal>
   );
}

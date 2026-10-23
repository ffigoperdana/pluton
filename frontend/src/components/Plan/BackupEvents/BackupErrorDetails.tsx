import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getBackupProgress } from '../../../services/backups';
import {
   diagnosticSummary,
   historicalSourceFailure,
   safeDiagnosticRelativePath,
   sourceProblemCause,
   type SourceFailure,
} from '../../../utils/sourceDiagnostics';
import classes from './BackupErrorDetails.module.scss';

export default function BackupErrorDetails({
   message,
   failure: supplied,
   backup,
}: {
   message: string;
   failure?: SourceFailure;
   backup?: { id: string; planId: string; sourceId: string; sourceType: string };
}) {
   const [copied, setCopied] = useState('');
   const remote = Boolean(backup && backup.sourceType === 'device' && backup.sourceId !== 'main');
   const query = useQuery({
      queryKey: ['progress-backup', backup?.id],
      queryFn: () => getBackupProgress(backup!),
      enabled: remote,
      retry: false,
   });
   const failure: SourceFailure | undefined = supplied || query.data?.sourceFailure || historicalSourceFailure(message);
   const report = failure?.sourceDiagnostics;
   const sourceFailure = failure?.failureCode.startsWith('source-');
   const permissionDenied = report?.entries.some((entry) => entry.errno === 'EACCES' || entry.errno === 'EPERM');
   return (
      <div className={classes.details}>
         <p>{permissionDenied ? 'Backup failed: Source access denied' : message}</p>
         {failure && (
            <dl>
               <dt>Failure code</dt>
               <dd>{failure.failureCode}</dd>
               <dt>Failure stage</dt>
               <dd>{failure.failureStage}</dd>
            </dl>
         )}
         {query.isLoading && remote && <p role="status">Loading saved diagnostics…</p>}
         {query.isError && <p role="alert">Saved diagnostics could not be loaded. Reopen Error Details to retry.</p>}
         {report ? (
            <>
               <p>
                  Problem observations: {report.countIsLowerBound ? 'at least ' : ''}
                  {report.problemCount}. {report.entries.length} representative entries shown. Detected{' '}
                  {report.origin === 'preflight' ? 'before Restic' : 'during Restic'}. Counts can include repeat observations and omit inaccessible
                  subtrees.
               </p>
               <details open>
                  <summary>Technical details (relative to the approved source)</summary>
                  <ul>
                     {report.entries.slice(0, 20).map((entry, index) => (
                        <li key={index}>
                           <strong>Relative path: </strong>
                           <code dir="auto">
                              {entry.relativePath && safeDiagnosticRelativePath(entry.relativePath)
                                 ? entry.relativePath === '.'
                                    ? '. (source root)'
                                    : entry.relativePath
                                 : '[path withheld for safety]'}
                           </code>
                           <p>
                              Entry type: {entry.entryType === 'unknown' ? 'Not reported' : entry.entryType}
                              <br />
                              Cause: {sourceProblemCause(entry.errno)}
                              <br />
                              Excluded: no
                           </p>
                        </li>
                     ))}
                  </ul>
               </details>
            </>
         ) : (
            sourceFailure &&
            !query.isLoading && (
               <p>
                  Path-level diagnostics are unavailable for this job. Agent 0.7.0 and older report only a generic code. Historical jobs cannot
                  recover paths that were never reported. A diagnostics-capable Agent and Server are both required.
               </p>
            )
         )}
         {sourceFailure && (
            <p>
               Permission errors (EACCES/EPERM) mean the service identity could not access an entry. Missing entries (ENOENT) may have disappeared
               while the filesystem changed; they do not prove a permission problem. Inspect the reported relative entry and parent traversal access
               read-only using the backup service identity. The explicit local source preflight can help; Source Access Validate checks approved
               roots, not every file. Review saved exclusions before retrying. Do not broaden permissions on private keys or credentials. Any
               permission or exclusion change requires operator review.
            </p>
         )}
         <button
            type="button"
            onClick={async () => {
               try {
                  await navigator.clipboard.writeText(diagnosticSummary(failure));
                  setCopied('Diagnostic summary copied.');
               } catch {
                  setCopied('Copy unavailable. Select the technical details to copy them manually.');
               }
            }}
         >
            Copy diagnostic summary
         </button>
         <span role="status">{copied}</span>
      </div>
   );
}

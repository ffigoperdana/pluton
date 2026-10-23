import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getBackupProgress } from '../../../services/backups';
import { failureTroubleshootingTopic } from '../../../docs/troubleshootingTopics';
import {
   diagnosticSummary,
   historicalSourceFailure,
   sourceProblemCause,
   visibleSourceDiagnostics,
   hasSensitiveSourceName,
   safeErrorText,
   type SourceFailure,
} from '../../../utils/sourceDiagnostics';
import classes from './BackupErrorDetails.module.scss';

const sourceGuidance: Record<string, { problem: string; action: string }> = {
   'source-entry-inaccessible': {
      problem: 'The Agent could not access an included source file or directory.',
      action:
         'Review read access and parent directory traversal as the Agent service identity. Consider an exclusion only if the application owner confirms the entry is not needed for recovery.',
   },
   'source-root-not-readable': {
      problem: 'The selected source root was not readable or traversable by the Agent.',
      action: 'Verify the canonical source, mount availability and approved service access. Source approval does not grant Linux permissions.',
   },
   'source-parent-not-traversable': {
      problem: 'The Agent could not traverse a parent of the selected source.',
      action: 'Inspect each parent directory with the host owner. Do not widen approved roots or grant broad access.',
   },
   'source-missing': {
      problem: 'An expected source entry was missing. It may have disappeared during the run.',
      action: 'Check the source path, mount and application activity read-only. A missing entry does not prove a permission problem.',
   },
   'source-symlink-escape': {
      problem: 'A symlink resolved outside approved roots or changed during validation.',
      action: 'Review the canonical path and link target with the host owner. Do not follow the target or broaden source scope to bypass the policy.',
   },
   'source-unsupported-type': {
      problem: 'The selected source entry has an unsupported filesystem type.',
      action: 'Inspect its metadata and verify that the intended source is a supported file or directory.',
   },
   'source-policy-violation': {
      problem: 'The source did not meet the approved path policy.',
      action: 'Verify the canonical source and current host approval. Do not alter approval or private-directory boundaries as a workaround.',
   },
   'source-validation-failed': {
      problem: 'The Agent could not validate the selected source.',
      action: 'Review the approved source and safe stage/code details with the host operator. No more specific cause was reported.',
   },
};
const safeIdentifier = (value?: string) => (value && /^[a-z-]{1,80}$/.test(value) ? value : 'Not reported');
const safeReference = (value?: string) => (value && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : undefined);

export default function BackupErrorDetails({
   message,
   failure: supplied,
   backup,
   planId,
   onClose,
}: {
   message: string;
   failure?: SourceFailure;
   backup?: { id: string; planId: string; sourceId: string; sourceType: string };
   planId?: string;
   onClose?: () => void;
}) {
   const [copied, setCopied] = useState('');
   const remote = Boolean(backup && backup.sourceType === 'device' && backup.sourceId !== 'main');
   const query = useQuery({
      queryKey: ['progress-backup', backup?.id],
      queryFn: () => getBackupProgress(backup!),
      enabled: remote,
      retry: false,
      gcTime: 0,
      staleTime: 0,
      refetchOnMount: 'always',
   });
   // Never retain a cached path display after a denied/failed authenticated read.
   const failure: SourceFailure | undefined =
      remote && (query.isError || query.isFetching) ? undefined : supplied || query.data?.sourceFailure || historicalSourceFailure(message);
   const report = visibleSourceDiagnostics(failure?.sourceDiagnostics);
   const code = failure?.failureCode;
   const guidance = code && Object.prototype.hasOwnProperty.call(sourceGuidance, code) ? sourceGuidance[code] : undefined;
   const topic = failureTroubleshootingTopic(code);
   const source = safeReference(backup?.planId || planId);
   const sensitive = report?.entries.some((entry) => hasSensitiveSourceName(entry.relativePath));
   const omitted = report ? Math.max(0, report.problemCount - report.entries.length) : 0;
   return (
      <div className={classes.details}>
         {guidance ? (
            <>
               <h4>Backup Failed — Source Access Problem</h4>
               <p>
                  <strong>Problem: </strong>
                  {guidance.problem}
               </p>
            </>
         ) : (
            <p className={classes.message}>{safeErrorText(message)}</p>
         )}
         {failure && (
            <dl>
               <dt>Error code</dt>
               <dd>
                  <code>
                     {safeIdentifier(failure.failureStage)}/{safeIdentifier(code)}
                  </code>
               </dd>
               <dt>Failure stage</dt>
               <dd>{safeIdentifier(failure.failureStage)}</dd>
               {guidance && (
                  <>
                     <dt>Source reference</dt>
                     <dd>
                        {source ? (
                           <>
                              Approved source for backup plan <code>{source}</code>
                           </>
                        ) : (
                           'Approved source for this backup; root identifier was not reported.'
                        )}
                     </dd>
                  </>
               )}
               <dt>Detection stage</dt>
               <dd>
                  {report ? (report.origin === 'preflight' ? 'Source scan (before Restic)' : 'Restic backup') : 'Exact detection point not reported'}
               </dd>
            </dl>
         )}
         {query.isFetching && remote && <p role="status">Loading saved diagnostics…</p>}
         {query.isError && (
            <p role="alert">
               Saved diagnostics could not be loaded or access was denied. No cached paths are displayed. Reopen Error Details to retry.
            </p>
         )}
         {report ? (
            <>
               <p>
                  <strong>Problem observations: </strong>
                  {report.countIsLowerBound ? 'At least ' : ''}
                  {report.problemCount}. {report.entries.length} representative {report.entries.length === 1 ? 'entry' : 'entries'} shown (maximum
                  20).
                  {omitted > 0 && <> {omitted} additional observations are not shown; results are truncated.</>} Observations can repeat an entry.
                  Inaccessible subtrees and scan limits may leave other problems undiscovered.
               </p>
               <details open>
                  <summary>Technical details — safe relative paths</summary>
                  <p>Paths are relative to the approved source recorded for this backup. A dot (.) identifies the source root.</p>
                  <ul tabIndex={0} aria-label="Problem entries">
                     {report.entries.map((entry, index) => (
                        <li key={index}>
                           <strong>Problem entry: </strong>
                           <code dir="auto">{entry.relativePath || '[path withheld for safety]'}</code>
                           <dl>
                              <dt>Entry type</dt>
                              <dd>{entry.entryType === 'unknown' ? 'Not reported' : entry.entryType}</dd>
                              <dt>System error</dt>
                              <dd>{sourceProblemCause(entry.errno)}</dd>
                              <dt>Excluded</dt>
                              <dd>No</dd>
                           </dl>
                        </li>
                     ))}
                  </ul>
               </details>
            </>
         ) : (
            guidance &&
            !query.isLoading &&
            !query.isError && (
               <p role="note">
                  Path-level diagnostics are unavailable for this historical Agent/job. Agent 0.7.0 and older report only a generic code. Agent 0.7.1
                  also needs Server opt-in; historical paths cannot be recovered if they were never reported.
               </p>
            )
         )}
         {guidance && (
            <>
               <p>
                  <strong>Next action: </strong>
                  {guidance.action}
               </p>
               <p>
                  Permission errors (EACCES/EPERM) differ from missing entries (ENOENT) or changed path components (ENOTDIR). Source Access Validate
                  checks roots, not every nested file. A readable root is not proof that the whole tree is readable.
               </p>
            </>
         )}
         {sensitive && (
            <p className={classes.warning} role="note">
               <strong>Sensitive filename detected.</strong> Do not make SSH keys, credentials or secret stores readable as a convenient fix. Ask the
               application/host owner to review its ownership, use and recovery requirement. An exclusion is a separate reviewed decision.
            </p>
         )}
         <aside className={classes.help} aria-label="Troubleshooting help">
            <strong>Need help fixing this issue?</strong>
            <p>
               {guidance
                  ? 'Open the Source Access Troubleshooting Guide to verify the affected entry, inspect Linux permissions, review a minimal ACL or choose a safe exclusion.'
                  : 'Use the troubleshooting guide for the reported code. Unknown errors open the general overview.'}{' '}
               Commands are static examples for manual review; the browser does not execute them.
            </p>
            <a href={topic.href}>{guidance ? 'Open Troubleshooting Guide' : topic.title}</a>
         </aside>
         <div className={classes.actions}>
            <button
               type="button"
               disabled={remote && (query.isFetching || query.isError)}
               onClick={async () => {
                  try {
                     await navigator.clipboard.writeText(diagnosticSummary(failure));
                     setCopied('Sanitized diagnostics copied. Review before sharing.');
                  } catch {
                     setCopied('Copy unavailable. Select the safe details to copy them manually.');
                  }
               }}
            >
               Copy Sanitized Diagnostics
            </button>
            {onClose && (
               <button type="button" onClick={onClose}>
                  Close
               </button>
            )}
         </div>
         <span role="status" aria-live="polite">
            {copied}
         </span>
      </div>
   );
}

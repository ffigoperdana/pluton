export type SourceDiagnostics = {
   version: 1;
   origin: 'preflight' | 'restic';
   problemCount: number;
   countIsLowerBound: boolean;
   entries: {
      relativePath?: string;
      entryType: 'file' | 'directory' | 'symlink' | 'other' | 'unknown';
      errno: 'EACCES' | 'EPERM' | 'ENOENT' | 'ENOTDIR' | 'ELOOP' | 'UNKNOWN';
      excluded: false;
   }[];
};
export type SourceFailure = { failureStage: string; failureCode: string; sourceDiagnostics?: SourceDiagnostics };

export function safeDiagnosticRelativePath(value: string): boolean {
   return (
      value === '.' ||
      Boolean(
         value &&
            value.length <= 512 &&
            !/\p{M}{4,}/u.test(value) &&
            /^[\p{L}\p{N}\p{M} ._+@()[\]{}!#$%&',;~/-]+$/u.test(value) &&
            !value.startsWith('/') &&
            !value.split('/').some((part) => !part || part === '.' || part === '..') &&
            !/(?:password|token|secret|credential|key)\s*=|-----BEGIN|:\/\//i.test(value),
      )
   );
}

export function historicalSourceFailure(message: string): SourceFailure | undefined {
   const match =
      /\((source-validation|restic-backup)\/(source-entry-inaccessible|source-root-not-readable|source-missing|source-parent-not-traversable|source-symlink-escape|source-policy-violation|source-unsupported-type|source-validation-failed)\)\.?$/.exec(
         message,
      );
   return match ? { failureStage: match[1], failureCode: match[2] } : undefined;
}

export const sourceProblemCause = (errno: SourceDiagnostics['entries'][number]['errno']) =>
   ({
      EACCES: 'Permission denied (EACCES)',
      EPERM: 'Operation not permitted (EPERM)',
      ENOENT: 'Entry disappeared or is missing (ENOENT)',
      ENOTDIR: 'A path component changed or is not a directory (ENOTDIR)',
      ELOOP: 'Symlink loop (ELOOP)',
      UNKNOWN: 'OS category was not reported',
   })[errno];

/** Defense in depth for UI/clipboard: the authenticated API already validates
 * this contract. Bound samples again and never spread arbitrary entry fields. */
export function visibleSourceDiagnostics(report?: SourceDiagnostics): SourceDiagnostics | undefined {
   if (
      !report ||
      report.version !== 1 ||
      !['preflight', 'restic'].includes(report.origin) ||
      !Number.isSafeInteger(report.problemCount) ||
      report.problemCount < 1 ||
      !Array.isArray(report.entries) ||
      !report.entries.length ||
      report.problemCount < Math.min(report.entries.length, 20)
   )
      return;
   return {
      version: 1,
      origin: report.origin,
      problemCount: report.problemCount,
      countIsLowerBound: report.countIsLowerBound !== false,
      entries: report.entries.slice(0, 20).map((entry) => ({
         relativePath:
            typeof entry?.relativePath === 'string' && safeDiagnosticRelativePath(entry.relativePath) && !/[$;&'()]/.test(entry.relativePath)
               ? entry.relativePath
               : undefined,
         entryType: ['file', 'directory', 'symlink', 'other', 'unknown'].includes(entry?.entryType) ? entry.entryType : 'unknown',
         errno: ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ELOOP', 'UNKNOWN'].includes(entry?.errno) ? entry.errno : 'UNKNOWN',
         excluded: false,
      })),
   };
}

export function safeErrorText(message: string): string {
   return message
      .slice(0, 2000)
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, (character) => (character === '\n' ? '\n' : ' '));
}

export function hasSensitiveSourceName(relative?: string): boolean {
   return Boolean(
      relative &&
         /(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.ssh|\.aws|\.gnupg|\.kube|\.env(?:\.[^/]*)?|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|[^/]+\.(?:pem|key|p12|pfx))(?:\/|$)/i.test(
            relative,
         ),
   );
}

/** Copy only closed metadata and validated names, never arbitrary legacy error
 * text or provider messages. Rendering uses React text nodes, never HTML. */
export function diagnosticSummary(failure?: SourceFailure): string {
   if (!failure) return 'Path-level diagnostics were not reported for this backup.';
   const lines = [
      `Failure stage: ${/^[a-z-]{1,60}$/.test(failure.failureStage) ? failure.failureStage : 'unavailable'}`,
      `Failure code: ${/^[a-z-]{1,80}$/.test(failure.failureCode) ? failure.failureCode : 'unavailable'}`,
   ];
   const report = visibleSourceDiagnostics(failure.sourceDiagnostics);
   if (!report) return [...lines, 'Path-level diagnostics were not reported for this backup.'].join('\n');
   lines.push(
      `Problem observations: ${report.countIsLowerBound ? 'at least ' : ''}${report.problemCount}`,
      `Detected: ${report.origin === 'preflight' ? 'before Restic' : 'during Restic'}`,
   );
   for (const entry of report.entries.slice(0, 20))
      lines.push(
         `Relative path: ${entry.relativePath && safeDiagnosticRelativePath(entry.relativePath) ? entry.relativePath : '[path withheld for safety]'}`,
         `Entry type: ${entry.entryType}`,
         `Cause: ${sourceProblemCause(entry.errno)}`,
         'Excluded: no',
      );
   return lines.join('\n');
}

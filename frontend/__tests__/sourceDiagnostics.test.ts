import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnosticSummary, historicalSourceFailure, safeDiagnosticRelativePath, type SourceFailure } from '../src/utils/sourceDiagnostics.ts';
import { backupExclusionMatches, sourcePrefixedExclusions, parseBackupExclusions } from '../src/utils/backupExclusions.ts';

test('copied summaries contain observed relative diagnostics and no provider text or fabricated errno', () => {
   const failure: SourceFailure = {
      failureStage: 'restic-backup',
      failureCode: 'source-entry-inaccessible',
      sourceDiagnostics: {
         version: 1,
         origin: 'restic',
         problemCount: 2,
         countIsLowerBound: true,
         entries: [
            { relativePath: 'app/logs/id_rsa', entryType: 'unknown', errno: 'EACCES', excluded: false },
            { relativePath: 'file with spaces', entryType: 'file', errno: 'ENOENT', excluded: false },
         ],
      },
   };
   const summary = diagnosticSummary(failure);
   assert.match(summary, /at least 2/);
   assert.match(summary, /app\/logs\/id_rsa/);
   assert.match(summary, /Entry type: unknown/);
   assert.match(summary, /ENOENT/);
   failure.sourceDiagnostics!.entries[0].relativePath = '/absolute/unsafe';
   assert.match(diagnosticSummary(failure), /path withheld/);
   assert.ok(!diagnosticSummary(failure).includes('/absolute/unsafe'));
   const historical = historicalSourceFailure('Generic message (restic-backup/source-entry-inaccessible).');
   assert.ok(historical);
   assert.ok(!historical.sourceDiagnostics);
   assert.match(diagnosticSummary(historical), /not reported/);
   assert.ok(!diagnosticSummary(historical).includes('EACCES'));
   assert.equal(historicalSourceFailure('synthetic private provider detail'), undefined);
});

test('path display and copy reject terminal controls, HTML, Unicode direction overrides and credential assignments', () => {
   for (const value of [
      '<img src=x onerror=alert(1)>',
      'a\nb',
      'a\u202eb',
      'a' + '\u0301'.repeat(10),
      'a\u001bb',
      'password=synthetic',
      '../x',
      'C:\\private',
      'x'.repeat(513),
   ])
      assert.equal(safeDiagnosticRelativePath(value), false);
   for (const value of ['app/logs/id_rsa', '資料/with spaces.pdf']) assert.equal(safeDiagnosticRelativePath(value), true);
});

test('exclusion warning detects a copied source prefix, preserves choices, and preview uses the actual relative matcher', () => {
   const source = '/srv/example-app';
   const patterns = ['srv/example-app/public_html/console-app/export/tmp', 'app/logs', '.git', 'cache', 'public_html/console-app/export/tmp'];
   const before = [...patterns];
   assert.deepEqual(sourcePrefixedExclusions(source, patterns), [patterns[0]]);
   assert.deepEqual(patterns, before);
   assert.throws(() => parseBackupExclusions(['/srv/example-app/app/logs']));
   for (const relative of ['app/logs/id_rsa', '.git/config', 'nested/cache/file', 'public_html/console-app/export/tmp/file'])
      assert.equal(backupExclusionMatches(patterns, relative), true);
   assert.equal(backupExclusionMatches([patterns[0]], 'public_html/console-app/export/tmp/file'), false);
});

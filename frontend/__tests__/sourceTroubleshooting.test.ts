import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { docArticles } from '../src/docs/manifest.ts';
import { createDocsIndex, parseDoc, searchDocs, validateDocLinks } from '../src/docs/model.ts';
import { troubleshootingTopics, failureTroubleshootingTopic, backupRecoveryTopics } from '../src/docs/troubleshootingTopics.ts';
import {
   diagnosticSummary,
   hasSensitiveSourceName,
   visibleSourceDiagnostics,
   safeErrorText,
   type SourceDiagnostics,
} from '../src/utils/sourceDiagnostics.ts';
import { backupExclusionMatches } from '../src/utils/backupExclusions.ts';

const index = createDocsIndex(
   Object.fromEntries(
      docArticles.map((article) => [article.slug, readFileSync(new URL(`../src/docs/articles/${article.slug}.md`, import.meta.url), 'utf8')]),
   ),
);
const guide = index.find((article) => article.slug === 'troubleshooting/source')!;

test('all static failure topics and Backup & Recovery shortcuts resolve to real article anchors', () => {
   assert.deepEqual(validateDocLinks(index), []);
   for (const topic of [...Object.values(troubleshootingTopics), ...backupRecoveryTopics]) {
      const [route, fragment] = topic.href.split('#');
      const article = index.find((article) => '/docs/' + article.slug === route);
      assert(article, topic.href);
      if (fragment)
         assert(
            article.headings.some((heading) => heading.id === fragment),
            topic.href,
         );
   }
   for (const code of ['source-entry-inaccessible', 'source-missing', 'source-parent-not-traversable', 'source-symlink-escape'])
      assert.equal(failureTroubleshootingTopic(code), troubleshootingTopics.source);
   assert.equal(failureTroubleshootingTopic('database-tls-verification-failed'), troubleshootingTopics.databaseTls);
   assert.equal(failureTroubleshootingTopic('agent-offline'), troubleshootingTopics.agent);
   for (const code of [undefined, 'unknown-code', '__proto__', 'constructor', '../file#evil', 'https://example.internal'])
      assert.equal(failureTroubleshootingTopic(code), troubleshootingTopics.overview);
});

test('the existing source guide supplies fourteen complete sections, preserves old anchors and is searchable', () => {
   assert.equal(guide.title, 'Troubleshooting: Source Files or Directories Are Inaccessible');
   assert.deepEqual(
      guide.headings.filter((heading) => heading.depth === 2).map((heading) => Number(heading.text.match(/^\d+/)?.[0])),
      Array.from({ length: 14 }, (_, i) => i + 1),
   );
   for (const anchor of [
      'gejala',
      'penyebab',
      'diagnostik-aman',
      'resolusi',
      'excluded-versus-included',
      'jangan-lakukan',
      'source-tidak-terbaca-atau-symlink-ditolak',
   ])
      assert(
         guide.headings.some((heading) => heading.id === anchor),
         anchor,
      );
   for (const term of ['EACCES', 'setfacl', 'exclusions', 'id_rsa'])
      assert(
         searchDocs(index, term).some((result) => result.article.slug === guide.slug),
         term,
      );
});

test('copy-enabled command examples are static and read-only; mutations are manual review blocks', () => {
   const blocks = parseDoc(guide.markdown).tokens.filter((token) => token.type === 'code');
   assert(blocks.length >= 12);
   for (const block of blocks) {
      assert(['bash readonly', 'bash review', 'text review'].includes(block.lang!), block.lang);
      if (block.lang === 'bash readonly') {
         assert(!/\b(?:setfacl|chmod|chown|apt-get|curl|wget|eval|exec)\b|find[^\n]*-(?:delete|exec|ok)\b/.test(block.text!));
         assert(!/\bcat\b|id_rsa\s*$/.test(block.text!));
      }
      if (/setfacl|apt-get/.test(block.text!)) assert.equal(block.lang, 'bash review');
   }
   assert(guide.markdown.includes('paket Ubuntu **acl**, bukan paket bernama getfacl'));
   for (const term of ['mask', 'original ACL', 'entry lama', 'Tidak ada `-R` default', 'SYS MON', 'SHADOW', 'satu controlled retry'])
      assert(guide.markdown.includes(term), term);
   for (const root of guide.markdown.matchAll(/ROOT='([^']+)'/g)) assert.equal(root[1], '/srv/example-app');
});

test('documented exclusions obey the actual matcher, while manual find pruning is explicitly limited', () => {
   assert(backupExclusionMatches(['app/logs'], 'app/logs/id_rsa'));
   assert(backupExclusionMatches(['cache'], 'nested/cache/output'));
   assert(!backupExclusionMatches(['*/cache'], 'cache/output'));
   assert(!backupExclusionMatches(['node_modules/**'], 'nested/node_modules/output'));
   assert(backupExclusionMatches(['public_html/console-app/export/tmp'], 'public_html/console-app/export/tmp/file.pdf'));
   for (const warning of ['manual sample scanner, bukan bukti exact Restic', 'Root-only prune', 'snapshot lama', 'sebelum', 'bukan runtime'])
      assert(guide.markdown.includes(warning), warning);
});

test('bounded rendering/copy never turns a path into a shell template or a URL', () => {
   const entries = Array.from({ length: 30 }, (_, i) => ({
      relativePath: `file-${i}`,
      entryType: 'file' as const,
      errno: 'EACCES' as const,
      excluded: false as const,
   }));
   const report: SourceDiagnostics = { version: 1, origin: 'restic', problemCount: 100, countIsLowerBound: true, entries };
   assert.equal(visibleSourceDiagnostics(report)?.entries.length, 20);
   for (const name of ['file$(touch synthetic)', 'a;echo unsafe', 'a\nmalicious', 'a\u202eb', '../outside', '/absolute', '<script>']) {
      report.entries[0].relativePath = name;
      const summary = diagnosticSummary({ failureStage: 'restic-backup', failureCode: 'source-entry-inaccessible', sourceDiagnostics: report });
      assert(!summary.includes(name));
      assert(summary.includes('path withheld'));
      assert.equal(failureTroubleshootingTopic(name), troubleshootingTopics.overview);
   }
   for (const name of ['app/logs/id_rsa', '.ssh/key', '.env', 'config/credentials.json', 'client.key']) assert(hasSensitiveSourceName(name));
   assert(!hasSensitiveSourceName('report.pdf'));
   assert.equal(safeErrorText('\u001b[31mFailure\u001b[0m\u202e\u0000'), 'Failure  ');
   assert.equal(visibleSourceDiagnostics({ ...report, problemCount: Infinity }), undefined);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { docArticles, docCategories } from '../src/docs/manifest.ts';
import { createDocsIndex, parseDoc, resolveDoc, safeDocUrl, searchDocs, validateDocLinks } from '../src/docs/model.ts';
const index = createDocsIndex(
   Object.fromEntries(
      docArticles.map((article) => [article.slug, readFileSync(new URL(`../src/docs/articles/${article.slug}.md`, import.meta.url), 'utf8')]),
   ),
);
test('all required categories and representative routes have original Bahasa Indonesia articles', () => {
   assert.equal(docCategories.length, 15);
   assert.equal(index.length, 96);
   assert.equal(new Set(index.map((a) => a.slug)).size, index.length);
   // Source-built images need no Git metadata; a checkout must not silently omit
   // a public article because a credential-file ignore pattern matches its name.
   const root = fileURLToPath(new URL('../../', import.meta.url));
   if (existsSync(new URL('../../.git', import.meta.url))) {
      const result = spawnSync('git', ['check-ignore', '--stdin'], {
         cwd: root,
         input: index.map((article) => `frontend/src/docs/articles/${article.slug}.md`).join('\n') + '\n',
         encoding: 'utf8',
      });
      assert.equal(result.status, 1, `Public documentation must not be Git-ignored: ${result.stdout}`);
   }
   for (const route of [
      'getting-started',
      'architecture',
      'backup-plans',
      'remote-agent',
      'database-backup',
      'recovery-testing',
      'notifications',
      'troubleshooting',
      'changelog',
      'storage/local',
      'storage/hcp',
      'backup-plans/managed-agent',
      'backup-plans/delete',
      'database-restores',
      'database-restores/stop-resume',
      'replication/managed-agent',
      'replication/retention-restore',
      'migration/shadow',
      'migration/cutover',
   ])
      assert(resolveDoc('/docs/' + route));
   for (const article of index) {
      assert.equal(article.headings[0].depth, 1);
      assert.equal(article.headings[0].text, article.title);
      assert(article.markdown.length > 600, article.slug);
   }
});

test('redesigned journeys preserve every existing article URL and expose retained database management', () => {
   const originalRoutes = [
      'getting-started', 'getting-started/requirements', 'getting-started/quick-start', 'getting-started/dashboard', 'getting-started/terms',
      'deployment', 'deployment/docker', 'deployment/configuration', 'deployment/persistence', 'deployment/updates', 'deployment/rollback', 'deployment/vm-logs',
      'architecture', 'architecture/workflow', 'architecture/states', 'storage', 'storage/sftp', 'storage/s3', 'storage/security',
      'backup-plans', 'backup-plans/schedule-retention', 'backup-plans/advanced', 'backup-plans/history', 'backup-plans/incremental',
      'remote-agent', 'remote-agent/enrollment', 'remote-agent/permissions', 'remote-agent/updates', 'remote-agent/troubleshooting',
      'database-backup', 'database-backup/engines', 'database-backup/connections', 'database-backup/dump-options', 'database-backup/hooks', 'database-backup/artifacts',
      'restore', 'restore/browse', 'restore/selection', 'restore/staging',
      'recovery-testing', 'recovery-testing/validation', 'recovery-testing/import', 'recovery-testing/results',
      'legacy-repositories', 'legacy-repositories/registration', 'legacy-repositories/restore', 'legacy-repositories/migration',
      'notifications', 'notifications/webhook', 'notifications/smtp', 'notifications/subscriptions', 'notifications/history',
      'security', 'security/https', 'security/credentials', 'security/boundaries',
      'operations', 'operations/monitoring', 'operations/disaster-recovery', 'operations/cutover',
      'troubleshooting', 'troubleshooting/source', 'troubleshooting/database', 'troubleshooting/incremental', 'troubleshooting/sftp', 'troubleshooting/recovery', 'troubleshooting/notifications',
      'reference', 'reference/configuration', 'reference/api', 'reference/status-codes', 'reference/version', 'reference/limitations', 'reference/faq', 'reference/acknowledgements', 'reference/contributing', 'changelog',
   ];
   assert.equal(originalRoutes.length, 77);
   for (const slug of originalRoutes) assert(resolveDoc('/docs/' + slug), slug);
   for (const category of ['database-restores', 'replication', 'migration'])
      assert(docCategories.some((item) => item.id === category), category);
   assert.equal(docCategories[0].articles[0].slug, 'getting-started');
   assert(docCategories[0].articles.some((article) => article.slug === 'getting-started/quick-start'));
   for (const [query, slug] of [
      ['Persistent Restore', 'database-restores'],
      ['HCP', 'storage/hcp'],
      ['SHADOW', 'migration/shadow'],
   ]) assert(searchDocs(index, query).some((item) => item.article.slug === slug), query);
});
test('all sidebar paths, internal links and heading anchors resolve', () => {
   assert.deepEqual(validateDocLinks(index), []);
   for (const category of docCategories)
      for (const article of category.articles) assert.equal(resolveDoc('/docs/' + article.slug + '/')?.slug, article.slug);
   assert.equal(resolveDoc('/docs/not-a-real-article'), undefined);
   assert.equal(resolveDoc('/api/settings'), undefined);
});
test('reference evidence points to actual implementation, not fabricated feature files', () => {
   for (const category of docCategories)
      for (const source of category.evidence) assert(existsSync(new URL('../../' + source, import.meta.url)), source);
});
test('local search covers title, headings and operational article content', () => {
   assert(searchDocs(index, 'HMAC').some((item) => item.article.slug === 'notifications/webhook'));
   assert(searchDocs(index, '1044').some((item) => item.article.slug === 'troubleshooting/database'));
   assert(searchDocs(index, 'successful local completion receipts').some((item) => item.article.slug === 'backup-plans/incremental'));
   assert.deepEqual(searchDocs(index, ''), []);
   assert.deepEqual(searchDocs(index, 'does-not-exist-synthetic-term'), []);
});
test('duplicate headings get stable unique deep-linkable anchors', () => {
   assert.deepEqual(
      parseDoc('# Contoh\n\n## Setup\n\n## Setup\n').headings.map((h) => h.id),
      ['contoh', 'setup', 'setup-1'],
   );
   const broken = index.map((article, i) => (i ? article : { ...article, ...parseDoc('# Title\n\n[bad](/docs/unknown#missing)') }));
   assert(validateDocLinks(broken).length > 0);
});
test('local screenshot URLs are not mistaken for article routes; malformed anchors fail validation safely', () => {
   const withImage = index.map((article, i) => (i ? article : { ...article, ...parseDoc('# Title\n\n![Example](/docs-assets/example.png)') }));
   assert.deepEqual(validateDocLinks(withImage), []);
   const malformed = index.map((article, i) => (i ? article : { ...article, ...parseDoc('# Title\n\n[Section](#bad%XX)') }));
   assert(validateDocLinks(malformed).some((error) => error.includes('malformed anchor')));
});
test('docs contain no credential-like values or active upstream product navigation', () => {
   const text = index.map((a) => a.markdown).join('\n');
   assert(!/https?:\/\/[^\s)]*usepluton\.com/i.test(text));
   assert(!/-----BEGIN .*PRIVATE KEY-----|(?:password|token|SECRET|ENCRYPTION_KEY)\s*[:=]\s*["'][^<${"'\n][^"'\n]{8,}["']/i.test(text));
   // Infrastructure examples use reserved documentation ranges or example domains.
   assert(!/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/.test(text));
});
test('renderer URL policy refuses active content, remote image dependencies and credential URLs', () => {
   for (const url of [
      'javascript:alert(1)',
      'data:text/html,hello',
      'file:///etc/passwd',
      '//example.internal',
      'https://user:pass@example.internal',
      'https://docs.usepluton.com/',
      'java\nscript:alert(1)',
   ])
      assert.equal(safeDocUrl(url), undefined);
   assert.equal(safeDocUrl('https://example.internal/image.png', true), undefined);
   assert.equal(safeDocUrl('/docs-assets/example.png', true), '/docs-assets/example.png');
   assert.equal(safeDocUrl('/docs/security#trust'), '/docs/security#trust');
});
test('docs use an isolated Fumadocs document, without introducing styles/providers into app pages', () => {
   const css = readFileSync(new URL('../../documentation/src/styles.css', import.meta.url), 'utf8');
   assert(css.includes('fumadocs-ui/css/preset.css'));
   assert(css.includes('fumadocs-ui/css/neutral.css'));
   const app = readFileSync(new URL('../../documentation/src/App.tsx', import.meta.url), 'utf8');
   for (const component of ['RootProvider', 'DocsLayout', 'DocsPage', 'DocsTitle', 'DocsDescription', 'DocsBody']) assert(app.includes(component));
   assert(!/useAuth|useGetSettings|api\/settings/.test(app));
   const router = readFileSync(new URL('../src/router.tsx', import.meta.url), 'utf8');
   assert(!/fumadocs-ui|fumadocs-core|ThemeCompatibility|styles\.css/.test(router));
   assert(router.includes('DocumentationRedirect'));
});

test('documentation document boundary preserves fragments and avoids old service-worker reload loops', () => {
   const redirect = readFileSync(new URL('../src/docs/DocumentationRedirect.tsx', import.meta.url), 'utf8');
   assert(redirect.includes('location.pathname + location.search + location.hash'));
   assert(redirect.includes("sessionStorage.getItem('pluton-docs-document-redirect') === target"));
   const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
   assert(config.includes('navigateFallbackDenylist'));
   assert(config.includes('^\\/docs'));
});

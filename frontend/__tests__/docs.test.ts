import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
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
   assert.equal(index.length, 77);
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
   ])
      assert(resolveDoc('/docs/' + route));
   for (const article of index) {
      assert.equal(article.headings[0].depth, 1);
      assert.equal(article.headings[0].text, article.title);
      assert(article.markdown.length > 600, article.slug);
   }
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

const require = createRequire(new URL('../package.json', import.meta.url));
const backendRequire = createRequire(new URL('../../backend/package.json', import.meta.url));
// Match the production React bundle for SSR assertions (the app itself is a SPA).
const previousEnvironment = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';
test.after(() => {
   if (previousEnvironment === undefined) delete process.env.NODE_ENV;
   else process.env.NODE_ENV = previousEnvironment;
});
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { MemoryRouter } = require('react-router');
async function component(name: string, mockContent = false) {
   const { build } = backendRequire('esbuild');
   const result = await build({
      entryPoints: [new URL('../src/docs/' + name, import.meta.url).pathname.replace(/^\/(?:([A-Z]:))/, '$1')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
      jsx: 'automatic',
      external: ['react', 'react-dom', 'react-router'],
      plugins: [
         {
            name: 'styles',
            setup(build: any) {
               build.onLoad({ filter: /\.scss$/ }, () => ({ contents: 'export default new Proxy({}, {get: (_t,k) => String(k)});', loader: 'js' }));
            },
         },
         ...(mockContent
            ? [
                 {
                    name: 'static-content',
                    setup(build: any) {
                       build.onLoad({ filter: /docs[\\/]content\.ts$/ }, () => ({
                          contents: `export const docsIndex = ${JSON.stringify(index)};`,
                          loader: 'js',
                       }));
                    },
                 },
              ]
            : []),
      ],
   });
   const module = { exports: {} as any };
   new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
   return module.exports;
}
test('actual Markdown React rendering safely escapes HTML, script and code, and blocks unsafe links/images', async () => {
   const Markdown = (await component('Markdown.tsx')).default;
   const tokens = parseDoc(
      '# Heading\n\n<script>alert(1)</script>\n\n[click](javascript:alert(1))\n\n![remote](https://example.internal/image.png)\n\n```sh\n<svg onload=alert(1)>\n```\n\n[local](/docs/security)',
   ).tokens;
   const html = renderToStaticMarkup(React.createElement(MemoryRouter, {}, React.createElement(Markdown, { tokens })));
   assert(!/<script>|<svg|href="javascript:|src="https:|dangerouslySetInnerHTML/.test(html));
   assert.match(html, /&lt;script&gt;/);
   assert.match(html, /href="\/docs\/security"/);
   assert.match(html, /Salin contoh kode/);
});
test('actual docs pages render navigation, article, TOC, breadcrumbs, previous/next and safe 404', async () => {
   // Render the real page with the shared ThemeContext bundled via a virtual entry.
   const result = await backendRequire('esbuild').build({
      stdin: {
         contents: `export { default as Docs } from './docs/Docs'; export { ThemeProvider } from './context/ThemeContext';`,
         resolveDir: new URL('../src/', import.meta.url).pathname.replace(/^\/(?:([A-Z]:))/, '$1'),
         loader: 'tsx',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
      jsx: 'automatic',
      external: ['react', 'react-dom', 'react-router'],
      plugins: [
         {
            name: 'test-resources',
            setup(build: any) {
               build.onLoad({ filter: /\.scss$/ }, () => ({ contents: 'export default new Proxy({}, {get: (_t,k) => String(k)});', loader: 'js' }));
               build.onLoad({ filter: /docs[\\/]content\.ts$/ }, () => ({
                  contents: `export const docsIndex = ${JSON.stringify(index)};`,
                  loader: 'js',
               }));
            },
         },
      ],
   });
   const compiled = { exports: {} as any };
   new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, compiled, compiled.exports);
   for (const route of ['/docs', '/docs/backup-plans/incremental', '/docs/no-such-article']) {
      const html = renderToStaticMarkup(
         React.createElement(
            MemoryRouter,
            { initialEntries: [route] },
            React.createElement(compiled.exports.ThemeProvider, {}, React.createElement(compiled.exports.Docs)),
         ),
      );
      assert.match(html, /Cari dokumentasi lokal/);
      assert.match(html, /Kategori dokumentasi/);
      assert(!/api\/settings|Update Available|usepluton\.com/.test(html));
      if (route === '/docs') assert.match(html, /Dokumentasi Pluton self-hosted/);
      else if (route.includes('incremental')) {
         assert.match(html, /Breadcrumb/);
         assert.match(html, /Daftar isi artikel/);
         assert.match(html, /id="parent-yang-aman"/);
         assert.match(html, /Sebelumnya/);
         assert.match(html, /Berikutnya/);
      } else assert.match(html, /Artikel tidak ditemukan/);
   }
});
test('docs use real light/dark tokens, responsive layout, focus and public route without auth hooks', () => {
   const css = readFileSync(new URL('../src/docs/Docs.module.scss', import.meta.url), 'utf8');
   const global = readFileSync(new URL('../src/styles/global.scss', import.meta.url), 'utf8');
   for (const token of [...css.matchAll(/var\((--[a-z-]+)\)/g)].map((item) => item[1])) assert(global.includes(token + ':'), token);
   assert(css.includes('@media (max-width: 760px)'));
   assert(css.includes(':focus-visible'));
   assert(!/color:\s*(white|#fff)\b/.test(css));
   assert(!css.includes('color: var(--primary-text-color)'), 'on-accent white token must not color documentation headings on a plain Light surface');
   const page = readFileSync(new URL('../src/docs/Docs.tsx', import.meta.url), 'utf8');
   assert(!/useAuth|useGetSettings|fetch\(/.test(page));
   assert(!/dangerouslySetInnerHTML/.test(readFileSync(new URL('../src/docs/Markdown.tsx', import.meta.url), 'utf8')));
});

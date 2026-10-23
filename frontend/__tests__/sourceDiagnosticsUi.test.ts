import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../package.json', import.meta.url));
const backendRequire = createRequire(new URL('../../backend/package.json', import.meta.url));
const React = require('react');
const { act } = React;
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { JSDOM } = require('jsdom');
const output = await backendRequire('esbuild').build({
   entryPoints: [fileURLToPath(new URL('../src/components/Plan/BackupEvents/BackupErrorDetails.tsx', import.meta.url))],
   bundle: true,
   platform: 'node',
   format: 'cjs',
   jsx: 'automatic',
   write: false,
   external: ['react', 'react/jsx-runtime', 'react-dom', '@tanstack/react-query'],
   plugins: [
      {
         name: 'diagnostics-fixture',
         setup(builder: any) {
            builder.onLoad({ filter: /\.scss$/ }, () => ({ contents: 'export default {};', loader: 'js' }));
            builder.onLoad({ filter: /[\\/]services[\\/]backups\.ts$/ }, () => ({
               contents: 'export const getBackupProgress=async()=>{globalThis.__diagnosticReads++;return globalThis.__savedDiagnostics;};',
               loader: 'js',
            }));
         },
      },
   ],
});
const module = { exports: {} as any };
new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, module, module.exports);
const Component = module.exports.default;

test('error details show real observations, safe copy, historical limitation and fetch only saved results on explicit open', async () => {
   const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.internal/' });
   const keys = ['window', 'document', 'navigator', 'IS_REACT_ACT_ENVIRONMENT', '__diagnosticReads', '__savedDiagnostics'];
   const previous = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
   let copied = '';
   Object.defineProperty(dom.window.navigator, 'clipboard', {
      value: {
         writeText: async (value: string) => {
            copied = value;
         },
      },
   });
   for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
      __diagnosticReads: 0,
   }))
      Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
   const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
   const { createRoot } = require('react-dom/client');
   const root = createRoot(dom.window.document.querySelector('#root'));
   const failure = {
      failureStage: 'restic-backup',
      failureCode: 'source-entry-inaccessible',
      sourceDiagnostics: {
         version: 1,
         origin: 'restic',
         problemCount: 2,
         countIsLowerBound: true,
         entries: [
            { relativePath: 'app/logs/id_rsa', entryType: 'unknown', errno: 'EACCES', excluded: false },
            { relativePath: 'a\n<img src=x>', entryType: 'file', errno: 'ENOENT', excluded: false },
         ],
      },
   };
   const render = async (props: any) =>
      act(async () => root.render(React.createElement(QueryClientProvider, { client: query }, React.createElement(Component, props))));
   try {
      await render({ message: 'Safe error.', failure });
      const text = dom.window.document.body.textContent;
      assert.match(text, /Source access denied/);
      assert.match(text, /app\/logs\/id_rsa/);
      assert.match(text, /Entry type: Not reported/);
      assert.match(text, /ENOENT/);
      assert.match(text, /path withheld for safety/);
      assert.equal(dom.window.document.querySelectorAll('img').length, 0);
      assert.equal((globalThis as any).__diagnosticReads, 0);
      await act(async () => dom.window.document.querySelector('button')!.click());
      assert.match(copied, /app\/logs\/id_rsa/);
      assert.ok(!copied.includes('<img'));
      await render({ message: 'Generic message (restic-backup/source-entry-inaccessible).' });
      assert.match(dom.window.document.body.textContent, /Agent 0.7.0 and older/);
      assert.ok(!dom.window.document.body.textContent.includes('app/logs/id_rsa'));
      (globalThis as any).__savedDiagnostics = { sourceFailure: failure };
      await render({ message: 'Safe error.', backup: { id: 'backup-01', planId: 'plan-01', sourceId: 'app-01', sourceType: 'device' } });
      await act(async () => {
         await new Promise((resolve) => setTimeout(resolve, 25));
      });
      assert.match(dom.window.document.body.textContent, /app\/logs\/id_rsa/);
      assert.equal((globalThis as any).__diagnosticReads, 1);
   } finally {
      await act(async () => root.unmount());
      query.clear();
      dom.window.close();
      for (const [key, descriptor] of previous) {
         if (descriptor) Object.defineProperty(globalThis, key, descriptor);
         else delete (globalThis as any)[key];
      }
   }
});

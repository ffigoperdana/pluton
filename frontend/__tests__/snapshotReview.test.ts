import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { snapshotRequest, snapshotChangeLabel, comparisonFailureMessage } from '../src/utils/snapshotReview.ts';
const require = createRequire(new URL('../package.json', import.meta.url)),
   backendRequire = createRequire(new URL('../../backend/package.json', import.meta.url));
const React = require('react'),
   { act } = React,
   { JSDOM } = require('jsdom'),
   { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const output = await backendRequire('esbuild').build({
   stdin: {
      contents:
         'export {default as Details} from "./components/Plan/Backups/SnapshotDetails";export {default as Row} from "./components/Plan/SnapshotViewer/SnapshotViewerFile";export {default as Modal} from "./components/common/Modal/Modal";',
      resolveDir: fileURLToPath(new URL('../src', import.meta.url)),
      loader: 'tsx',
   },
   bundle: true,
   platform: 'node',
   format: 'cjs',
   jsx: 'automatic',
   write: false,
   external: ['react', 'react/jsx-runtime', 'react-dom', '@tanstack/react-query', 'react-router'],
   plugins: [
      {
         name: 'disposable-ui',
         setup(build: any) {
            build.onLoad({ filter: /[\\/]utils[\\/]helpers\.ts$/ }, () => ({
               contents: 'export const formatBytes=n=>n+" Bytes", formatDateTime=String, timeAgo=()=>"recorded";',
               loader: 'js',
            }));
            build.onLoad({ filter: /\.scss$/ }, () => ({ contents: 'export default new Proxy({}, {get:(_,key)=>String(key)});', loader: 'js' }));
            build.onLoad({ filter: /[\\/]utils[\\/]constants\.ts$/ }, () => ({
               contents: 'export const API_URL="https://example.internal/api";',
               loader: 'js',
            }));
            build.onLoad({ filter: /[\\/](?:Icon|FileIcon)\.tsx$/ }, () => ({ contents: 'export default ()=>null;', loader: 'js' }));
         },
      },
   ],
});
const module = { exports: {} as any };
new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, module, module.exports);
const { Details, Row, Modal } = module.exports;
async function mount(element: any, fetcher: typeof fetch = async () => Response.json({ success: true, result: { state: 'unavailable' } })) {
   const dom = new JSDOM('<button id="trigger">Open</button><div id="root"></div>', { url: 'https://example.internal/' }),
      keys = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'];
   const old = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
   for (const key of keys)
      Object.defineProperty(globalThis, key, {
         configurable: true,
         writable: true,
         value: key === 'fetch' ? fetcher : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : (dom.window as any)[key],
      });
   const trigger = dom.window.document.getElementById('trigger')!;
   trigger.focus();
   const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      root = require('react-dom/client').createRoot(dom.window.document.getElementById('root'));
   await act(async () => root.render(React.createElement(QueryClientProvider, { client }, element)));
   const until = async (check: () => unknown) => {
      const deadline = Date.now() + 3000;
      do {
         await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
         });
         if (check()) return;
      } while (Date.now() < deadline);
      assert.fail('Expected UI state did not settle.');
   };
   return {
      dom,
      client,
      until,
      click: async (text: string) => {
         const button = [...dom.window.document.querySelectorAll('button')].find((b) => b.textContent === text)!;
         assert(button);
         await act(async () => button.click());
      },
      close: async () => {
         await act(async () => root.unmount());
         assert.equal(dom.window.document.body.style.overflow, '');
         client.clear();
         dom.window.close();
         for (const [key, value] of old)
            if (value) Object.defineProperty(globalThis, key, value);
            else delete (globalThis as any)[key];
      },
   };
}
test('centered explorer and details dialogs lock page scroll, trap focus and close only the top dialog', async () => {
   let outer = 0,
      inner = 0;
   const ui = await mount(
      React.createElement(
         Modal,
         { title: 'Explorer', layout: 'explorer', stableLayout: true, closeModal: () => outer++ },
         React.createElement('button', {}, 'Outer'),
         React.createElement(
            Modal,
            { title: 'Details', layout: 'details', stableLayout: true, closeModal: () => inner++ },
            React.createElement('button', {}, 'Inner'),
         ),
      ),
   );
   try {
      const dialogs = ui.dom.window.document.querySelectorAll('[role="dialog"]');
      assert.equal(dialogs.length, 2);
      assert.equal(ui.dom.window.document.body.style.overflow, 'hidden');
      assert.match(dialogs[0].parentElement!.className, /details|explorer/);
      await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      assert.equal(inner, 1);
      assert.equal(outer, 0);
      const panel = [...dialogs].find((d) => d.textContent?.includes('Inner')) as HTMLElement;
      panel.focus();
      await act(async () => panel.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
      assert.notEqual(ui.dom.window.document.activeElement, ui.dom.window.document.body);
   } finally {
      await ui.close();
   }
});
const details = {
   backupId: 'backup-01',
   planId: 'plan-01',
   planName: 'Example plan',
   status: 'completed',
   snapshotId: 'a'.repeat(64),
   started: '2026-01-01T00:00:00Z',
   completed: '2026-01-01T00:01:00Z',
   durationSeconds: 60,
   timeZone: 'Asia/Jakarta',
   storage: { id: 'storage-01', name: 'Example SFTP', type: 'sftp' },
   source: { id: 'app-01', type: 'device' },
   statistics: { totalFiles: 3, logicalBytes: 14, newFiles: null, packedRepositoryBytes: 0 },
   databases: [],
   recovery: null,
   replication: [],
   warnings: [],
   comparisonAvailable: true,
};
test('Snapshot Details keeps absent values explicit, displays exact identities, and browses deleted changes as historical', async () => {
   const calls: string[] = [];
   let browsed: any;
   const ui = await mount(
      React.createElement(Details, {
         backupId: 'backup-01',
         close: () => {},
         onBrowse: (backup: any, filter: string) => {
            browsed = { backup, filter };
         },
      }),
      async (input: any, options: any) => {
         assert.equal(options.credentials, 'include');
         const url = new URL(input);
         calls.push(url.href);
         return Response.json({
            success: true,
            result: url.pathname.endsWith('/details')
               ? details
               : url.searchParams.get('view') === 'files'
                 ? { files: [{ path: '/srv/deleted.txt', change: 'deleted', backupId: 'backup-old' }], total: 1, nextOffset: null }
                 : {
                      state: 'ready',
                      currentSnapshotId: 'a'.repeat(64),
                      previousSnapshotId: 'b'.repeat(64),
                      previousBackupId: 'backup-old',
                      summary: { added: 1, modified: 1, unchanged: 1, deleted: 1, addedLogicalBytes: 7, removedLogicalBytes: 7 },
                   },
         });
      },
   );
   try {
      await ui.until(() => ui.dom.window.document.body.textContent?.includes('Detailed changes'));
      const text = ui.dom.window.document.body.textContent!;
      assert.match(text, /Not recorded/);
      assert(text.includes('a'.repeat(64)));
      assert(text.includes('b'.repeat(64)));
      assert(text.includes('Asia/Jakarta'));
      assert(text.includes('0 Bytes') || text.includes('0 B'));
      await ui.click('deleted');
      await ui.until(() => calls.some((url) => url.includes('change=deleted')));
      await ui.until(() => ui.dom.window.document.body.textContent?.includes('Previous snapshot only'));
      await ui.click('Browse Changed Files');
      assert.equal(browsed.filter, 'deleted');
      assert.equal(browsed.backup.id, 'backup-01');
   } finally {
      await ui.close();
   }
});
test('Deleted rows expose no current-snapshot restore, directory navigation or injected file actions', async () => {
   let actions = 0;
   const ui = await mount(
      React.createElement(Row, {
         file: { path: '/srv/deleted', name: 'deleted', type: 'dir', isDirectory: true, modifiedAt: '2026-01-01T00:00:00Z' },
         style: {},
         gridColumns: '1fr',
         changeStatus: 'deleted',
         historical: true,
         onGoUp: () => actions++,
         onDirectoryClick: () => actions++,
         onRestore: () => actions++,
         renderFileActions: () => React.createElement('button', { onClick: () => actions++ }, 'Unsafe action'),
      }),
   );
   try {
      assert.match(ui.dom.window.document.body.textContent!, /Deleted/);
      assert.equal(ui.dom.window.document.querySelectorAll('#root button').length, 0);
      await act(async () =>
         ui.dom.window.document.querySelector('#root>div')!.dispatchEvent(new ui.dom.window.MouseEvent('click', { bubbles: true })),
      );
      assert.equal(actions, 0);
   } finally {
      await ui.close();
   }
});
test('review transport suppresses provider errors and unknown classifications remain Not compared', async () => {
   const original = globalThis.fetch;
   try {
      globalThis.fetch = async () => Response.json({ success: false, error: 'captured private provider output' }, { status: 500 });
      await assert.rejects(
         snapshotRequest('https://example.internal/api', 'backup-01', 'comparison'),
         (error) => error instanceof Error && !error.message.includes('captured private provider output'),
      );
      assert.equal(snapshotChangeLabel('unknown'), 'Not compared');
   } finally {
      globalThis.fetch = original;
   }
});

test('comparison failure notes separate resource, deadline and evidence errors without raw strings', () => {
   for (const [failureCategory, pattern] of [
      ['timeout', /deadline/],
      ['resource-limit', /capacity/],
      ['metadata-invalid', /inconsistent/],
      ['repository-unavailable', /Repository access/],
   ] as const)
      assert.match(comparisonFailureMessage({ state: 'failed', failureCategory, failureCode: 'comparing-422' }), pattern);
   const value = comparisonFailureMessage({ state: 'failed', failureCategory: 'captured-provider-secret', failureCode: 'captured-provider-secret' });
   assert(!value.includes('captured-provider-secret'));
   assert.equal(comparisonFailureMessage({ state: 'ready' }), '');
});

test('specific compare diagnostics keep missing distinct and never reflect unknown codes or provider text', async () => {
   const original = globalThis.fetch;
   try {
      for (const [failureDetail, pattern] of [
         ['snapshot-root-path-incompatible', /root paths/],
         ['historical-source-scope-mismatch', /source scopes/],
         ['historical-metadata-incomplete', /incomplete/],
         ['snapshot-ownership-mismatch', /ownership tags/],
         ['previous-snapshot-unavailable', /previous snapshot/],
         ['restic-diff-unavailable', /adapter/],
         ['comparison-context-changed', /evidence changed/],
      ] as const) {
         assert.match(comparisonFailureMessage({ state: 'failed', failureDetail }), pattern);
         globalThis.fetch = async () => Response.json({ success: false, error: 'private-provider-body', failureDetail }, { status: 409 });
         await assert.rejects(snapshotRequest('https://example.internal/api', 'backup-01', 'comparison'), pattern);
      }
      for (const state of ['missing', 'preparing', 'ready'] as const)
         assert.equal(comparisonFailureMessage({ state, failureDetail: 'snapshot-root-path-incompatible' }), '');
      for (const failureDetail of ['private-provider-body', '__proto__', 'constructor'])
         assert(!comparisonFailureMessage({ state: 'failed', failureDetail }).includes(failureDetail));
   } finally {
      globalThis.fetch = original;
   }
});
test('SQL snapshot Details shows the exact failed pair and explicit retry; GET refresh never admits a replacement job', async () => {
   let posts = 0;
   let state: any = { state: 'missing' };
   const sqlDetails = {
      ...details,
      databases: [
         {
            reference: 'db_01',
            engine: 'mariadb',
            database: 'app',
            path: '/pluton/database/app.sql',
            bytes: 10,
            sha256: 'c'.repeat(64),
            status: 'completed',
         },
      ],
   };
   const ui = await mount(
      React.createElement(Details, { backupId: 'backup-01', close: () => {}, onBrowse: () => {} }),
      async (input: any, options: any) => {
         const url = new URL(input);
         if (options.method === 'POST') {
            posts++;
            state = {
               state: 'failed',
               failureCode: 'preparing-409',
               failureCategory: 'snapshot-root-incompatible',
               failureDetail: 'snapshot-root-path-incompatible',
               currentSnapshotId: 'a'.repeat(64),
               previousSnapshotId: 'b'.repeat(64),
               previousBackupId: 'backup-old',
               processedEntries: 0,
            };
         }
         return Response.json({ success: true, result: url.pathname.endsWith('/details') ? sqlDetails : state });
      },
   );
   try {
      await ui.until(() => ui.dom.window.document.body.textContent?.includes('Compare with previous'));
      assert.equal(posts, 0);
      assert.match(ui.dom.window.document.body.textContent!, /app\.sql/);
      await ui.click('Compare with previous');
      await ui.until(() => ui.dom.window.document.body.textContent?.includes('root paths cannot be proven'));
      assert.equal(posts, 1);
      assert(ui.dom.window.document.body.textContent?.includes('b'.repeat(64)));
      assert(ui.dom.window.document.body.textContent?.includes('Retry comparison'));
      await act(async () => ui.client.refetchQueries());
      assert.equal(posts, 1);
      assert.equal((ui.client.getQueryData(['snapshot-comparison', 'backup-01']) as any).state, 'failed');
      assert(!ui.dom.window.document.body.textContent?.includes('Detailed changes'));
   } finally {
      await ui.close();
   }
});

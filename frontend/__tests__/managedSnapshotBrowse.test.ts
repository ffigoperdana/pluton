import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fetchManagedSnapshotPage, managedSnapshotPageUrl, snapshotParent } from '../src/utils/managedSnapshotBrowse.ts';

const query = { path: '/srv/example-app', search: 'report & data', offset: 200, limit: 200, sort: 'name' as const, order: 'asc' as const };
test('snapshot page URL binds exact historical backup, encoded directory/search and bounded page size', () => {
   const url = new URL(managedSnapshotPageUrl('https://example.internal/api', 'backup-01', query));
   assert.equal(url.pathname, '/api/backups/backup-01/files/page');
   assert.equal(url.searchParams.get('path'), query.path);
   assert.equal(url.searchParams.get('search'), query.search);
   assert.equal(url.searchParams.get('offset'), '200');
   assert.equal(url.searchParams.get('limit'), '200');
   assert.equal(snapshotParent('/srv/example-app'), '/srv');
   assert.equal(snapshotParent('/srv'), '');
});
test('page fetch sends authentication and cancellation; indexing and sanitized refusals survive', async () => {
   const previous = globalThis.fetch,
      controller = new AbortController();
   try {
      globalThis.fetch = async (_url, options) => {
         assert.equal(options?.credentials, 'include');
         assert.equal(options?.signal, controller.signal);
         return Response.json({ success: true, result: { status: 'indexing', retryAfterMs: 1000 } }, { status: 202 });
      };
      assert.deepEqual(await fetchManagedSnapshotPage('https://example.internal/api', 'backup-01', query, controller.signal), {
         status: 'indexing',
         retryAfterMs: 1000,
      });
      globalThis.fetch = async () => Response.json({ success: false, error: 'Snapshot index resource limit reached.' }, { status: 429 });
      await assert.rejects(fetchManagedSnapshotPage('https://example.internal/api', 'backup-01', query), /resource limit/);
   } finally {
      globalThis.fetch = previous;
   }
});

const require = createRequire(new URL('../package.json', import.meta.url));
const backendRequire = createRequire(new URL('../../backend/package.json', import.meta.url));
const React = require('react'),
   { act } = React,
   { JSDOM } = require('jsdom');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const output = await backendRequire('esbuild').build({
   entryPoints: [fileURLToPath(new URL('../src/components/Plan/SnapshotViewer/ManagedSnapshotViewer.tsx', import.meta.url))],
   bundle: true,
   platform: 'node',
   format: 'cjs',
   jsx: 'automatic',
   write: false,
   external: ['react', 'react/jsx-runtime', 'react-dom', '@tanstack/react-query', 'react-router'],
   plugins: [
      {
         name: 'snapshot-view-fixtures',
         setup(builder: any) {
            const stub = (filter: RegExp, contents: string) => builder.onLoad({ filter }, () => ({ contents, loader: 'js' }));
            stub(/\.scss$/, 'export default {};');
            stub(/[\\/]Icon\.tsx$/, 'export default ()=>null;');
            stub(/[\\/]utils[\\/]constants\.ts$/, 'export const API_URL="https://example.internal/api";');
            stub(/[\\/]utils[\\/]helpers\.ts$/, 'export const formatBytes=String;export const isMobile=()=>false;');
            stub(
               /[\\/]services[\\/]restores\.ts$/,
               'export const useRestoreBackup=()=>({isPending:false,mutate:payload=>globalThis.__snapshotRestores.push(payload)});',
            );
            stub(
               /[\\/]ActionModal\.tsx$/,
               'import React from "react";export default p=>React.createElement("button",{onClick:p.primaryAction.action},p.primaryAction.title);',
            );
            stub(
               /[\\/]SnapshotBrowserFileList\.tsx$/,
               'import React from "react";export default p=>React.createElement("section",{},p.headerContent,...p.files.map((_,index)=>React.createElement("div",{key:index},p.renderRow({index,style:{}}))));',
            );
            stub(
               /[\\/]SnapshotViewerFile\.tsx$/,
               'import React from "react";export default p=>React.createElement("button",{onClick:()=>p.file.isGoUp?p.onGoUp():p.file.isDirectory?p.onDirectoryClick(p.file.path):p.onRestore(p.file)},p.file.name);',
            );
         },
      },
   ],
});
const module = { exports: {} as any };
new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, module, module.exports);
const Viewer = module.exports.default;
async function mount(fetcher: typeof fetch, selectionMode = false) {
   const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.internal/' });
   const globals = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', '__snapshotRestores'];
   const previous = globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
   const restores: any[] = [];
   for (const key of globals)
      Object.defineProperty(globalThis, key, {
         configurable: true,
         writable: true,
         value:
            key === 'fetch'
               ? fetcher
               : key === 'IS_REACT_ACT_ENVIRONMENT'
                 ? true
                 : key === '__snapshotRestores'
                   ? restores
                   : (dom.window as any)[key],
      });
   const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
   let selectedPaths: { includes: string[]; excludes: string[] } | undefined;
   function Host() {
      const [selection, setSelection] = React.useState({ includes: [] as string[], excludes: [] as string[] });
      selectedPaths = selection;
      return React.createElement(Viewer, {
         backup: { id: 'backup-historical-01', totalSize: 123 },
         planId: 'plan-01',
         files: [],
         onClose: () => {},
         selection: selectionMode
            ? { ...selection, onChange: (includes: string[], excludes: string[]) => setSelection({ includes, excludes }) }
            : undefined,
      });
   }
   const root = require('react-dom/client').createRoot(dom.window.document.getElementById('root'));
   await act(async () => {
      root.render(
         React.createElement(
            QueryClientProvider,
            { client },
            React.createElement(require('react-router').MemoryRouter, {}, React.createElement(Host)),
         ),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
   });
   const settle = async () =>
      act(async () => {
         await new Promise((resolve) => setTimeout(resolve, 30));
      });
   const click = async (text: string) => {
      const button = [...dom.window.document.querySelectorAll('button')].find((item: any) => item.textContent === text) as any;
      assert(button, `Missing button ${text}`);
      await act(async () => {
         button.click();
      });
      await settle();
   };
   await settle();
   return {
      dom,
      client,
      restores,
      click,
      settle,
      selection: () => selectedPaths,
      async close() {
         await act(async () => root.unmount());
         client.clear();
         dom.window.close();
         for (const [key, descriptor] of previous)
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
      },
   };
}
test('managed viewer navigates pages and directories without whole-tree metadata or IndexedDB', async () => {
   const requests: URL[] = [];
   const ui = await mount(async (input: any) => {
      const url = new URL(input);
      requests.push(url);
      const directory = url.searchParams.get('path');
      const offset = Number(url.searchParams.get('offset'));
      const files = directory
         ? [{ name: 'report.txt', path: '/srv/report.txt', isDirectory: false, type: 'file', size: 7, modifiedAt: '2026-01-01' }]
         : [
              {
                 name: offset ? 'next-directory' : 'srv',
                 path: offset ? '/next-directory' : '/srv',
                 isDirectory: true,
                 type: 'dir',
                 size: 0,
                 modifiedAt: '2026-01-01',
              },
           ];
      return Response.json({
         success: true,
         result: {
            status: 'ready',
            files,
            entries: 100000,
            total: directory ? 1 : 300,
            offset,
            limit: 200,
            nextOffset: directory || offset ? null : 200,
            snapshotId: 'a'.repeat(64),
         },
      });
   });
   try {
      assert.match(ui.dom.window.document.body.textContent!, /100,000 snapshot entries/);
      await ui.click('Next');
      assert.equal(requests.at(-1)!.searchParams.get('offset'), '200');
      await ui.click('Previous');
      await ui.click('srv');
      assert.equal(requests.at(-1)!.searchParams.get('path'), '/srv');
      await ui.click('report.txt');
      await ui.click('Restore to staging');
      assert.deepEqual(ui.restores[0], {
         backupId: 'backup-historical-01',
         planId: 'plan-01',
         target: '',
         includes: ['/srv/report.txt'],
         overwrite: 'never',
         deleteOption: false,
      });
      assert(ui.client.getQueryCache().getAll().length <= 1);
      assert(requests.every((url) => url.pathname === '/api/backups/backup-historical-01/files/page'));
   } finally {
      await ui.close();
   }
});
test('managed viewer displays indexing and retryable errors without partial rows', async () => {
   let fail = false;
   let requests = 0;
   const ui = await mount(async () => {
      requests++;
      return fail
         ? Response.json({ success: false, error: 'Snapshot metadata is unavailable. Retry indexing.' }, { status: 503 })
         : Response.json({ success: true, result: { status: 'indexing', retryAfterMs: 1000 } }, { status: 202 });
   });
   try {
      assert.match(ui.dom.window.document.body.textContent!, /Indexing snapshot metadata/);
      fail = true;
      await act(async () => {
         await ui.client.refetchQueries();
      });
      await ui.settle();
      assert.match(ui.dom.window.document.body.textContent!, /Retry indexing/);
      const afterFailure = requests;
      await act(async () => {
         await new Promise((resolve) => setTimeout(resolve, 1200));
      });
      assert.equal(requests, afterFailure, 'A failed build waits for explicit retry instead of polling/rebuilding indefinitely.');
      fail = false;
      await ui.click('Retry indexing');
      assert.match(ui.dom.window.document.body.textContent!, /Indexing snapshot metadata/);
   } finally {
      await ui.close();
   }
});

test('wizard selection retains exact paths across pages and can return to complete snapshot selection', async () => {
   const ui = await mount(async (input: any) => {
      const offset = Number(new URL(input).searchParams.get('offset'));
      const name = offset ? 'second.txt' : 'first.txt';
      return Response.json({
         success: true,
         result: {
            status: 'ready',
            files: [{ name, path: `/${name}`, isDirectory: false, type: 'file', size: 1, modifiedAt: '2026-01-01' }],
            entries: 100000,
            total: 300,
            offset,
            limit: 200,
            nextOffset: offset ? null : 200,
            snapshotId: 'a'.repeat(64),
         },
      });
   }, true);
   try {
      await ui.click('first.txt');
      await ui.click('Next');
      await ui.click('second.txt');
      assert.deepEqual(ui.selection()?.includes, ['/first.txt', '/second.txt']);
      assert.equal(ui.restores.length, 0);
      await ui.click('Recover entire snapshot');
      assert.deepEqual(ui.selection(), { includes: [], excludes: [] });
      assert(ui.client.getQueryCache().getAll().length <= 1);
   } finally {
      await ui.close();
   }
});

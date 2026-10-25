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
            stub(/[\\/]utils[\\/]helpers\.ts$/, 'export const formatBytes=String;export const isMobile=()=>!!globalThis.__snapshotMobile;');
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
async function mount(fetcher: typeof fetch, selectionMode = false, mobile = false) {
   const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.internal/' });
   const globals = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', '__snapshotRestores', '__snapshotMobile'];
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
                   : key === '__snapshotMobile'
                     ? mobile
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
   const diagnostics = () => ({
      queries: client
         .getQueryCache()
         .getAll()
         .map((query: any) => ({ key: query.queryKey, fetching: query.state.fetchStatus, status: query.state.status })),
      rows: [...dom.window.document.querySelectorAll('section button')]
         .map((button) => button.textContent)
         .filter((name) => name?.startsWith('dir-'))
         .filter((_, index, rows) => index === 0 || index === rows.length - 1),
      pagination: [...dom.window.document.querySelectorAll('[aria-label="Snapshot pages"] button')].map((button: any) => ({
         name: button.textContent,
         disabled: button.disabled,
      })),
      selected: dom.window.document.querySelector('[role="treeitem"][aria-selected="true"]')?.textContent,
   });
   const waitFor = async (condition: () => unknown, label: string) => {
      const deadline = Date.now() + 2000;
      do {
         // Yield for React Query's scheduled notifications and flush React work;
         // readiness is determined by the predicate, never by elapsed sleep time.
         await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
         });
         if (condition()) return;
      } while (Date.now() < deadline);
      assert.fail(`Timed out waiting for ${label}: ${JSON.stringify(diagnostics())}`);
   };
   const settle = () => waitFor(() => client.isFetching() === 0, 'the current query to finish');
   const findButton = (text: string) =>
      [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === text) as HTMLButtonElement | undefined;
   await act(async () => {
      root.render(
         React.createElement(
            QueryClientProvider,
            { client },
            React.createElement(require('react-router').MemoryRouter, {}, React.createElement(Host)),
         ),
      );
   });
   const click = async (text: string) => {
      await waitFor(() => {
         const button = findButton(text);
         return button && !button.disabled;
      }, `enabled button ${text}`);
      await act(async () => {
         findButton(text)!.click();
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
      waitFor,
      findButton,
      diagnostics,
      async waitForPage(path: string, offset: number, row: string) {
         await waitFor(
            () => {
               const query: any = client
                  .getQueryCache()
                  .getAll()
                  .find((query: any) => query.queryKey[2] === path && query.queryKey[4] === offset);
               return query?.state.fetchStatus === 'idle' && query?.state.data?.status === 'ready' && !!findButton(row);
            },
            `page ${path || '/'} offset=${offset} with row ${row}`,
         );
      },
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

test('classic sidebar loads only expanded directory pages, pages 601 siblings, and handles an empty folder', async () => {
   const requests: URL[] = [];
   const ui = await mount(async (input: any) => {
      const url = new URL(input);
      requests.push(url);
      const parent = url.searchParams.get('path') || '',
         offset = Number(url.searchParams.get('offset'));
      const folders = url.searchParams.get('directoriesOnly') === 'true';
      const total = parent === '/srv' ? 601 : parent ? 0 : 1;
      const files =
         parent === '/srv'
            ? Array.from({ length: Math.min(200, total - offset) }, (_, i) => ({
                 name: `dir-${String(offset + i).padStart(4, '0')}`,
                 path: `/srv/dir-${String(offset + i).padStart(4, '0')}`,
                 type: 'dir',
                 isDirectory: true,
                 size: 0,
                 modifiedAt: '2026-01-01',
              }))
            : parent
              ? []
              : [{ name: 'srv', path: '/srv', type: 'dir', isDirectory: true, size: 0, modifiedAt: '2026-01-01' }];
      if (folders) assert.equal(url.searchParams.get('search'), '');
      return Response.json({
         success: true,
         result: {
            status: 'ready',
            files,
            total,
            offset,
            limit: 200,
            nextOffset: offset + files.length < total ? offset + files.length : null,
            entries: 100000,
            snapshotId: 'a'.repeat(64),
         },
      });
   });
   const byLabel = async (label: string) => {
      const button = ui.dom.window.document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
      assert(button, `Missing ${label}`);
      await act(async () => button.click());
      await ui.settle();
   };
   try {
      assert.match(ui.dom.window.document.body.textContent!, /Directories/);
      assert.equal(requests.filter((url) => url.searchParams.get('path') === '/srv').length, 0);
      await byLabel('Expand srv');
      assert.equal(ui.dom.window.document.querySelectorAll('[role="treeitem"]').length, 201);
      assert.equal(requests.filter((url) => url.searchParams.get('path') === '/srv').length, 1);
      await byLabel('Next folders in /srv');
      await byLabel('Next folders in /srv');
      await byLabel('Next folders in /srv');
      assert.match(ui.dom.window.document.body.textContent!, /601–601 of 601/);
      await byLabel('Expand dir-0600');
      assert.match(ui.dom.window.document.body.textContent!, /No subfolders/);
      await byLabel('Collapse srv');
      await byLabel('Expand srv');
      assert.equal(
         requests.filter((url) => url.searchParams.get('path') === '/srv').length,
         4,
         'Collapsing and expanding reuses the completed page.',
      );
      const row = [...ui.dom.window.document.querySelectorAll('[role="treeitem"]')].find((row: any) =>
         row.textContent.includes('dir-0600'),
      ) as HTMLElement;
      await act(async () => row.click());
      await ui.settle();
      assert.equal(ui.dom.window.document.querySelector('[aria-selected="true"]')?.textContent?.includes('dir-0600'), true);
      assert(requests.every((url) => Number(url.searchParams.get('limit')) <= 200));
      assert(ui.dom.window.document.querySelectorAll('[role="treeitem"]').length < 1000);
   } finally {
      await ui.close();
   }
});

test('rapid expand/collapse aborts pending children and does not duplicate requests', async () => {
   let pending = 0,
      aborted = 0;
   const ui = await mount(async (input: any, init: any) => {
      const url = new URL(input);
      if (url.searchParams.get('path') === '/srv') {
         pending++;
         return new Promise<Response>((_resolve, reject) =>
            init.signal.addEventListener(
               'abort',
               () => {
                  aborted++;
                  reject(new Error('cancelled'));
               },
               { once: true },
            ),
         );
      }
      return Response.json({
         success: true,
         result: {
            status: 'ready',
            files: [{ name: 'srv', path: '/srv', type: 'dir', isDirectory: true }],
            total: 1,
            offset: 0,
            limit: 200,
            nextOffset: null,
            entries: 100000,
            snapshotId: 'a'.repeat(64),
         },
      });
   });
   try {
      const expand = () => ui.dom.window.document.querySelector('button[aria-label="Expand srv"]') as HTMLButtonElement;
      await act(async () => expand().click());
      await ui.settle();
      assert.match(ui.dom.window.document.body.textContent!, /Loading folders/);
      await act(async () => (ui.dom.window.document.querySelector('button[aria-label="Collapse srv"]') as HTMLButtonElement).click());
      await ui.settle();
      assert.equal(aborted, 1);
      await act(async () => expand().click());
      await ui.settle();
      assert.equal(pending, 2);
   } finally {
      await ui.close();
   }
   assert.equal(aborted, 2, 'Unmount cancels the remaining directory request.');
});

test('deep navigation retains ancestor expansion with bounded requests and current-page state', async () => {
   let calls = 0;
   const ui = await mount(async (input: any) => {
      calls++;
      const url = new URL(input), parent = url.searchParams.get('path') || '';
      const depth = parent.split('/').filter(Boolean).length;
      const name = `level-${depth}`, files = depth < 80 ? [{ name, path: `${parent}/${name}`, type: 'dir', isDirectory: true }] : [];
      return Response.json({ success: true, result: { status: 'ready', files, total: files.length, offset: 0, limit: 200, nextOffset: null, entries: 100000, snapshotId: 'a'.repeat(64) } });
   });
   try {
      for (let depth = 0; depth < 80; depth++) await ui.click(`level-${depth}`);
      assert.equal(ui.dom.window.document.querySelectorAll('[role="treeitem"]').length, 80);
      assert.equal(ui.dom.window.document.querySelectorAll('[aria-expanded="true"]').length >= 79, true);
      assert(calls <= 165, 'Each navigation fetches at most one file page and one directory page.');
      assert(ui.client.getQueryCache().getAll().length <= 1);
   } finally { await ui.close(); }
});

// Advance only the application's 300 ms search debounce. Query notifications and
// network gates use their real scheduler; this is not a longer readiness sleep.
function controlSearchDebounce() {
   const originalTimeout = globalThis.setTimeout,
      originalClear = globalThis.clearTimeout;
   const pending = new Map<ReturnType<typeof setTimeout>, () => void>();
   globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
      if (delay !== 300) return originalTimeout(callback, delay, ...args);
      const handle = originalTimeout(() => {}, 2 ** 31 - 1);
      handle.unref();
      pending.set(handle, () => callback(...args));
      return handle;
   }) as typeof setTimeout;
   globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
      pending.delete(handle);
      originalClear(handle);
   }) as typeof clearTimeout;
   return {
      pending: () => pending.size,
      async flush() {
         await act(async () => {
            for (const [handle, callback] of [...pending]) {
               if (!pending.delete(handle)) continue;
               originalClear(handle);
               callback();
            }
         });
      },
      restore() {
         for (const handle of pending.keys()) originalClear(handle);
         globalThis.setTimeout = originalTimeout;
         globalThis.clearTimeout = originalClear;
      },
   };
}

for (const mobile of [false, true])
   test(`selection stays highlighted when a table folder belongs to a different sidebar page${mobile ? ' on mobile' : ''}`, async () => {
      const clock = controlSearchDebounce();
      const requests: { path: string; offset: number; folders: boolean; limit: number }[] = [];
      const network = new Map<number, () => void>();
      let active = 0,
         peakActive = 0;
      const ui = await mount(
         async (input: any, init: any) => {
            const url = new URL(input),
               parent = url.searchParams.get('path') || '',
               offset = Number(url.searchParams.get('offset'));
            const folders = url.searchParams.get('directoriesOnly') === 'true';
            requests.push({ path: parent, offset, folders, limit: Number(url.searchParams.get('limit')) });
            active++;
            peakActive = Math.max(peakActive, active);
            try {
               if (parent === '/srv' && !folders && offset > 0)
                  await new Promise<void>((resolve, reject) => {
                     const abort = () => {
                        network.delete(offset);
                        reject(new Error('cancelled fixture request'));
                     };
                     network.set(offset, () => {
                        init.signal.removeEventListener('abort', abort);
                        network.delete(offset);
                        resolve();
                     });
                     init.signal.addEventListener('abort', abort, { once: true });
                  });
               const files =
                  parent === '/srv'
                     ? Array.from({ length: 200 }, (_, i) => {
                          const name = `dir-${offset + i}`;
                          return { name, path: `/srv/${name}`, type: 'dir', isDirectory: true };
                       })
                     : parent
                       ? []
                       : [{ name: 'srv', path: '/srv', type: 'dir', isDirectory: true }];
               return Response.json({
                  success: true,
                  result: {
                     status: 'ready',
                     files,
                     total: parent === '/srv' ? 600 : files.length,
                     offset,
                     limit: 200,
                     nextOffset: parent === '/srv' && offset < 400 ? offset + 200 : null,
                     entries: 100000,
                     snapshotId: 'a'.repeat(64),
                  },
               });
            } finally {
               active--;
            }
         },
         false,
         mobile,
      );
      const offsets = () => requests.filter((request) => request.path === '/srv' && !request.folders).map((request) => request.offset);
      const requestPage = async (offset: number) => {
         const next = ui.findButton('Next');
         assert(next && !next.disabled, JSON.stringify(ui.diagnostics()));
         await act(async () => {
            next.click();
            next.click();
            next.click();
         });
         await ui.waitFor(() => network.has(offset), `API request offset=${offset}`);
         assert.equal(ui.client.isFetching(), 1);
         assert.match(ui.dom.window.document.body.textContent!, /Loading snapshot metadata/);
         assert(!ui.findButton('dir-555'), 'A pending response must not expose a row from the next page.');
         assert.equal(offsets().at(-1), offset);
      };
      try {
         await ui.waitForPage('', 0, 'srv');
         await ui.click('srv');
         await ui.waitForPage('/srv', 0, 'dir-0');
         await requestPage(200);
         assert.deepEqual(offsets(), [0, 200], 'Rapid clicks must not skip or duplicate requests.');
         await act(async () => network.get(200)!());
         await ui.waitForPage('/srv', 200, 'dir-200');
         assert(ui.findButton('dir-399'));
         // Previously, the mount-time no-op debounce reset this settled page to zero.
         await clock.flush();
         await ui.waitForPage('/srv', 200, 'dir-200');
         assert.deepEqual(offsets(), [0, 200], JSON.stringify(ui.diagnostics()));
         await requestPage(400);
         if (mobile) {
            await act(async () => ui.findButton('Folders')!.click());
            assert.equal(ui.findButton('Folders')!.getAttribute('aria-expanded'), 'true');
            await act(async () => ui.findButton('Folders')!.click());
         }
         await act(async () => network.get(400)!());
         await ui.waitForPage('/srv', 400, 'dir-555');
         assert(ui.findButton('dir-400'));
         assert(ui.findButton('dir-599'));
         assert.equal(ui.findButton('Next')!.disabled, true);
         assert.deepEqual(offsets(), [0, 200, 400]);
         await ui.click('dir-555');
         await ui.waitFor(
            () => ui.dom.window.document.querySelector('[role="treeitem"][aria-selected="true"]')?.textContent?.includes('dir-555'),
            'selected sidebar folder dir-555',
         );
         assert(
            ui.client
               .getQueryCache()
               .getAll()
               .some((query: any) => query.queryKey[2] === '/srv/dir-555' && query.queryKey[4] === 0),
         );
         assert.equal(requests.filter((request) => request.folders && request.path === '/srv').length, 1);
         assert(requests.every((request) => request.limit === 200));
         assert(peakActive <= 8, 'The existing tree request limit remains enforced.');
         assert(ui.client.getQueryCache().getAll().length <= 1);
         assert(ui.dom.window.document.querySelectorAll('[role="treeitem"]').length < 210);
      } finally {
         await ui.close();
         clock.restore();
      }
   });

test('only an actual debounced search change resets a later page', async () => {
   const clock = controlSearchDebounce();
   const requests: URL[] = [];
   const ui = await mount(async (input: any) => {
      const url = new URL(input);
      requests.push(url);
      const offset = Number(url.searchParams.get('offset')),
         search = url.searchParams.get('search');
      const name = search ? 'search-result.txt' : offset ? 'second.txt' : 'first.txt';
      return Response.json({
         success: true,
         result: {
            status: 'ready',
            files: [{ name, path: `/${name}`, type: 'file', isDirectory: false }],
            total: 400,
            offset,
            limit: 200,
            nextOffset: offset ? null : 200,
            entries: 100000,
            snapshotId: 'a'.repeat(64),
         },
      });
   });
   try {
      await ui.waitForPage('', 0, 'first.txt');
      assert.equal(clock.pending(), 0, 'An unchanged initial filter must not schedule a reset.');
      await ui.click('Next');
      await ui.waitForPage('', 200, 'second.txt');
      const input = ui.dom.window.document.querySelector('input')!;
      await act(async () => require('react-dom/test-utils').Simulate.change(input, { target: { value: 'report' } }));
      assert.equal(clock.pending(), 1);
      assert(ui.findButton('second.txt'), 'The old filter stays active until the debounce fires.');
      await clock.flush();
      await ui.waitForPage('', 0, 'search-result.txt');
      const fileRequests = requests.filter((url) => url.searchParams.get('directoriesOnly') !== 'true');
      assert.equal(fileRequests.at(-1)!.searchParams.get('search'), 'report');
      assert.equal(fileRequests.at(-1)!.searchParams.get('offset'), '0');
   } finally {
      await ui.close();
      clock.restore();
   }
});

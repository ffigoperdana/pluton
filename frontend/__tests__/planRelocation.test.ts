import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
   currentRelocation,
   formatRelocationBytes,
   relocationFailureText,
   relocationPolling,
   relocationProgressText,
   relocationShowsForm,
} from '../src/utils/planRelocation.ts';
import type { PlanRelocation, PlanRelocationOverview } from '../src/@types/planRelocations.ts';

const require = createRequire(new URL('../package.json', import.meta.url)),
   backendRequire = createRequire(new URL('../../backend/package.json', import.meta.url));
const React = require('react'),
   { act } = React,
   { JSDOM } = require('jsdom'),
   { QueryClient, QueryClientProvider } = require('@tanstack/react-query');

const relocation = (patch: Partial<PlanRelocation> = {}): PlanRelocation => ({
   id: 'a'.repeat(24),
   planId: 'plan-01',
   repositoryId: 'repo-01',
   source: { storageId: 'storage-01', storageName: 'SFTP A', storagePath: 'managed/app-01' },
   destination: { storageId: 'storage-02', storageName: 'SFTP B', storagePath: 'managed/app-01' },
   status: 'ready',
   phase: 'ready',
   planWasActive: true,
   createdAt: 1,
   updatedAt: 2,
   evidence: {
      repositoryConfigId: 'c'.repeat(64),
      fileCount: 120,
      totalBytes: 5 * 1024 ** 3,
      listingDigest: 'd'.repeat(64),
      snapshotCount: 14,
   },
   actions: { cancel: true, switch: true, revert: false, deleteSource: false },
   audit: [{ at: 1, event: 'requested' }],
   ...patch,
});
const overview = (relocations: PlanRelocation[], canStart = false): PlanRelocationOverview => ({
   supported: true,
   canStart,
   current: { storageId: 'storage-01', storagePath: 'managed/app-01' },
   relocations,
});

test('follows the active relocation, polls only while the server works and shows real counters', () => {
   const done = relocation({ id: 'b'.repeat(24), status: 'failed', actions: { cancel: false, switch: false, revert: false, deleteSource: false } });
   const active = relocation({ status: 'copying', phase: 'copying' });
   assert.equal(currentRelocation(overview([done, active]))?.status, 'copying');
   assert.equal(relocationPolling(overview([active])), 3000);
   assert.equal(relocationPolling(overview([relocation()])), false);
   assert.equal(relocationPolling(overview([relocation({ status: 'switched', operation: 'deleting-source' })])), 3000);
   assert.equal(relocationShowsForm(overview([], true)), true);
   assert.equal(relocationShowsForm(overview([done], true)), true);
   assert.equal(relocationShowsForm(overview([relocation()], false)), false);
   assert.equal(
      relocationProgressText(
         relocation({
            status: 'copying',
            phase: 'copying',
            progress: { copiedBytes: 1024 ** 3, copyTotalBytes: 2 * 1024 ** 3, copiedFiles: 3, copyTotalFiles: 9 },
         }),
      ),
      '1.0 GiB of 2.0 GiB transferred (3 of 9 files to copy; files already present are skipped)',
   );
   // No totals from Rclone yet: no invented number.
   assert.equal(relocationProgressText(relocation({ status: 'verifying', phase: 'restic-check', progress: {} })), undefined);
   assert.equal(relocationProgressText(relocation({ phase: 'hash-verification', progress: { totalFiles: 10, verifiedFiles: 4 } })), '4 of 10 files read back');
   assert.equal(formatRelocationBytes(512), '512 B');
   assert.match(relocationFailureText('destination-hash-mismatch'), /damaged/);
   assert.match(relocationFailureText('unknown-code'), /stopped safely/);
});

const bundle = await backendRequire('esbuild').build({
   entryPoints: [fileURLToPath(new URL('../src/components/Plan/PlanRelocation/PlanRelocationModal.tsx', import.meta.url))],
   bundle: true,
   platform: 'node',
   format: 'cjs',
   jsx: 'automatic',
   write: false,
   external: ['react', 'react/jsx-runtime', 'react-dom', '@tanstack/react-query'],
   plugins: [
      {
         name: 'fixture-api',
         setup(builder: any) {
            builder.onLoad({ filter: /constants[.]ts$/ }, () => ({ contents: 'export const API_URL="https://example.internal/api";', loader: 'js' }));
            builder.onLoad({ filter: /[.]scss$/ }, () => ({ contents: 'export default new Proxy({}, {get:(_,key)=>String(key)});', loader: 'js' }));
         },
      },
   ],
});
const compiled = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, compiled, compiled.exports);
const Dialog = (compiled.exports as any).default;

async function mount(responses: (url: string, init: RequestInit) => { status: number; body: unknown }) {
   const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.internal' });
   const calls: { url: string; method: string; body?: string }[] = [];
   const fetcher = async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET', body: init.body as string | undefined });
      const reply = String(url).includes('/storages')
         ? {
              status: 200,
              body: {
                 success: true,
                 result: [
                    { id: 'storage-01', name: 'SFTP A', type: 'sftp' },
                    { id: 'storage-02', name: 'SFTP B', type: 'sftp' },
                    { id: 'storage-s3', name: 'Mirror', type: 's3' },
                 ],
              },
           }
         : responses(String(url), init);
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
   };
   const globals = ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'];
   for (const key of globals)
      Object.defineProperty(globalThis, key, {
         configurable: true,
         writable: true,
         value: key === 'fetch' ? fetcher : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : (dom.window as any)[key],
      });
   const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
   let changed = 0;
   const root = require('react-dom/client').createRoot(dom.window.document.getElementById('root'));
   await act(async () => {
      root.render(
         React.createElement(
            QueryClientProvider,
            { client },
            React.createElement(Dialog, {
               planId: 'plan-01',
               planTitle: 'Fixture App',
               currentPath: 'managed/app-01',
               close: () => undefined,
               onBindingChanged: () => changed++,
            }),
         ),
      );
   });
   const text = () => dom.window.document.body.textContent || '';
   const button = (name: string) =>
      [...dom.window.document.querySelectorAll('button')].find((element: any) => element.textContent === name) as HTMLButtonElement | undefined;
   const waitFor = async (check: () => unknown, label: string) => {
      const deadline = Date.now() + 2500;
      do {
         await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
         });
         if (check()) return;
      } while (Date.now() < deadline);
      assert.fail('Timed out: ' + label + ' ' + text());
   };
   return {
      calls,
      text,
      button,
      waitFor,
      changed: () => changed,
      async click(name: string) {
         await waitFor(() => button(name) && !button(name)!.disabled, name);
         await act(async () => button(name)!.click());
      },
      async close() {
         await act(async () => root.unmount());
         client.clear();
         dom.window.close();
      },
   };
}

test('a verified copy needs an explicit switch confirmation and refreshes the plan afterwards', async () => {
   let state = relocation();
   const view = await mount((url, init) => {
      if (init.method === 'POST' && url.endsWith('/switch')) {
         state = relocation({ status: 'switched', phase: 'switched', actions: { cancel: false, switch: false, revert: true, deleteSource: false } });
         return { status: 202, body: { success: true, result: state } };
      }
      return { status: 200, body: { success: true, result: overview([state]) } };
   });
   try {
      await view.waitFor(() => view.button('Switch to new Storage'), 'switch button');
      assert.match(view.text(), /120 files, 5\.0 GiB, 14 snapshots/);
      assert.match(view.text(), /plan stays paused/);
      await view.click('Switch to new Storage');
      // First click only opens the confirmation; nothing was sent yet.
      assert.equal(view.calls.filter((call) => call.method === 'POST').length, 0);
      assert.match(view.text(), /Pluton rechecks both copies first/);
      await view.click('Switch now');
      await view.waitFor(() => view.button('Move back'), 'switched state');
      const post = view.calls.find((call) => call.method === 'POST')!;
      assert.equal(post.url, `https://example.internal/api/plan-relocations/${'a'.repeat(24)}/switch`);
      assert.equal(view.changed(), 1);
      assert.match(view.text(), /previous copy can be deleted after one successful backup/);
   } finally {
      await view.close();
   }
});

test('deleting the previous copy is gated by typing the exact plan name', async () => {
   const view = await mount(() => ({
      status: 200,
      body: {
         success: true,
         result: overview([relocation({ status: 'switched', phase: 'switched', actions: { cancel: false, switch: false, revert: false, deleteSource: true } })]),
      },
   }));
   try {
      await view.waitFor(() => view.button('Delete previous copy'), 'delete button');
      assert.equal(view.button('Delete previous copy')!.disabled, true);
      assert.equal(view.button('Move back'), undefined);
      assert.match(view.text(), /cannot be undone/);
   } finally {
      await view.close();
   }
});

test('a failed copy explains the closed code and phase, then offers a new move', async () => {
   const failed = relocation({
      status: 'failed',
      phase: 'failed',
      failureCode: 'destination-hash-mismatch',
      actions: { cancel: false, switch: false, revert: false, deleteSource: false },
      audit: [{ at: 1, event: 'failed', code: 'destination-hash-mismatch', phase: 'hash-verification' }],
   });
   const view = await mount(() => ({ status: 200, body: { success: true, result: overview([failed], true) } }));
   try {
      await view.waitFor(() => view.button('Pause plan and copy'), 'start form');
      assert.match(view.text(), /Last move: Failed/);
      assert.match(view.text(), /damaged/);
      assert.equal(view.button('Pause plan and copy')!.disabled, true);
   } finally {
      await view.close();
   }
});

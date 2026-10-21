import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import type { ComponentType } from 'react';
import type { SourceAccessRequest } from '../src/@types/agentSourceAccess.ts';

const require = createRequire(new URL('../package.json', import.meta.url));
const backendRequire = createRequire(new URL('../../backend/package.json', import.meta.url));
const React = require('react');
const { JSDOM } = require('jsdom');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const bundled = await backendRequire('esbuild').build({
   entryPoints: [fileURLToPath(new URL('../src/components/Device/SourceAccess/SourceAccess.tsx', import.meta.url))],
   bundle: true,
   platform: 'node',
   format: 'cjs',
   jsx: 'automatic',
   write: false,
   external: ['react', 'react/jsx-runtime', 'react-dom', '@tanstack/react-query'],
   plugins: [
      {
         name: 'history-ui-fixture',
         setup(builder: { onLoad: (options: { filter: RegExp }, loader: () => { contents: string; loader: string }) => void }) {
            builder.onLoad({ filter: /\.scss$/ }, () => ({ contents: 'export default new Proxy({}, {get: (_, key) => key});', loader: 'js' }));
            builder.onLoad({ filter: /[\\/]utils[\\/]constants\.ts$/ }, () => ({ contents: 'export const API_URL="/api";', loader: 'js' }));
         },
      },
   ],
});
const module = { exports: {} as { default: ComponentType<{ deviceId: string; agentId: string }> } };
// Compile the real UI, query hooks, HTTP handling, details and common modal. Only CSS/API base are fixture-owned.
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, module, module.exports);
const SourceAccess = module.exports.default;
const revision = 'a'.repeat(64);
const states: SourceAccessRequest['status'][] = ['applied', 'validated', 'rejected', 'queued', 'pending-host-approval', 'pending-host-setup'];
function history(count: number): SourceAccessRequest[] {
   return Array.from({ length: count }, (_, index) => ({
      id: `source-${String(index).padStart(5, '0')}`,
      requestId: `source-${String(index).padStart(5, '0')}`,
      kind: (['validate', 'apply', 'mode-setup'] as const)[index % 3],
      status: states[index % states.length],
      requestedMode: 'server-managed',
      setupExpiresAt: '2026-01-01T12:00:00.000Z',
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      completedAt: '2026-01-01T11:00:00.000Z',
      expectedVersion: 3,
      expectedHostPolicyRevision: revision,
      roots: [`/srv/history-app-${index}`],
      validation: [
         {
            requestedPath: `/srv/history-app-${index}`,
            canonicalPath: `/srv/history-canonical-${index}`,
            status: 'approved',
            code: 'source-readable',
         },
      ],
      resultCode: 'source-outcome-unconfirmed',
   }));
}

async function mount(count: number) {
   const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.invalid' });
   const previous = new Map<string, PropertyDescriptor | undefined>();
   const state = { records: history(count), failure: false, blocked: false, baseFailure: false };
   const calls: URL[] = [];
   const methods: string[] = [];
   const restore = () => {
      for (const [key, descriptor] of previous) {
         if (descriptor) Object.defineProperty(globalThis, key, descriptor);
         else Reflect.deleteProperty(globalThis, key);
      }
   };
   for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      HTMLElement: dom.window.HTMLElement,
      IS_REACT_ACT_ENVIRONMENT: true,
      fetch: async (input: string, init: RequestInit = {}) => {
         const url = new URL(input, 'https://example.invalid');
         calls.push(url);
         methods.push(init.method || 'GET');
         assert.equal(init.credentials, 'include');
         assert.equal(init.redirect, 'error');
         if (url.pathname.endsWith('/requests')) {
            while (state.blocked) await new Promise((resolve) => setTimeout(resolve, 5));
            if (state.failure) return new Response('<html>synthetic-private-error</html>', { status: 500, headers: { 'Content-Type': 'text/html' } });
            assert.equal(url.searchParams.get('limit'), '10');
            const cursor = url.searchParams.get('cursor');
            const position = cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString()) : { ceiling: state.records.length, offset: 0 };
            const records = state.records
               .slice(0, position.ceiling)
               .filter(
                  (row) =>
                     (!url.searchParams.get('status') || row.status === url.searchParams.get('status')) &&
                     (!url.searchParams.get('kind') || row.kind === url.searchParams.get('kind')),
               )
               .reverse();
            const encode = (offset: number) => Buffer.from(JSON.stringify({ ...position, offset })).toString('base64url');
            return Response.json({
               success: true,
               result: {
                  requests: records.slice(position.offset, position.offset + 10),
                  total: records.length,
                  pageSize: 10,
                  cursor: encode(position.offset),
                  ...(position.offset + 10 < records.length ? { nextCursor: encode(position.offset + 10) } : {}),
               },
            });
         }
         if (state.baseFailure) return Response.json({ success: false }, { status: 401 });
         return Response.json({
            success: true,
            result: {
               supported: true,
               online: true,
               reportFresh: true,
               report: {
                  version: 1,
                  authorizationMode: 'server-managed',
                  hostPolicyRevision: revision,
                  effectiveVersion: 3,
                  approvedRoots: ['/srv/example-app'],
                  delegatedRoots: ['/srv/example-app'],
                  effectiveRoots: ['/srv/example-app'],
                  rootStatuses: [],
               },
               affectedPlans: [],
               modeSetupSupported: false,
               requests: state.records.slice(-20),
            },
         });
      },
   })) {
      previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
   }
   const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
   const root = require('react-dom/client').createRoot(dom.window.document.getElementById('root'));
   const document = dom.window.document as Document;
   const settle = async (condition: () => boolean) => {
      for (let index = 0; index < 100; index++) {
         await React.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
         });
         if (condition()) return;
      }
      assert.fail('UI condition did not settle');
   };
   const button = (text: string, scope: ParentNode = document) =>
      [...scope.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === text)!;
   const click = async (node: HTMLElement) => {
      assert.ok(node);
      await React.act(async () => node.click());
   };
   await React.act(async () =>
      root.render(
         React.createElement(QueryClientProvider, { client }, React.createElement(SourceAccess, { deviceId: 'device-01', agentId: 'agent-01' })),
      ),
   );
   await settle(() => Boolean(document.querySelector('.history')));
   return {
      state,
      calls,
      methods,
      dom,
      document,
      client,
      settle,
      button,
      click,
      open: async () => {
         const opener = button('View all requests');
         opener.focus();
         await click(opener);
         await settle(
            () =>
               Boolean(document.querySelector('[role="dialog"] .requestList, [role="dialog"] [role="alert"]')) ||
               Boolean(document.querySelector('[role="dialog"]')?.textContent?.includes('No requests match')),
         );
      },
      close: async () => {
         state.blocked = false;
         await React.act(async () => root.unmount());
         client.clear();
         dom.window.close();
         restore();
      },
   };
}

for (const count of [0, 1, 5, 6, 75])
   test(`real Source Access preview limits ${count} requests to the newest five without downloading full history`, async () => {
      const ui = await mount(count);
      try {
         const rows = [...ui.document.querySelectorAll('.historyRow')];
         assert.equal(rows.length, Math.min(5, count));
         assert.deepEqual(
            rows.map((row) => row.querySelector('time')?.dateTime),
            history(count)
               .slice(-5)
               .reverse()
               .map((row) => row.createdAt),
         );
         assert.equal(ui.calls.filter((url) => url.pathname.endsWith('/requests')).length, 0);
         assert.doesNotMatch(ui.document.querySelector('.history')!.textContent!, /history-app|history-canonical|source-outcome-unconfirmed/);
         if (!count) {
            assert.match(ui.document.querySelector('.history')!.textContent!, /No source access requests/);
            await ui.open();
            assert.match(ui.document.querySelector('[role="dialog"]')!.textContent!, /No requests match/);
            assert.equal(ui.button('Next').disabled, true);
            assert.equal(ui.button('Previous').disabled, true);
         }
      } finally {
         await ui.close();
      }
   });

test('real expandable rows retain every available audit detail, policy changes, validations and existing actions', async () => {
   const ui = await mount(6);
   try {
      await ui.open();
      const dialog = ui.document.querySelector('[role="dialog"]')!;
      const rows = [...dialog.querySelectorAll<HTMLButtonElement>('.requestSummary')];
      assert.equal(rows.length, 6);
      assert.match(dialog.textContent!, /Applied|Validated|Rejected|Pending host approval|Pending host setup|Queued/);
      for (let index = 0; index < rows.length; index++) {
         const row = rows[index];
         assert.equal(row.tagName, 'BUTTON');
         assert.equal(row.getAttribute('aria-expanded'), 'false');
         const details = ui.document.getElementById(row.getAttribute('aria-controls')!)!;
         assert.equal(details.hidden, true);
         await ui.click(row);
         assert.equal(row.getAttribute('aria-expanded'), 'true');
         assert.equal(details.hidden, false);
         const expected = history(6)[5 - index];
         for (const value of [
            expected.id,
            expected.kind,
            expected.roots[0],
            expected.validation![0].canonicalPath!,
            revision,
            expected.resultCode!,
            'Expected version',
            'Completed',
            'Requested mode',
            'Setup expires',
         ])
            assert.ok(details.textContent!.includes(value), value);
         assert.ok(row.querySelector('svg'), 'existing status icon is present');
         await ui.click(row);
         assert.equal(details.textContent, '');
      }
      assert.ok(rows.some((row) => row.textContent!.includes('Policy change')));
      assert.ok(
         ui.methods.every((method) => method === 'GET'),
         'view/expand/collapse never submits or cancels a request',
      );
   } finally {
      await ui.close();
   }
});

test('full history pages ten at a time, keeps snapshot cursors stable on new arrivals, refreshes to latest and resets filters', async () => {
   const ui = await mount(23);
   try {
      await ui.open();
      const dialog = ui.document.querySelector('[role="dialog"]')!;
      const times = () => [...dialog.querySelectorAll('time')].map((node) => node.dateTime);
      const first = times();
      assert.equal(first.length, 10);
      assert.equal(ui.button('Previous', dialog).disabled, true);
      ui.state.records = history(24);
      await ui.click(ui.button('Next', dialog));
      await ui.settle(() => dialog.textContent!.includes('Page 2'));
      assert.deepEqual(
         times(),
         history(23)
            .slice(3, 13)
            .reverse()
            .map((row) => row.createdAt),
      );
      assert.match(dialog.textContent!, /23 requests/);
      await ui.click(ui.button('Next', dialog));
      await ui.settle(() => dialog.textContent!.includes('Page 3'));
      assert.equal(times().length, 3);
      assert.equal(ui.button('Next', dialog).disabled, true);
      await ui.click(ui.button('Previous', dialog));
      await ui.settle(() => dialog.textContent!.includes('Page 2'));
      await ui.click(ui.button('Previous', dialog));
      await ui.settle(() => dialog.textContent!.includes('Page 1'));
      assert.deepEqual(times(), first);
      await ui.click(ui.button('Refresh history', dialog));
      await ui.settle(() => dialog.textContent!.includes('24 requests'));
      assert.equal(times()[0], history(24)[23].createdAt);
      assert.equal(ui.document.querySelector('.history > .requestList time')!.getAttribute('datetime'), history(24)[23].createdAt);
      const status = [...dialog.querySelectorAll('label')].find((node) => node.textContent!.startsWith('Status'))!.querySelector('select')!;
      await React.act(async () => {
         status.value = 'rejected';
         status.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
      });
      await ui.settle(() => dialog.textContent!.includes('4 requests'));
      assert.ok([...dialog.querySelectorAll('.requestSummary')].every((row) => row.textContent!.includes('Rejected')));
      assert.equal(ui.button('Previous', dialog).disabled, true);
      const type = [...dialog.querySelectorAll('label')].find((node) => node.textContent!.startsWith('Type'))!.querySelector('select')!;
      await React.act(async () => {
         type.value = 'validate';
         type.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
      });
      await ui.settle(() => dialog.textContent!.includes('No requests match'));
      assert.equal(ui.button('Next', dialog).disabled, true);
      assert.ok(ui.calls.filter((url) => url.pathname.endsWith('/requests')).every((url) => url.searchParams.get('limit') === '10'));
      assert.ok(ui.methods.every((method) => method === 'GET'));
   } finally {
      await ui.close();
   }
});

test('history loading and API failures are explicit, sanitized and retryable without discarding the preview', async () => {
   const ui = await mount(6);
   try {
      ui.state.blocked = true;
      await ui.click(ui.button('View all requests'));
      assert.match(ui.document.querySelector('[role="dialog"]')!.textContent!, /Loading request history/);
      ui.state.failure = true;
      ui.state.blocked = false;
      await ui.settle(() => Boolean(ui.document.querySelector('[role="dialog"] [role="alert"]')));
      assert.doesNotMatch(ui.document.body.textContent!, /synthetic-private-error/);
      assert.equal(ui.document.querySelectorAll('.history > .requestList > li').length, 5);
      ui.state.failure = false;
      await ui.click(ui.button('Refresh history'));
      await ui.settle(() => ui.document.querySelectorAll('[role="dialog"] .requestSummary').length === 6);
   } finally {
      await ui.close();
   }
});

test('history reuses the real stable modal with keyboard focus containment, Escape and focus restoration', async () => {
   const ui = await mount(23);
   try {
      const opener = ui.button('View all requests');
      await ui.open();
      const dialog = ui.document.querySelector<HTMLElement>('[role="dialog"]')!;
      assert.equal(dialog.getAttribute('aria-modal'), 'true');
      assert.equal(ui.document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent, 'Source Access request history');
      assert.equal(ui.document.activeElement, dialog);
      const first = ui.button(''); // The shared modal close button has an accessible label instead of text.
      assert.equal(first.getAttribute('aria-label'), 'Close dialog');
      ui.button('Next', dialog).focus();
      await React.act(async () => dialog.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
      assert.equal(ui.document.activeElement, first);
      await React.act(async () =>
         dialog.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })),
      );
      assert.equal(ui.document.activeElement, ui.button('Next', dialog));
      await React.act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      assert.equal(ui.document.querySelector('[role="dialog"]'), null);
      assert.equal(ui.document.activeElement, opener);
      const css = readFileSync(new URL('../src/components/Device/SourceAccess/SourceAccess.module.scss', import.meta.url), 'utf8');
      assert.match(css, /@media \(max-width: 600px\)/);
      assert.match(css, /max-height: 22rem/);
      assert.match(css, /overflow-anchor: none/);
   } finally {
      await ui.close();
   }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { preparationRequest } from '../src/utils/downloadPreparation.ts';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const job = (state = 'indexing') => ({
   id,
   state,
   createdAt: 1000,
   elapsedMs: 2000,
   indexedEntries: 12,
   validatedEntries: state === 'ready' ? 12 : 0,
   retryAfterMs: state === 'ready' ? 0 : 1000,
});
test('confirmed 202 creation, polling and cancellation retain exact identities and authentication', async () => {
   const previous = globalThis.fetch;
   const calls: any[] = [];
   globalThis.fetch = async (url, init) => {
      calls.push([String(url), init]);
      return Response.json(
         { success: true, result: init?.method === 'POST' ? { preparation: job('queued') } : job(init?.method === 'DELETE' ? 'cancelled' : 'ready') },
         { status: init?.method === 'POST' ? 202 : 200 },
      );
   };
   try {
      assert.equal((await preparationRequest('https://example.internal/api', 'backup/01')).state, 'queued');
      assert.equal((await preparationRequest('https://example.internal/api', 'backup/01', id)).state, 'ready');
      assert.equal((await preparationRequest('https://example.internal/api', 'backup/01', id, true)).state, 'cancelled');
      assert.deepEqual(
         calls.map((call) => call[1].method),
         ['POST', 'GET', 'DELETE'],
      );
      for (const [url, options] of calls) {
         assert(url.includes('/backup%2F01/'));
         assert.equal(options.credentials, 'include');
         assert.equal(options.redirect, 'error');
      }
   } finally {
      globalThis.fetch = previous;
   }
});
for (const status of [429, 502, 503, 504, 524])
   test(`HTML ${status} stops polling, preserves Retry-After, and never exposes proxy content`, async () => {
      const original = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = async () => {
         calls++;
         return new Response('<html>private gateway</html>', { status, headers: { 'Content-Type': 'text/html', 'Retry-After': '60' } });
      };
      try {
         await assert.rejects(
            preparationRequest('https://example.internal/api', 'backup-01', id),
            (error: any) => error.retryAt > Date.now() && !error.message.includes('private gateway') && !error.message.includes('may already'),
         );
         assert.equal(calls, 1);
      } finally {
         globalThis.fetch = original;
      }
   });
test('missing identity, oversized body and mismatched status fail closed', async () => {
   const original = globalThis.fetch;
   try {
      for (const body of [{ success: true }, { success: true, result: { ...job(), id: 'b'.repeat(36) } }, 'x'.repeat(65537)]) {
         globalThis.fetch = async () => Response.json(body);
         await assert.rejects(preparationRequest('https://example.internal/api', 'backup-01', id));
      }
   } finally {
      globalThis.fetch = original;
   }
});

const require = createRequire(new URL('../package.json', import.meta.url));
const backendRequire = createRequire(new URL('../../backend/package.json', import.meta.url));
const React = require('react'),
   { act } = React,
   { JSDOM } = require('jsdom');
const result = await backendRequire('esbuild').build({
   entryPoints: [fileURLToPath(new URL('../src/components/Plan/Backups/DownloadPreparation.tsx', import.meta.url))],
   bundle: true,
   platform: 'node',
   format: 'cjs',
   jsx: 'automatic',
   write: false,
   external: ['react', 'react/jsx-runtime'],
   plugins: [
      {
         name: 'preparation-ui',
         setup(builder: any) {
            builder.onLoad({ filter: /\.scss$/ }, () => ({ contents: 'export default {};', loader: 'js' }));
            builder.onLoad({ filter: /[\\/]Modal\.tsx$/ }, () => ({
               contents: 'import React from "react";export default p=>React.createElement("section",{},p.children);',
               loader: 'js',
            }));
            builder.onLoad({ filter: /[\\/]constants\.ts$/ }, () => ({
               contents: 'export const API_URL="https://example.internal/api";',
               loader: 'js',
            }));
         },
      },
   ],
});
const module = { exports: {} as any };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
test('actual panel follows queued/indexing/validating/ready, separates native transfer, and hides stale readiness on proxy error', async (context) => {
   const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.internal' });
   const saved = new Map<string, PropertyDescriptor | undefined>();
   const calls: string[] = [];
   let state = 'queued',
      proxyError = false,
      downloaded = '';
   for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
      fetch: async (_url: string, init: RequestInit) => {
         calls.push(init.method!);
         if (proxyError) return new Response('<html>private</html>', { status: 524, headers: { 'Content-Type': 'text/html' } });
         return Response.json(
            { success: true, result: init.method === 'POST' ? { preparation: job(state) } : job(state) },
            { status: init.method === 'POST' ? 202 : 200 },
         );
      },
   })) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
   }
   dom.window.HTMLAnchorElement.prototype.click = function () {
      downloaded = this.href;
   };
   context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
   const root = require('react-dom/client').createRoot(dom.window.document.getElementById('root'));
   const flush = async () => {
      await act(async () => {
         await new Promise<void>((resolve) => setImmediate(resolve));
      });
   };
   try {
      await act(async () => root.render(React.createElement(module.exports.default, { backupId: 'backup-01', close() {} })));
      await flush();
      assert.match(dom.window.document.body.textContent!, /Queued/);
      for (state of ['indexing', 'validating', 'ready']) {
         await act(async () => context.mock.timers.tick(1000));
         await flush();
      }
      assert.match(dom.window.document.body.textContent!, /Ready to download/);
      assert.match(dom.window.document.body.textContent!, /Validated entries: 12/);
      assert(!dom.window.document.body.textContent!.includes('%'));
      const button = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Download TAR')!;
      await act(async () => button.click());
      assert.equal(new URL(downloaded).searchParams.get('preparationId'), id);
      assert.equal(calls.filter((method) => method === 'POST').length, 1);
      assert.match(dom.window.document.body.textContent!, /browser download manager/);
      proxyError = true;
      await act(async () => context.mock.timers.tick(5000));
      await flush();
      assert(![...dom.window.document.querySelectorAll('button')].some((button) => button.textContent === 'Download TAR'));
      assert.match(dom.window.document.body.textContent!, /HTTP 524/);
   } finally {
      await act(async () => root.unmount());
      context.mock.timers.reset();
      dom.window.close();
      for (const [key, descriptor] of saved) {
         if (descriptor) Object.defineProperty(globalThis, key, descriptor);
         else Reflect.deleteProperty(globalThis, key);
      }
   }
});

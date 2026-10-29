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
const partialId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const verifiedJob = (state = 'ready', mode = 'regular-files') => ({
   ...job(state),
   validatedEntries: state === 'ready' ? (mode === 'full' ? 12 : 9) : 0,
   id: mode === 'full' ? id : partialId,
   exportMode: mode,
   ...(state === 'ready'
      ? {
           export: {
              version: 1,
              binding: { backupId: 'backup-01', repositoryId: 'repository-01', snapshotId: 'a'.repeat(64) },
              mode,
              includedEntries: mode === 'full' ? 12 : 9,
              excludedEntries: mode === 'full' ? 0 : 3,
              includedByType: mode === 'full' ? { file: 8, dir: 4 } : { file: 5, dir: 4 },
              excludedByType: mode === 'full' ? {} : { symlink: 2, fifo: 1 },
              manifestSha256: 'b'.repeat(64),
              archiveSha256: 'c'.repeat(64),
              archiveBytes: 2048,
           },
        }
      : {}),
});

test('partial requests bind creation, status and cancellation to their explicit mode and verified counts', async () => {
   const original = globalThis.fetch;
   const calls: string[] = [];
   globalThis.fetch = async (url, init) => {
      calls.push(String(url));
      return Response.json(
         { success: true, result: init?.method === 'POST' ? { preparation: verifiedJob('indexing') } : verifiedJob() },
         { status: init?.method === 'POST' ? 202 : 200 },
      );
   };
   try {
      await preparationRequest('https://example.internal/api', 'backup-01', undefined, false, undefined, 'regular-files');
      const ready = await preparationRequest('https://example.internal/api', 'backup-01', partialId, false, undefined, 'regular-files');
      assert.equal(ready.export?.includedEntries, 9);
      assert.equal(ready.export?.excludedByType.symlink, 2);
      await preparationRequest('https://example.internal/api', 'backup-01', partialId, true, undefined, 'regular-files');
      assert(calls.every((url) => new URL(url).searchParams.get('exportMode') === 'regular-files'));
   } finally {
      globalThis.fetch = original;
   }
});
for (const failure of ['cross-mode', 'missing-proof', 'wrong-backup', 'wrong-counts', 'unknown-type', 'bad-hash'])
   test(`partial readiness refuses ${failure}`, async () => {
      const original = globalThis.fetch;
      const value: any = verifiedJob();
      if (failure === 'cross-mode') value.exportMode = 'full';
      if (failure === 'missing-proof') delete value.export;
      if (failure === 'wrong-backup') value.export.binding.backupId = 'backup-foreign';
      if (failure === 'wrong-counts') value.export.includedEntries++;
      if (failure === 'unknown-type') value.export.excludedByType = { private: 3 };
      if (failure === 'bad-hash') value.export.archiveSha256 = 'invalid';
      globalThis.fetch = async () => Response.json({ success: true, result: value });
      try {
         await assert.rejects(preparationRequest('https://example.internal/api', 'backup-01', partialId, false, undefined, 'regular-files'));
      } finally {
         globalThis.fetch = original;
      }
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
test('delivery methods remain separate: durable export progress, verified readiness and stale-link hiding', async (context) => {
   const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.internal' }),
      saved = new Map<string, PropertyDescriptor | undefined>(),
      calls: { url: string; method: string }[] = [];
   let state = 'queued',
      proxy = false;
   const reliable = () => ({
      id,
      state,
      mode: 'full',
      snapshotId: 'a'.repeat(64),
      createdAt: 1000,
      elapsedMs: 2000,
      processedBytes: state === 'queued' ? 0 : 2048,
      uploadedBytes: state === 'queued' ? 0 : state === 'uploading' ? 1024 : 2048,
      totalBytes: state === 'queued' ? undefined : 2048,
      averageBytesPerSecond: 512,
      expiresAt: Date.now() + 60000,
      integrity: state === 'ready' ? 'verified' : 'pending',
      cleanupPending: false,
      summary: state === 'ready' ? verifiedJob('ready', 'full').export : undefined,
   });
   for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
      fetch: async (url: string, init: RequestInit) => {
         calls.push({ url, method: init.method! });
         if (url.includes('/exports')) {
            if (proxy) return new Response('<html>private-provider</html>', { status: 504, headers: { 'Content-Type': 'text/html' } });
            const value: any = reliable();
            if (value.summary) {
               value.summary.archiveBytes = 2048;
               value.summary.archiveSha256 = 'c'.repeat(64);
            }
            return Response.json({ success: true, result: value }, { status: init.method === 'POST' ? 202 : 200 });
         }
         return Response.json({ success: true, result: init.method === 'POST' ? { preparation: job('queued') } : job('cancelled') });
      },
   })) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
   }
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
      const delivery = dom.window.document.querySelectorAll<HTMLInputElement>('input[name="delivery-method"]');
      await act(async () => delivery[1].click());
      await flush();
      assert.match(dom.window.document.body.textContent!, /Queued/);
      assert.equal(calls.filter((c) => c.method === 'DELETE' && !c.url.includes('/exports')).length, 1);
      state = 'uploading';
      await act(async () => context.mock.timers.tick(2000));
      await flush();
      assert.match(dom.window.document.body.textContent!, /50%/);
      state = 'verifying';
      await act(async () => context.mock.timers.tick(2000));
      await flush();
      assert.match(dom.window.document.body.textContent!, /Verifying complete temporary object/);
      assert(!dom.window.document.querySelector('a[href$="/link"]'));
      state = 'ready';
      await act(async () => context.mock.timers.tick(2000));
      await flush();
      assert.match(dom.window.document.body.textContent!, /Integrity: complete object size and SHA-256 verified/);
      assert(dom.window.document.querySelector('a[href$="/link"]'));
      assert.match(dom.window.document.body.textContent!, /Browser Resume/);
      assert(!/laptop download finished/i.test(dom.window.document.body.textContent!));
      proxy = true;
      await act(async () => context.mock.timers.tick(5000));
      await flush();
      assert.match(dom.window.document.body.textContent!, /HTTP 504/);
      assert(!dom.window.document.querySelector('a[href$="/link"]'));
      assert(!dom.window.document.body.textContent!.includes('private-provider'));
   } finally {
      await act(async () => root.unmount());
      context.mock.timers.reset();
      dom.window.close();
      for (const [key, descriptor] of saved) {
         if (descriptor) Object.defineProperty(globalThis, key, descriptor);
         else Reflect.deleteProperty(globalThis, key);
      }
   }
   assert.equal(calls.filter((c) => c.method === 'DELETE' && c.url.includes('/exports')).length, 0);
});
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

test('actual panel cancels active full preparation before switching mode, warns about partial recovery and downloads only its proof', async (context) => {
   const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.internal' });
   const saved = new Map<string, PropertyDescriptor | undefined>();
   const calls: { method: string; mode: string }[] = [];
   let state = 'indexing',
      downloaded = '';
   for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      IS_REACT_ACT_ENVIRONMENT: true,
      fetch: async (url: string, init: RequestInit) => {
         const mode = new URL(url).searchParams.get('exportMode') || 'full';
         calls.push({ method: init.method!, mode });
         const value = verifiedJob(init.method === 'DELETE' ? 'cancelled' : state, mode);
         return Response.json(
            { success: true, result: init.method === 'POST' ? { preparation: value } : value },
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
      const radios = dom.window.document.querySelectorAll<HTMLInputElement>('input[name="export-mode"]');
      assert.equal(radios.length, 2);
      assert.equal(dom.window.document.querySelectorAll('input[name="delivery-method"]').length, 2);
      await act(async () => radios[1].click());
      await flush();
      assert.deepEqual(calls.slice(0, 3), [
         { method: 'POST', mode: 'full' },
         { method: 'DELETE', mode: 'full' },
         { method: 'POST', mode: 'regular-files' },
      ]);
      assert.match(dom.window.document.body.textContent!, /This is a partial export/);
      state = 'ready';
      await act(async () => context.mock.timers.tick(1000));
      await flush();
      assert.match(dom.window.document.body.textContent!, /Included entries: 9 · Excluded entries: 3/);
      assert.match(dom.window.document.body.textContent!, /Symbolic links: 2/);
      assert(!/Restore mode/.test(dom.window.document.body.textContent!));
      const button = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Download TAR')!;
      await act(async () => button.click());
      assert.equal(new URL(downloaded).searchParams.get('exportMode'), 'regular-files');
      assert.equal(new URL(downloaded).searchParams.get('preparationId'), partialId);
      const manifest = [...dom.window.document.querySelectorAll('a')].find((link) => link.textContent === 'Download export manifest')!;
      assert.equal(new URL(manifest.href).searchParams.get('exportMode'), 'regular-files');
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

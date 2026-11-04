import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { activityEntry, activityFetch } from './downloadActivityFixture.mjs';
import fs from 'node:fs';
import { downloadBytes, downloadDuration, downloadStep, uploadPercent } from '../src/utils/downloadProgress.ts';

const require = createRequire(new URL('../package.json', import.meta.url));
const backendRequire = createRequire(new URL('../../backend/package.json', import.meta.url));
const React = require('react'),
   { act } = React,
   { JSDOM } = require('jsdom');
const bundle = await backendRequire('esbuild').build({
   stdin: activityEntry,
   bundle: true,
   platform: 'node',
   format: 'cjs',
   jsx: 'automatic',
   write: false,
   external: ['react', 'react/jsx-runtime', 'react-dom'],
   plugins: [
      {
         name: 'download-fixtures',
         setup(builder: any) {
            builder.onLoad({ filter: /\.scss$/ }, () => ({ contents: 'export default {};', loader: 'js' }));
            builder.onLoad({ filter: /[\\/]Icon\.tsx$/ }, () => ({ contents: 'export default ()=>null;', loader: 'js' }));
            builder.onLoad({ filter: /[\\/]utils[\\/]constants\.ts$/ }, () => ({
               contents: 'export const API_URL="https://example.internal/api";',
               loader: 'js',
            }));
         },
      },
   ],
});
const module = { exports: {} as any };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, module, module.exports);
const Panel = module.exports.default;
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const base = () => ({
   id,
   mode: 'full',
   state: 'uploading',
   snapshotId: 'a'.repeat(64),
   createdAt: Date.now(),
   elapsedMs: 1000,
   processedBytes: 28 * 1024 ** 2,
   uploadedBytes: 12 * 1024 ** 2,
   totalBytes: 120 * 1024 ** 2,
   averageBytesPerSecond: 104858,
   integrity: 'pending',
   cleanupPending: false,
   integrityMode: 'application-encrypted-hcp',
   confidentiality: 'application-encrypted',
   transport: 'authenticated-proxy',
});
const response = (job: any) => Response.json({ success: true, result: job });
const ready = (backupId: string) => ({
   ...base(),
   state: 'ready',
   integrity: 'verified',
   expiresAt: Date.now() + 60000,
   processedBytes: 120 * 1024 ** 2,
   uploadedBytes: 120 * 1024 ** 2,
   summary: {
      version: 1,
      binding: { backupId, repositoryId: 'repository-01', snapshotId: 'a'.repeat(64) },
      mode: 'full',
      includedEntries: 2,
      excludedEntries: 0,
      includedByType: { file: 1, dir: 1 },
      excludedByType: {},
      manifestSha256: 'b'.repeat(64),
      archiveSha256: 'c'.repeat(64),
      archiveBytes: 120 * 1024 ** 2,
   },
});
async function harness(t: any, backupId: string, fetcher: typeof fetch, raw = false) {
   const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.internal/' });
   const keys = ['window', 'document', 'HTMLElement', 'Node', 'IS_REACT_ACT_ENVIRONMENT', 'fetch', 'BroadcastChannel'];
   const previous = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
   for (const key of keys)
      Object.defineProperty(globalThis, key, {
         configurable: true,
         writable: true,
         value:
            key === 'fetch'
               ? raw
                  ? fetcher
                  : activityFetch(fetcher, backupId)
               : key === 'IS_REACT_ACT_ENVIRONMENT'
                 ? true
                 : dom.window[key as keyof typeof dom.window],
      });
   t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100000 });
   const root = require('react-dom/client').createRoot(dom.window.document.getElementById('root'));
   const render = async (open = true) => {
      await act(async () => root.render(open ? React.createElement(Panel, { backupId, close: () => root.render(null) }) : null));
   };
   const tick = async (ms: number) => {
      await act(async () => {
         t.mock.timers.tick(ms);
      });
   };
   const find = (label: string) =>
      [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent?.trim() === label) as HTMLButtonElement;
   const click = async (label: string) => {
      const button = find(label);
      assert(button, 'Missing button ' + label);
      assert(!button.disabled);
      await act(async () => button.click());
   };
   const reliable = async () => {
      await act(async () => (dom.window.document.querySelectorAll('input[name="delivery-method"]')[1] as HTMLInputElement).click());
   };
   const text = () => dom.window.document.body.textContent || '';
   t.after(async () => {
      await act(async () => root.unmount());
      t.mock.timers.reset();
      dom.window.close();
      for (const [key, value] of previous) {
         if (value) Object.defineProperty(globalThis, key, value);
         else Reflect.deleteProperty(globalThis, key);
      }
   });
   await render();
   const navigate = async () => {
      await act(async () => root.render(React.createElement(Panel, { backupId, panelOpen: false })));
   };
   return { render, navigate, tick, find, click, reliable, text, document: dom.window.document };
}
function standard() {
   return response({
      id,
      state: 'ready',
      createdAt: 1000,
      elapsedMs: 1000,
      indexedEntries: 2,
      validatedEntries: 2,
      retryAfterMs: 1000,
      exportMode: 'full',
   });
}

test('percentage is upload-only, bounded until verified ready; formatting and stages are honest', () => {
   assert.equal(uploadPercent(base() as any), 10);
   for (const state of ['uploading', 'verifying', 'failed', 'cancelled'])
      assert.equal(uploadPercent({ ...base(), state, uploadedBytes: base().totalBytes } as any), 99);
   assert.equal(uploadPercent(ready('backup-01') as any), 100);
   for (const totalBytes of [undefined, 0, NaN, Infinity, -1]) assert.equal(uploadPercent({ ...base(), totalBytes } as any), undefined);
   assert.equal(downloadStep({ ...base(), state: 'validating', performance: { phase: 'archive-validation' } } as any), 1);
   assert.equal(downloadBytes(2 * 1024 ** 3), '2 GiB');
   assert.equal(downloadStep({ ...base(), performance: { phase: 'publication', lastProgressAgeMs: 60000 } } as any), 3);
   assert.equal(downloadBytes(Infinity), 'Unavailable');
   assert.equal(downloadDuration(128000), '2m 8s');
});
test('slow polling retains DOM/progress and controls, never overlaps, reconnects same job and ignores late reads after cancellation', async (t) => {
   let calls = 0,
      posts = 0,
      deletes = 0;
   let resolveRead: ((value: Response) => void) | undefined;
   const ui = await harness(t, 'backup-poll', async (url, options) => {
      if (!String(url).includes('/exports')) return standard();
      if (options?.method === 'POST') {
         posts++;
         return response(base());
      }
      if (options?.method === 'DELETE') {
         deletes++;
         return response({ ...base(), state: 'cancelled', cleanupPending: true });
      }
      calls++;
      if (calls === 1 || calls === 3)
         return new Promise((resolve) => {
            resolveRead = resolve;
         });
      if (calls === 2) throw new TypeError('network unavailable');
      return response({ ...base(), state: 'cancelled', cleanupPending: calls === 4 });
   });
   await ui.reliable();
   await ui.click('Prepare Reliable Download');
   const panel = ui.document.querySelector('section[aria-label="Reliable Download progress"]');
   const progress = ui.document.querySelector('progress');
   const cancel = ui.find('Cancel export…');
   await ui.tick(2000);
   await ui.tick(20000);
   assert.equal(calls, 1);
   assert.equal(ui.document.querySelector('progress'), progress);
   assert.equal(ui.find('Cancel export…'), cancel);
   assert(!cancel.disabled);
   assert.match(ui.text(), /Uploaded: 12 MiB/);
   await act(async () => resolveRead!(response({ ...base(), uploadedBytes: 24 * 1024 ** 2 })));
   await ui.tick(2000);
   assert.match(ui.text(), /reconnecting/);
   assert.match(ui.text(), /Uploaded: 24 MiB/);
   assert.equal(ui.document.querySelector('section[aria-label="Reliable Download progress"]'), panel);
   await ui.tick(2000);
   assert.equal(calls, 3);
   await ui.click('Cancel export…');
   assert.equal(deletes, 0);
   await ui.click('Keep export');
   assert.equal(deletes, 0);
   await ui.click('Cancel export…');
   await ui.click('Confirm cancellation and cleanup');
   assert.equal(deletes, 1);
   assert.match(ui.text(), /Cleanup pending/);
   await act(async () => resolveRead!(response(ready('backup-poll'))));
   assert(!ui.text().includes('Download Verified TAR'));
   await ui.tick(5000);
   await ui.tick(2000);
   assert.match(ui.text(), /Export cancelled/);
   assert.equal(posts, 1);
});
test('reopening recovers job with GET; indeterminate preparation, verification at 99, ready evidence survives failed poll', async (t) => {
   const methods: string[] = [];
   let value: any = { ...base(), state: 'validating', totalBytes: undefined, uploadedBytes: 0, processedBytes: 0 };
   let unavailable = false;
   const ui = await harness(t, 'backup-reopen', async (url, options) => {
      if (!String(url).includes('/exports')) return standard();
      methods.push(options?.method || '');
      if (unavailable) throw new TypeError('network unavailable');
      return response(value);
   });
   await ui.reliable();
   await ui.click('Prepare Reliable Download');
   assert.equal(ui.document.querySelector('progress')?.hasAttribute('value'), false);
   assert.match(ui.text(), /You may close this window/);
   await ui.click('Close');
   await ui.tick(10000);
   assert.deepEqual(methods, ['POST', 'GET']);
   await ui.render();
   assert.deepEqual(methods, ['POST', 'GET', 'GET']);
   value = { ...base(), uploadedBytes: base().totalBytes, performance: { phase: 'publication', lastProgressAgeMs: 60000 } };
   await ui.tick(2000);
   assert.match(ui.text(), /Verifying complete archive/);
   assert(!ui.text().includes('Upload stalled'));
   assert.equal(ui.document.querySelector('progress')?.getAttribute('value'), '99');
   value = { ...base(), state: 'verifying', uploadedBytes: base().totalBytes };
   await ui.tick(2000);
   assert.equal(ui.document.querySelector('progress')?.getAttribute('value'), '99');
   assert(!ui.text().includes('Download Verified TAR'));
   value = ready('backup-reopen');
   await ui.tick(2000);
   assert.equal(ui.document.querySelector('progress')?.getAttribute('value'), '100');
   const link = ui.document.querySelector('a[href$="/link"]');
   unavailable = true;
   await act(async () => ui.document.defaultView!.dispatchEvent(new ui.document.defaultView!.Event('focus')));
   await ui.tick(5000);
   assert.match(ui.text(), /reconnecting/);
   assert.equal(ui.document.querySelector('a[href$="/link"]'), link);
   assert(!ui.find('Get or renew resume link').disabled);
   assert.equal(methods.filter((m) => m === 'POST').length, 1);
   assert.equal(ui.document.querySelector('[aria-current="step"]')?.textContent, 'Ready to download');
});
test('stable dialog and reduced motion avoid polling transitions; status announcements exclude per-second counters', () => {
   const styles = fs.readFileSync(new URL('../src/components/Plan/Backups/DownloadPreparation.module.scss', import.meta.url), 'utf8');
   assert.match(styles, /prefers-reduced-motion: reduce/);
   assert.match(styles, /animation: none/);
   const source = fs.readFileSync(new URL('../src/components/Plan/Backups/ReliableDownload.tsx', import.meta.url), 'utf8');
   assert.match(source, /role="status" aria-live="polite"/);
   assert(!/aria-live[^>]*>[\s\S]*?Processed:[\s\S]*?<\/p>/.test(source.split('className={styles.progressDetails}')[1] || ''));
});
test('failed cancellation keeps confirmation and job; double submit and unmount cannot publish late action results', async (t) => {
   let deletes = 0;
   let fail = true;
   let resolveDelete: ((value: Response) => void) | undefined;
   const ui = await harness(t, 'backup-cancel', async (url, options) => {
      if (!String(url).includes('/exports')) return standard();
      if (options?.method === 'DELETE') {
         deletes++;
         if (fail) throw new TypeError('Cancellation was not confirmed.');
         return new Promise((resolve) => {
            resolveDelete = resolve;
         });
      }
      return response(base());
   });
   await ui.reliable();
   await ui.click('Prepare Reliable Download');
   await ui.click('Cancel export…');
   await ui.click('Confirm cancellation and cleanup');
   assert(ui.find('Confirm cancellation and cleanup'));
   assert.match(ui.text(), /Connection interrupted or status request timed out/);
   assert.match(ui.text(), /Uploaded: 12 MiB/);
   fail = false;
   const button = ui.find('Confirm cancellation and cleanup');
   await act(async () => {
      button.click();
      button.click();
   });
   assert.equal(deletes, 2);
   assert(button.disabled);
   await ui.render(false);
   await act(async () => resolveDelete!(response({ ...base(), state: 'cancelled', cleanupPending: true })));
   await ui.tick(60000);
   assert.equal(ui.document.querySelector('section'), null);
   assert.equal(deletes, 2);
});
test('bounded status timeout retries only after abort; known progress and job identity survive', async (t) => {
   let gets = 0,
      posts = 0,
      aborted = 0;
   const ui = await harness(t, 'backup-timeout', async (url, options) => {
      if (!String(url).includes('/exports')) return standard();
      if (options?.method === 'POST') {
         posts++;
         return response(base());
      }
      gets++;
      if (gets > 1) return response(base());
      return new Promise((_resolve, reject) =>
         options?.signal?.addEventListener(
            'abort',
            () => {
               aborted++;
               reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
         ),
      );
   });
   await ui.reliable();
   await ui.click('Prepare Reliable Download');
   await ui.tick(29999);
   assert.equal(gets, 1);
   assert.equal(aborted, 0);
   await ui.tick(1);
   assert.equal(aborted, 1);
   assert.match(ui.text(), /timed out/);
   assert.match(ui.text(), /Uploaded: 12 MiB/);
   await ui.tick(2000);
   assert.equal(gets, 2);
   assert.equal(posts, 1);
   assert(!ui.text().includes('timed out'));
});
test('configured encrypted shared destination without GO has actionable NO-GO, no running bar, no admission or provider probes', async (t) => {
   const calls: { url: string; method: string }[] = [];
   const ui = await harness(
      t,
      'backup-nogo',
      async (url, options) => {
         calls.push({ url: String(url), method: options?.method || 'GET' });
         if (String(url).endsWith('/activity'))
            return response({
               jobs: [],
               readiness: {
                  configured: true,
                  sharedNamespaceEnabled: true,
                  keyringConfigured: true,
                  exportMode: 'application-encrypted-hcp',
                  preflight: 'NO-GO',
                  admissionAllowed: false,
                  reason: 'preflight-required',
               },
            });
         return standard();
      },
      true,
   );
   await ui.reliable();
   assert.match(ui.text(), /Static configuration: configured/);
   assert.match(ui.text(), /Capability preflight: NO-GO/);
   assert.match(ui.text(), /No export has been created/);
   assert(!ui.text().includes('reconnecting'));
   assert.equal(ui.document.querySelector('progress'), null);
   assert(!ui.text().includes('Elapsed: 0s'));
   assert(!ui.find('Prepare Reliable Download'));
   const before = calls.length;
   await ui.tick(120000);
   assert.equal(calls.length, before);
   await ui.click('Check readiness and existing jobs');
   assert(calls.filter((c) => c.url.endsWith('/activity')).length >= 2);
   assert(!calls.some((c) => /\/exports$|\/preflights|\/inventory-checks/.test(c.url) && c.method === 'POST'));
});
test('app tracker survives route modal unmount, discovers multiple modes, and opens only server-verified job details', async (t) => {
   let reads = 0;
   const jobs = [
      { backupId: 'backup-tracker', planId: 'plan-01', job: base() },
      {
         backupId: 'backup-second',
         planId: 'plan-02',
         job: { ...base(), id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', mode: 'regular-files', state: 'cancelled', cleanupPending: true },
      },
   ];
   const ui = await harness(
      t,
      'backup-tracker',
      async (url, options) => {
         if (String(url).endsWith('/activity')) {
            reads++;
            assert.equal(options?.method || 'GET', 'GET');
            return response({ jobs, readiness: { configured: true, admissionAllowed: true, preflight: 'GO', reason: 'ready' } });
         }
         assert(!String(url).includes('/exports'));
         return standard();
      },
      true,
   );
   await ui.reliable();
   await ui.navigate();
   assert.equal(ui.document.querySelector('section[aria-label="Reliable Download progress"]'), null);
   assert(ui.find('Exports · 2 active'));
   const before = reads;
   await ui.tick(2000);
   assert(reads > before);
   await ui.click('Exports · 2 active');
   assert.match(ui.text(), /Browser file transfers are separate/);
   assert.match(ui.text(), /Cleanup pending/);
   const detail = [...ui.document.querySelectorAll('li button')].find((button) =>
      button.textContent?.includes('backup-tracker'),
   ) as HTMLButtonElement;
   assert(detail);
   await act(async () => detail.click());
   assert.match(ui.text(), /Uploaded: 12 MiB/);
   assert.match(ui.text(), /Your export is running on the server/);
   // Re-login invalidates the old owner's state even while its details are open.
   jobs.splice(0);
   await act(async () => ui.document.defaultView!.dispatchEvent(new ui.document.defaultView!.Event('pluton-export-session')));
   assert.equal(ui.document.querySelector('section[aria-label="Reliable Download progress"]'), null);
   assert(!ui.text().includes('Backup backup-tracker'));
   assert.match(ui.text(), /No admitted exports found/);
});

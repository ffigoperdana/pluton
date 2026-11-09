import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { downloadSnapshotItem } from '../src/utils/snapshotItemDownload.ts';
const require = createRequire(new URL('../package.json', import.meta.url));
const { JSDOM } = require('jsdom');
test('selected item uses only bounded HEAD then native browser GET, exact encoded path and cookies', async () => {
   const dom = new JSDOM('', { url: 'https://example.internal/' }),
      old = globalThis.fetch,
      descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
   Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
   const clicked: string[] = [];
   dom.window.HTMLAnchorElement.prototype.click = function () {
      clicked.push(this.href);
      assert.equal(this.download, '');
   };
   try {
      for (const directory of [false, true]) {
         globalThis.fetch = async (input, options) => {
            assert.equal(options?.method, 'HEAD');
            assert.equal(options?.credentials, 'include');
            assert.equal(options?.redirect, 'manual');
            const url = new URL(String(input));
            assert.equal(url.searchParams.get('path'), '/srv/report & file.txt');
            assert.equal(url.pathname, '/api/backups/backup-01/files/download');
            return new Response(null, {
               headers: {
                  'Content-Type': directory ? 'application/x-tar' : 'application/octet-stream',
                  'Content-Length': '7',
                  'Content-Disposition': 'attachment; filename="example.tar"',
               },
            });
         };
         await downloadSnapshotItem(
            'https://example.internal/api',
            'backup-01',
            '/srv/report & file.txt',
            directory,
            7,
            new AbortController().signal,
         );
      }
      assert.equal(clicked.length, 2);
      for (const status of [401, 403, 405, 409, 429, 502, 200]) {
         globalThis.fetch = async () => new Response(null, { status, headers: { 'Content-Type': 'text/html' } });
         await assert.rejects(downloadSnapshotItem('https://example.internal/api', 'backup-01', '/srv/a', false, 7, new AbortController().signal));
      }
      globalThis.fetch = async () =>
         new Response(null, {
            headers: {
               'Content-Type': 'application/octet-stream',
               'Content-Length': '7',
               'Content-Disposition': 'attachment; filename="example.txt"',
            },
         });
      const stop = new AbortController();
      stop.abort();
      await assert.rejects(downloadSnapshotItem('https://example.internal/api', 'backup-01', '/srv/a', false, 7, stop.signal));
      assert.equal(clicked.length, 2);
   } finally {
      globalThis.fetch = old;
      if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
      else Reflect.deleteProperty(globalThis, 'document');
      dom.window.close();
   }
});

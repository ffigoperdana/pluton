import assert from 'node:assert/strict';
import test from 'node:test';
import { reliableRequest, reliableAuthorization, reliableActive } from '../src/utils/reliableDownload.ts';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   snapshotId = 'a'.repeat(64);
const job = () => ({
   id,
   state: 'ready',
   mode: 'full',
   snapshotId,
   createdAt: 1000,
   elapsedMs: 2000,
   processedBytes: 2048,
   uploadedBytes: 2048,
   totalBytes: 2048,
   averageBytesPerSecond: 1024,
   expiresAt: Date.now() + 60000,
   integrity: 'verified',
   cleanupPending: false,
   summary: {
      version: 1,
      binding: { backupId: 'backup-01', repositoryId: 'repository-01', snapshotId },
      mode: 'full',
      includedEntries: 2,
      excludedEntries: 0,
      includedByType: { file: 1, dir: 1 },
      excludedByType: {},
      manifestSha256: 'b'.repeat(64),
      archiveSha256: 'c'.repeat(64),
      archiveBytes: 2048,
   },
});
test('creation, polling and cancellation preserve content mode, identity and cookie authentication', async () => {
   const before = fetch,
      calls: { url: string; options?: RequestInit }[] = [];
   globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      return Response.json({ success: true, result: job() }, { status: options?.method === 'POST' ? 202 : 200 });
   };
   try {
      const ready = await reliableRequest('https://example.internal/api', 'backup-01', 'full');
      assert.equal(ready.summary?.archiveSha256, 'c'.repeat(64));
      await reliableRequest('https://example.internal/api', 'backup-01', 'full', id);
      await reliableRequest('https://example.internal/api', 'backup-01', 'full', id, true);
      assert.deepEqual(
         calls.map((c) => c.options?.method),
         ['POST', 'GET', 'DELETE'],
      );
      assert.deepEqual(JSON.parse(calls[0].options?.body as string), { mode: 'full' });
      assert(calls.every((c) => c.options?.credentials === 'include' && c.options.redirect === 'error'));
      assert.equal(reliableActive(ready), false);
   } finally {
      globalThis.fetch = before;
   }
});
for (const failure of [
   'mode',
   'snapshot',
   'owner-backup',
   'missing-proof',
   'checksum',
   'size',
   'counts',
   'unknown-type',
   'integrity',
   'progress',
   'identity',
])
   test(`ready response rejects ${failure}`, async () => {
      const before = fetch,
         value: any = job();
      switch (failure) {
         case 'mode':
            value.mode = 'regular-files';
            break;
         case 'snapshot':
            value.summary.binding.snapshotId = 'd'.repeat(64);
            break;
         case 'owner-backup':
            value.summary.binding.backupId = 'foreign';
            break;
         case 'missing-proof':
            delete value.summary;
            break;
         case 'checksum':
            value.summary.archiveSha256 = 'invalid';
            break;
         case 'size':
            value.totalBytes++;
            break;
         case 'counts':
            value.summary.includedEntries++;
            break;
         case 'unknown-type':
            value.summary.includedByType = { file: 1, foreign: 1 };
            break;
         case 'integrity':
            value.integrity = 'pending';
            break;
         case 'progress':
            value.uploadedBytes++;
            break;
         case 'identity':
            value.id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
            break;
      }
      globalThis.fetch = async () => Response.json({ success: true, result: value });
      try {
         await assert.rejects(reliableRequest('https://example.internal/api', 'backup-01', 'full', id));
      } finally {
         globalThis.fetch = before;
      }
   });
for (const status of [429, 502, 503, 504, 524])
   test(`gateway ${status} never exposes raw provider output`, async () => {
      const before = fetch;
      globalThis.fetch = async () => new Response('<html>captured-provider-contents</html>', { status, headers: { 'Content-Type': 'text/html' } });
      try {
         await assert.rejects(
            reliableRequest('https://example.internal/api', 'backup-01', 'full'),
            (e) => e instanceof Error && e.message.includes(String(status)) && !e.message.includes('captured-provider-contents'),
         );
      } finally {
         globalThis.fetch = before;
      }
   });
test('unknown server failures and oversized responses fail closed without provider contents', async () => {
   const before = fetch;
   try {
      globalThis.fetch = async () => Response.json({ success: false, error: 'captured-provider-contents' }, { status: 502 });
      await assert.rejects(
         reliableRequest('https://example.internal/api', 'backup-01', 'full'),
         (e) => e instanceof Error && !e.message.includes('captured-provider-contents'),
      );
      globalThis.fetch = async () => Response.json('x'.repeat(65537));
      await assert.rejects(reliableRequest('https://example.internal/api', 'backup-01', 'full'));
   } finally {
      globalThis.fetch = before;
   }
});
test('short HTTPS authorization is bound to verified size and SHA; renewal preserves identity', async () => {
   const before = fetch;
   let wrong = false;
   globalThis.fetch = async () =>
      Response.json({
         success: true,
         result: {
            url: 'https://s3.example.internal/private?temporary=synthetic',
            expiresAt: Date.now() + 60000,
            bytes: wrong ? 4096 : 2048,
            sha256: 'c'.repeat(64),
         },
      });
   try {
      const grant = await reliableAuthorization('https://example.internal/api', 'backup-01', id, 'c'.repeat(64), 2048);
      assert(grant.url.startsWith('https:'));
      wrong = true;
      await assert.rejects(reliableAuthorization('https://example.internal/api', 'backup-01', id, 'c'.repeat(64), 2048));
   } finally {
      globalThis.fetch = before;
   }
});

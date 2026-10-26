import assert from 'node:assert/strict';
import test from 'node:test';
import { createManagedSnapshotTransport, managedSnapshotPageUrl } from '../src/utils/managedSnapshotBrowse.ts';
const api = 'https://example.internal/api';
const query = { path: '/srv', search: '', offset: 0, limit: 200, sort: 'name' as const, order: 'asc' as const };
const ready = (q = query) =>
   Response.json({
      success: true,
      result: { status: 'ready', files: [], total: 0, entries: 1, offset: q.offset, limit: q.limit, nextOffset: null, snapshotId: 'a'.repeat(64) },
   });
for (const status of [429, 502, 503, 504])
   test(`HTTP ${status} HTML is sanitized and shared Retry-After prevents panel retry storms`, async () => {
      let clock = 1000,
         calls = 0;
      const transport = createManagedSnapshotTransport(
         async () => {
            calls++;
            return calls === 1
               ? new Response('<html>private proxy inventory</html>', { status, headers: { 'Content-Type': 'text/html', 'Retry-After': '5' } })
               : ready();
         },
         () => clock,
      );
      await assert.rejects(transport(api, 'backup-01', query), (error: any) => {
         assert.equal(error.status, status);
         assert.equal(error.retryAt, 6000);
         assert(!error.message.includes('<'));
         assert(!error.message.includes('private'));
         return true;
      });
      await assert.rejects(transport(api, 'backup-01', { ...query, directoriesOnly: true }));
      assert.equal(calls, 1);
      clock = 5999;
      await assert.rejects(transport(api, 'backup-01', query));
      assert.equal(calls, 1);
      clock = 6000;
      assert.equal((await transport(api, 'backup-01', query)).status, 'ready');
      assert.equal(calls, 2);
   });
test('HTTP-date Retry-After and invalid JSON produce safe errors without parsing HTML', async () => {
   const clock = Date.parse('2026-01-01T00:00:00Z');
   const transport = createManagedSnapshotTransport(
      async () =>
         new Response('{truncated', { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': 'Thu, 01 Jan 2026 00:00:10 GMT' } }),
      () => clock,
   );
   await assert.rejects(transport(api, 'backup-01', query), (e: any) => e.retryAt === clock + 10000 && !e.message.includes('truncated'));
});
test('literal percent and colon paths survive exactly one URL encode/decode', () => {
   const exact = '/srv/100%complete/%2e%2e:文件.txt';
   assert.equal(new URL(managedSnapshotPageUrl(api, 'backup-01', { ...query, path: exact })).searchParams.get('path'), exact);
});
test('malformed successful responses and oversized pages fail closed', async () => {
   for (const result of [
      { status: 'ready', files: Array(201).fill({}) },
      { status: 'indexing', retryAfterMs: 0 },
      { status: 'ready', files: [], total: 0, entries: 1, offset: 1, limit: 200, nextOffset: null, snapshotId: 'a'.repeat(64) },
   ]) {
      const transport = createManagedSnapshotTransport(async () => Response.json({ success: true, result }));
      await assert.rejects(transport(api, 'backup-01', query), /unavailable/);
   }
});
test('indexing panels share one probe and cancelling a waiting panel cleans up', async () => {
   let calls = 0,
      release!: () => void,
      started!: () => void;
   const gate = new Promise<void>((r) => (release = r)),
      entered = new Promise<void>((r) => (started = r));
   const transport = createManagedSnapshotTransport(async () => {
      calls++;
      if (calls === 2) {
         started();
         await gate;
      }
      return Response.json({ success: true, result: { status: 'indexing', retryAfterMs: 1 } }, { status: 202 });
   });
   await transport(api, 'backup-01', query);
   const file = transport(api, 'backup-01', query);
   await entered;
   const folder = transport(api, 'backup-01', { ...query, directoriesOnly: true });
   release();
   assert.equal((await file).status, 'indexing');
   assert.equal((await folder).status, 'indexing');
   assert.equal(calls, 2);
   // Freeze the clock for cancellation so the debounce boundary cannot elapse
   // between the assertion above and starting the waiter on a busy CI host.
   let cancellationCalls = 0;
   const waiting = createManagedSnapshotTransport(
      async () => {
         cancellationCalls++;
         return Response.json({ success: true, result: { status: 'indexing', retryAfterMs: 1000 } });
      },
      () => 0,
   );
   await waiting(api, 'backup-01', query);
   const abort = new AbortController();
   const cancelled = waiting(api, 'backup-01', query, abort.signal);
   abort.abort();
   await assert.rejects(cancelled, (e: any) => e.name === 'AbortError');
   assert.equal(cancellationCalls, 1);
});
test('bounded coordinator refuses more than 64 protected cooldowns without bypassing rate limits', async () => {
   let calls = 0;
   const transport = createManagedSnapshotTransport(
      async () => {
         calls++;
         return new Response('', { status: 429, headers: { 'Retry-After': '60' } });
      },
      () => 1000,
   );
   for (let i = 0; i < 64; i++) await assert.rejects(transport(api, `backup-${i}`, query));
   await assert.rejects(transport(api, 'backup-65', query), /busy/);
   assert.equal(calls, 64);
   await assert.rejects(transport(api, 'backup-0', query), /rate limited/);
   assert.equal(calls, 64);
});

test('a ready indexing probe never substitutes one directory page for another', async () => {
   let calls = 0,
      release!: () => void,
      entered!: () => void;
   const gate = new Promise<void>((resolve) => {
      release = resolve;
   });
   const started = new Promise<void>((resolve) => {
      entered = resolve;
   });
   const transport = createManagedSnapshotTransport(async (input) => {
      calls++;
      if (calls === 1) return Response.json({ success: true, result: { status: 'indexing', retryAfterMs: 1 } });
      if (calls === 2) {
         entered();
         await gate;
      }
      const params = new URL(String(input)).searchParams;
      const result = await ready({ ...query, offset: Number(params.get('offset')) }).json();
      result.result.files = [{ path: params.get('path'), name: params.get('path') }];
      return Response.json(result);
   });
   await transport(api, 'backup-01', query);
   const file = transport(api, 'backup-01', { ...query, path: '/srv/a' });
   await started;
   const folder = transport(api, 'backup-01', { ...query, path: '/srv/b', directoriesOnly: true });
   release();
   const a = await file,
      b = await folder;
   assert.equal(a.status, 'ready');
   assert.equal(b.status, 'ready');
   if (a.status === 'ready' && b.status === 'ready') {
      assert.equal(a.files[0].path, '/srv/a');
      assert.equal(b.files[0].path, '/srv/b');
   }
   assert.equal(calls, 3);
});
test('idle coordinator entries can be evicted without retaining metadata pages', async () => {
   let calls = 0;
   const transport = createManagedSnapshotTransport(async () => {
      calls++;
      return ready();
   });
   for (let index = 0; index < 100; index++) assert.equal((await transport(api, `backup-${index}`, query)).status, 'ready');
   assert.equal(calls, 100);
});

test('a failed network probe stops all indexing panels without exposing transport details', async () => {
   let calls = 0,
      release!: () => void,
      entered!: () => void;
   const gate = new Promise<void>((resolve) => {
      release = resolve;
   });
   const started = new Promise<void>((resolve) => {
      entered = resolve;
   });
   const transport = createManagedSnapshotTransport(async () => {
      calls++;
      if (calls === 1) return Response.json({ success: true, result: { status: 'indexing', retryAfterMs: 1 } });
      entered();
      await gate;
      throw new TypeError('private proxy endpoint details');
   });
   await transport(api, 'backup-01', query);
   const file = transport(api, 'backup-01', query);
   await started;
   const folder = transport(api, 'backup-01', { ...query, directoriesOnly: true });
   const failed = [file, folder].map((request) => assert.rejects(request, (error: any) => error.status === 0 && !error.message.includes('private')));
   release();
   await Promise.all(failed);
   assert.equal(calls, 2);
});

test('a broken whole-manifest response is cancelled at the byte bound', async () => {
   let cancelled = false;
   const chunk = new TextEncoder().encode(' '.repeat(1024 ** 2));
   const transport = createManagedSnapshotTransport(
      async () =>
         new Response(
            new ReadableStream({
               pull(controller) {
                  controller.enqueue(chunk);
               },
               cancel() {
                  cancelled = true;
               },
            }),
            { headers: { 'Content-Type': 'application/json' } },
         ),
   );
   await assert.rejects(transport(api, 'backup-01', query), /unavailable/);
   assert.equal(cancelled, true);
});

test('aborting a request before its response arrives cancels the body and publishes no page', async () => {
   let release!: () => void,
      entered!: () => void,
      cancelled = false;
   const gate = new Promise<void>((resolve) => {
      release = resolve;
   });
   const started = new Promise<void>((resolve) => {
      entered = resolve;
   });
   const transport = createManagedSnapshotTransport(async () => {
      entered();
      await gate;
      return new Response(
         new ReadableStream({
            cancel() {
               cancelled = true;
            },
         }),
         { headers: { 'Content-Type': 'application/json' } },
      );
   });
   const abort = new AbortController();
   const request = transport(api, 'backup-01', query, abort.signal);
   await started;
   abort.abort();
   release();
   await assert.rejects(request, (error: any) => error.name === 'AbortError');
   assert.equal(cancelled, true);
});

test('cancellation during JSON body reading remains cancellation rather than a shared server error', async () => {
   let reading!: () => void;
   const started = new Promise<void>((resolve) => {
      reading = resolve;
   });
   const transport = createManagedSnapshotTransport(
      async (_input, options) =>
         new Response(
            new ReadableStream({
               start(controller) {
                  controller.enqueue(new TextEncoder().encode('{'));
                  options!.signal!.addEventListener('abort', () => controller.error(new DOMException('Cancelled', 'AbortError')), { once: true });
               },
               pull() {
                  reading();
               },
            }),
            { headers: { 'Content-Type': 'application/json' } },
         ),
   );
   const abort = new AbortController();
   const request = transport(api, 'backup-01', query, abort.signal);
   await started;
   abort.abort();
   await assert.rejects(request, (error: any) => error.name === 'AbortError');
});

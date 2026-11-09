import assert from 'node:assert/strict';
import test from 'node:test';
import { reliableRequest, reliableAuthorization, reliableActive, checkReliableContent } from '../src/utils/reliableDownload.ts';
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
test('optional telemetry rejects invalid counters and unknown fields without discarding valid job evidence', async () => {
   const before = fetch;
   globalThis.fetch = async () =>
      Response.json({
         success: true,
         result: {
            ...job(),
            performance: {
               phase: 'captured-provider-content',
               indexedEntries: -1,
               lastProgressAgeMs: 'private',
               privateKey: 'secret',
            },
         },
      });
   try {
      const result = await reliableRequest('https://example.internal/api', 'backup-01', 'full', id);
      assert.equal(result.state, 'ready');
      assert.equal(result.performance?.indexedEntries, undefined);
      assert(!JSON.stringify(result.performance).includes('private'));
      assert(!JSON.stringify(result.performance).includes('captured'));
   } finally {
      globalThis.fetch = before;
   }
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
test('verification/cleanup diagnostics discard raw provider fields and bound timings independently of job proof', async () => {
   const before = fetch;
   globalThis.fetch = async () =>
      Response.json({
         success: true,
         result: {
            ...job(),
            verificationFailure: {
               operation: 'GetObject',
               phase: 'ciphertext-body',
               outcome: 'transport',
               category: 'network-or-deadline',
               providerCategory: 'network',
               providerCode: 'captured-private',
               responseKind: 'transport-error',
               httpStatus: 206,
               attempts: 2,
               elapsedMs: Infinity,
               wireBytesRead: -1,
               objectKey: 'captured-private',
               rawXml: 'captured-private',
            },
            cleanupFailure: { operation: 'captured-private', category: 'captured-private', providerCategory: 'captured-private' },
         },
      });
   try {
      const result = await reliableRequest('https://example.internal/api', 'backup-01', 'full', id);
      assert.equal(result.verificationFailure?.attempts, 2);
      assert.equal(result.verificationFailure?.httpStatus, 206);
      assert.equal(result.verificationFailure?.wireBytesRead, undefined);
      assert.equal(result.cleanupFailure?.operation, 'unknown');
      assert(!JSON.stringify(result).includes('captured-private'));
   } finally {
      globalThis.fetch = before;
   }
});
test('application-encrypted responses retain original TAR proof and require authenticated proxy transport', async () => {
   const before = fetch;
   const value: any = {
      ...job(),
      integrityMode: 'application-encrypted-hcp',
      confidentiality: 'application-encrypted',
      transport: 'authenticated-proxy',
   };
   globalThis.fetch = async () => Response.json({ success: true, result: value });
   try {
      const result = await reliableRequest('https://example.internal/api', 'backup-01', 'full', id);
      assert.equal(result.totalBytes, 2048);
      assert.equal(result.summary?.archiveSha256, 'c'.repeat(64));
      value.transport = 'versioned-presigned-and-proxy';
      await assert.rejects(reliableRequest('https://example.internal/api', 'backup-01', 'full', id));
      value.transport = 'authenticated-proxy';
      value.confidentiality = 'provider-sse-s3';
      await assert.rejects(reliableRequest('https://example.internal/api', 'backup-01', 'full', id));
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
test('nonversioned authorization permits only the exact authenticated same-origin proxy', async () => {
   const before = fetch;
   let url = `/api/backups/backup-01/exports/${id}/content`;
   globalThis.fetch = async () =>
      Response.json({
         success: true,
         result: { transport: 'authenticated-proxy', url, expiresAt: Date.now() + 60000, bytes: 2048, sha256: 'c'.repeat(64) },
      });
   try {
      const grant = await reliableAuthorization('https://example.internal/api', 'backup-01', id, 'c'.repeat(64), 2048);
      assert.equal(grant.url, `https://example.internal${url}`);
      assert.equal(grant.transport, 'authenticated-proxy');
      for (url of [
         'https://foreign.example/content',
         '//foreign.example/content',
         '/api/backups/foreign/exports/' + id + '/content',
         `/api/backups/backup-01/exports/${id}/content?override=yes`,
      ]) {
         await assert.rejects(reliableAuthorization('https://example.internal/api', 'backup-01', id, 'c'.repeat(64), 2048));
      }
   } finally {
      globalThis.fetch = before;
   }
});

const contentHeaders = () => ({
   'Content-Type': 'application/x-tar',
   'Content-Disposition': 'attachment; filename="backup-example.tar"',
   'Content-Length': '2048',
   'X-Archive-SHA256': 'c'.repeat(64),
   ETag: `"sha256-${'c'.repeat(64)}"`,
   'Accept-Ranges': 'bytes',
});
test('authorization redirect is explicit and permanent; malformed grants never become connection errors', async () => {
   const before = fetch;
   try {
      for (const result of [undefined, null, 'private-response', {}, { url: 42 }]) {
         globalThis.fetch = async () => Response.json({ success: true, result });
         await assert.rejects(reliableAuthorization('https://example.internal/api', 'backup-01', id, 'c'.repeat(64), 2048),
            (e: any) => e.kind === 'protocol' && !e.transient && !e.message.includes('private-response'));
      }
      globalThis.fetch = async (_url, options) => {
         assert.equal(options?.redirect, 'manual');
         return new Response(null, { status: 303, headers: { Location: '/login' } });
      };
      await assert.rejects(reliableAuthorization('https://example.internal/api', 'backup-01', id, 'c'.repeat(64), 2048),
         (e: any) => e.kind === 'protocol' && !e.transient && e.message.includes('redirected unexpectedly'));
   } finally { globalThis.fetch = before; }
});
test('native proxy precheck uses HEAD only, session cookies, no cache, and never follows an ingress redirect', async () => {
   const before = fetch;
   globalThis.fetch = async (_url, options) => {
      assert.equal(options?.method, 'HEAD');
      assert.equal(options?.credentials, 'include');
      assert.equal(options?.redirect, 'manual');
      assert.equal(options?.cache, 'no-store');
      return new Response(null, { headers: contentHeaders() });
   };
   try { await checkReliableContent('https://example.internal/api/content', 'c'.repeat(64), 2048); }
   finally { globalThis.fetch = before; }
});
for (const field of Object.keys(contentHeaders()))
   test(`native proxy precheck rejects missing or changed ${field}`, async () => {
      const before = fetch;
      try {
         for (const value of [undefined, 'private-gateway-body']) {
            const headers: Record<string, string> = contentHeaders();
            if (value === undefined) delete headers[field]; else headers[field] = value;
            globalThis.fetch = async () => new Response(null, { headers });
            await assert.rejects(checkReliableContent('https://example.internal/api/content', 'c'.repeat(64), 2048), (e: Error) =>
               e.message.includes('metadata could not be verified') && !e.message.includes('private-gateway-body'));
         }
      } finally { globalThis.fetch = before; }
   });
for (const status of [200, 206, 303, 401, 403, 405, 409, 416, 429, 503])
   test(`native proxy precheck rejects HTML/redirect or failed HTTP ${status} without exposing it`, async () => {
      const before = fetch;
      globalThis.fetch = async () => new Response(null, { status, headers: { 'Content-Type': 'text/html', Location: '/login' } });
      try { await assert.rejects(checkReliableContent('https://example.internal/api/content', 'c'.repeat(64), 2048)); }
      finally { globalThis.fetch = before; }
   });

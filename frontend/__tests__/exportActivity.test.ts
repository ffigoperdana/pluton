import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../backend/package.json', import.meta.url));
const output = await require('esbuild').build({
   stdin: {
      contents:
         "export * from './src/utils/exportActivity'; export * from './src/utils/downloadFailure'; export * from './src/utils/reliableDownload';",
      resolveDir: fileURLToPath(new URL('../', import.meta.url)),
      loader: 'ts',
   },
   bundle: true,
   platform: 'node',
   format: 'cjs',
   write: false,
});
const module = { exports: {} as any };
new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, module, module.exports);
const { ExportActivityManager, DownloadFailure, reliableRequest, readExportActivity } = module.exports;
const go = {
   configured: true,
   sharedNamespaceEnabled: true,
   keyringConfigured: true,
   exportMode: 'application-encrypted-hcp',
   preflight: 'GO',
   admissionAllowed: true,
   reason: 'ready',
};
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const job = (state = 'uploading') => ({
   id,
   state,
   mode: 'full',
   snapshotId: 'a'.repeat(64),
   createdAt: 1000,
   elapsedMs: 1000,
   processedBytes: 1024,
   uploadedBytes: 0,
   averageBytesPerSecond: 0,
   integrity: 'pending',
   cleanupPending: false,
});
const item = (value = job()) => ({ backupId: 'backup-01', planId: 'plan-01', job: value });
const flush = async () => {
   for (let n = 0; n < 12; n++) await Promise.resolve();
};

test('confirmed static HCP configuration without GO yields actionable HTTP 409 policy denial, not connectivity', async (t) => {
   t.mock.method(globalThis, 'fetch', async () =>
      Response.json({ success: false, reason: 'security-capability-missing', error: 'private-provider-body' }, { status: 409 }),
   );
   await assert.rejects(reliableRequest('/api', 'backup-01', 'full'), (e: any) => {
      assert.equal(e.status, 409);
      assert.equal(e.reason, 'security-capability-missing');
      assert.equal(e.transient, false);
      assert.equal(e.kind, 'policy');
      assert.match(e.message, /preflight/);
      assert(!e.message.includes('private-provider'));
      return true;
   });
});
for (const [status, transient, kind] of [
   [401, false, 'authentication'],
   [403, false, 'permission'],
   [405, false, 'protocol'],
   [429, true, 'rate-limit'],
   [502, true, 'transport'],
   [503, true, 'transport'],
   [524, true, 'transport'],
   [200, false, 'protocol'],
] as const)
   test('HTTP ' + status + ' non-JSON/WAF is classified without exposing contents', async (t) => {
      t.mock.method(globalThis, 'fetch', async () => new Response('<html>private-gateway</html>', { status, headers: { 'Retry-After': '10' } }));
      await assert.rejects(reliableRequest('/api', 'backup-01', 'full'), (e: any) => {
         assert.equal(e.status, status);
         assert.equal(e.transient, transient);
         assert.equal(e.kind, kind);
         assert(!e.message.includes('private-gateway'));
         if (status === 429) assert(e.retryAt > Date.now());
         return true;
      });
   });
for (const reason of ['security-capability-missing', 'configuration-invalid', 'not-configured', 'quota-exceeded', 'queue-full'])
   test('known policy reason never becomes a retryable server error: ' + reason, async (t) => {
      t.mock.method(globalThis, 'fetch', async () => Response.json({ success: false, reason }, { status: reason === 'not-configured' ? 503 : 409 }));
      await assert.rejects(reliableRequest('/api', 'backup-01', 'full'), (e: any) => !e.transient && e.reason === reason);
   });
test('missing/expired/superseded GO and cleanup NO-GO never admit or create fake activity, even on manual refresh', async (t) => {
   t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
   for (const reason of ['preflight-required', 'preflight-expired', 'preflight-superseded', 'cleanup-pending', 'destination-mismatch']) {
      let posts = 0,
         reads = 0;
      const manager = new ExportActivityManager(
         '/api',
         () => {},
         async () => {
            reads++;
            return { readiness: { ...go, reason, preflight: 'NO-GO', admissionAllowed: false }, jobs: [] };
         },
         async () => {
            posts++;
            throw new Error('Must not run');
         },
      );
      manager.start();
      await manager.refresh();
      await manager.admit('backup-01', 'full');
      assert.equal(posts, 0);
      assert.equal(manager.snapshot().jobs.length, 0);
      assert.equal(Object.values(manager.snapshot().denials).length, 1);
      const before = reads;
      t.mock.timers.tick(120000);
      await flush();
      assert.equal(reads, before);
      await manager.refresh();
      assert.equal(posts, 0);
      manager.stop();
   }
});
test('fresh GO allows one deliberate admission; same-tab double action and reload discovery never duplicate jobs', async (t) => {
   t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
   let rows: any[] = [],
      posts = 0;
   const read = async () => ({ readiness: go, jobs: rows });
   const request = async () => {
      posts++;
      rows = [item()];
      return job();
   };
   const manager = new ExportActivityManager('/api', () => {}, read, request);
   manager.start();
   await manager.refresh();
   await Promise.all([manager.admit('backup-01', 'full'), manager.admit('backup-01', 'full')]);
   await flush();
   assert.equal(posts, 1);
   assert.equal(manager.snapshot().jobs.length, 1);
   await manager.admit('backup-01', 'full');
   assert.equal(posts, 1);
   manager.stop();
   const reloaded = new ExportActivityManager('/api', () => {}, read, request);
   reloaded.start();
   await reloaded.refresh();
   assert.equal(reloaded.find('backup-01', 'full').id, id);
   assert.equal(posts, 1);
   assert.equal(reloaded.find('different-backup', 'full'), undefined);
   assert.equal(reloaded.find('backup-01', 'regular-files'), undefined);
   reloaded.stop();
});
test('lost POST response is reconciled with GET only, never retried in background', async (t) => {
   t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
   let rows: any[] = [],
      posts = 0;
   const manager = new ExportActivityManager(
      '/api',
      () => {},
      async () => ({ readiness: go, jobs: rows }),
      async () => {
         posts++;
         rows = [item()];
         throw new TypeError('network');
      },
   );
   manager.start();
   await manager.refresh();
   await manager.admit('backup-01', 'full');
   await flush();
   t.mock.timers.tick(10000);
   await flush();
   assert.equal(posts, 1);
   assert.equal(manager.snapshot().jobs[0].job.id, id);
   manager.stop();
});
test('a lost admission response can precede the server commit: bounded GET reconciliation discovers it without another POST', async t => {
   t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
   let rows: any[] = [], posts = 0, reads = 0;
   const manager = new ExportActivityManager('/api', () => {}, async () => {
      reads++; return { readiness: go, jobs: rows };
   }, async () => { posts++; throw new TypeError('response lost before durable admission became visible'); });
   manager.start(); await manager.refresh();
   await manager.admit('backup-01', 'full'); await flush();
   assert.deepEqual(manager.snapshot().jobs, []);
   rows = [item()];
   t.mock.timers.tick(2000); await flush();
   assert.equal(manager.snapshot().jobs[0].job.id, id); assert.equal(posts, 1);
   manager.stop();
   rows = [];
   manager.start(); await manager.refresh(); await manager.admit('backup-01', 'full'); await flush();
   for (let n = 0; n < 16; n++) { t.mock.timers.tick(2000); await flush(); }
   const before = reads; t.mock.timers.tick(60000); await flush();
   assert.equal(reads, before); assert.equal(posts, 2); assert.deepEqual(manager.snapshot().jobs, []);
   manager.stop();
});
test('cross-tab invalidations only rediscover server state; concurrent callers share the server-admitted identity', async (t) => {
   t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
   let rows: any[] = [],
      created = 0;
   const read = async () => ({ readiness: go, jobs: rows });
   const request = async () => {
      if (!rows.length) {
         created++;
         rows = [item()];
      }
      return rows[0].job;
   };
   const a = new ExportActivityManager('/api', () => {}, read, request),
      b = new ExportActivityManager('/api', () => {}, read, request);
   a.start();
   b.start();
   await Promise.all([a.refresh(), b.refresh()]);
   await Promise.all([a.admit('backup-01', 'full'), b.admit('backup-01', 'full')]);
   await flush();
   await b.refresh();
   assert.equal(created, 1);
   assert.equal(a.snapshot().jobs[0].job.id, b.snapshot().jobs[0].job.id);
   a.stop();
   b.stop();
});
test('auth/permission failures clear owner state, stop retries and rediscover only the new authenticated owner on explicit check', async (t) => {
   t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
   let auth = true,
      reads = 0;
   const manager = new ExportActivityManager(
      '/api',
      () => {},
      async () => {
         reads++;
         if (!auth) throw new DownloadFailure('Sign in again', 'authentication', false, 401);
         return { readiness: go, jobs: [item()] };
      },
   );
   manager.start();
   await manager.refresh();
   auth = false;
   await manager.refresh();
   assert.equal(manager.snapshot().jobs.length, 0);
   assert.equal(manager.snapshot().readiness, undefined);
   const before = reads;
   t.mock.timers.tick(120000);
   await flush();
   assert.equal(reads, before);
   auth = true;
   await manager.refresh();
   assert.equal(manager.snapshot().jobs.length, 1);
   manager.stop();
});
test('transient backoff respects Retry-After and prevents overlapping reads; terminal cleanup stops polls', async (t) => {
   t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
   let reads = 0,
      failed = true,
      cleanup = true;
   const manager = new ExportActivityManager(
      '/api',
      () => {},
      async () => {
         reads++;
         if (failed) throw new DownloadFailure('Rate limit', 'rate-limit', true, 429, undefined, 11000);
         return { readiness: go, jobs: [item({ ...job('cancelled'), cleanupPending: cleanup })] };
      },
   );
   manager.start();
   await manager.refresh();
   failed = false;
   t.mock.timers.tick(9999);
   await flush();
   assert.equal(reads, 1);
   await manager.refresh();
   assert.equal(reads, 1);
   t.mock.timers.tick(1);
   await flush();
   assert.equal(reads, 2);
   cleanup = false;
   t.mock.timers.tick(2000);
   await flush();
   const before = reads;
   t.mock.timers.tick(120000);
   await flush();
   assert.equal(reads, before);
   manager.stop();
});
test('stale discovery cannot resurrect a cancelled job; cancellation failure is never auto-retried', async (t) => {
   t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
   let stale: ((v: any) => void) | undefined,
      slow = false,
      deletes = 0;
   let rows: any[] = [item()];
   const manager = new ExportActivityManager(
      '/api',
      () => {},
      async () =>
         slow
            ? new Promise((resolve) => {
                 stale = resolve;
              })
            : { readiness: go, jobs: rows },
      async () => {
         deletes++;
         rows = [item({ ...job('cancelled'), cleanupPending: true })];
         return rows[0].job;
      },
   );
   manager.start();
   await manager.refresh();
   slow = true;
   const pending = manager.refresh();
   assert.equal(manager.refresh(), pending);
   await manager.cancel('backup-01', 'full', id);
   stale!({ readiness: go, jobs: [item()] });
   await pending;
   assert.equal(manager.snapshot().jobs[0].job.state, 'cancelled');
   assert.equal(deletes, 1);
   manager.stop();
});
test('a cross-tab invalidation discards an older in-flight GET and checks the server again before showing completion', async t => {
   t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
   let release: ((value: unknown) => void) | undefined, slow = false;
   let rows = [item()];
   const manager = new ExportActivityManager('/api', () => {}, async () =>
      slow ? new Promise(resolve => { release = resolve; }) : { readiness: go, jobs: rows });
   manager.start(); await manager.refresh();
   slow = true; const pending = manager.refresh();
   rows = [item(job('cancelled'))]; slow = false;
   void manager.invalidate(); // Another tab confirmed its cancellation.
   release!({ readiness: go, jobs: [item(job('ready'))] }); await pending;
   assert.equal(manager.snapshot().jobs[0].job.state, 'uploading');
   t.mock.timers.tick(1000); await flush();
   assert.equal(manager.snapshot().jobs[0].job.state, 'cancelled');
   manager.stop();
});
test('raw GET activity validates owner response identities and never posts or probes', async (t) => {
   const methods: string[] = [];
   t.mock.method(globalThis, 'fetch', async (_url, options) => {
      methods.push(options?.method || 'GET');
      return Response.json({ success: true, result: { readiness: go, jobs: [item()] } });
   });
   assert.equal((await readExportActivity('/api', new AbortController().signal)).jobs[0].job.id, id);
   assert.deepEqual(methods, ['GET']);
});
test('admission Retry-After also bounds explicit repeated clicks without any automatic POST replay', async t => {
   t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
   let posts = 0;
   const manager = new ExportActivityManager('/api', () => {}, async () => ({ readiness: go, jobs: [] }),
      async () => { posts++; throw new DownloadFailure('Rate limited', 'rate-limit', true, 429, undefined, 11000); });
   manager.start(); await manager.refresh();
   await manager.admit('backup-01', 'full'); await flush();
   await manager.admit('backup-01', 'full'); assert.equal(posts, 1);
   t.mock.timers.tick(10000); await flush(); assert.equal(posts, 1);
   await manager.admit('backup-01', 'full'); assert.equal(posts, 2);
   manager.stop();
});
test('a session epoch reset discards a late response from the prior owner and recovers only current server jobs', async t => {
   t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
   let release: ((value: unknown) => void) | undefined;
   let delayed = false;
   const manager = new ExportActivityManager('/api', () => {}, async () =>
      delayed ? new Promise(resolve => { release = resolve; }) : { readiness: go, jobs: [] });
   manager.start(); await manager.refresh();
   delayed = true; const old = manager.refresh();
   manager.stop();
   delayed = false; manager.start(); await manager.refresh();
   release!({ readiness: go, jobs: [item()] }); await old;
   assert.deepEqual(manager.snapshot().jobs, []);
   assert.equal(manager.snapshot().loaded, true); manager.stop();
});
test('cancellation transport failure has one DELETE only and remains actionable while GET polling continues', async t => {
   t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
   let deletes = 0;
   const manager = new ExportActivityManager('/api', () => {}, async () => ({ readiness: go, jobs: [item()] }),
      async () => { deletes++; throw new TypeError('connection lost'); });
   manager.start(); await manager.refresh();
   await manager.cancel('backup-01', 'full', id); await flush();
   assert.equal(deletes, 1);
   assert.match(Object.values(manager.snapshot().denials)[0].message, /Connection interrupted/);
   t.mock.timers.tick(30000); await flush();
   assert.equal(deletes, 1); manager.stop();
});
test('readiness exposes only whitelisted diagnostic categories, never captured private metadata', async t => {
   t.mock.method(globalThis, 'fetch', async () => Response.json({ success: true, result: { jobs: [], readiness: {
      ...go, preflight: 'NO-GO', admissionAllowed: false, reason: 'provider-checks-failed', latest: {
         id, state: 'failed', cleanupPending: true, privateKey: 'captured-private-value',
         preflightFailure: { operation: 'CompleteMultipartUpload', category: 'unexpected-response', providerCategory: 'invalid-response', httpStatus: 200 },
         cleanupFailure: { operation: 'captured-private-value', category: 'captured-private-value', providerCategory: 'captured-private-value' },
      },
   } } }));
   const result = await readExportActivity('/api', new AbortController().signal);
   assert.equal(result.readiness.latest.preflightFailure.httpStatus, 200);
   assert.equal(result.readiness.latest.cleanupFailure.operation, 'unknown');
   assert(!JSON.stringify(result).includes('captured-private-value'));
});

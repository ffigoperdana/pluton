import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
   recoveryRequestId,
   recoveryCanApprove,
   recoveryPolling,
   recoveryStatus,
   recoveryRetrySummary,
   recoveryFailureAdvice,
   recoveryDecision,
   recoverySteps,
   type AssistedRecoveryJob,
} from '../src/utils/assistedRecovery.ts';
const require = createRequire(new URL('../package.json', import.meta.url)),
   backendRequire = createRequire(new URL('../../backend/package.json', import.meta.url));
const React = require('react'),
   { act } = React,
   { JSDOM } = require('jsdom'),
   { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const bundle = await backendRequire('esbuild').build({
   entryPoints: [fileURLToPath(new URL('../src/components/Restore/AssistedRecovery/AssistedRecovery.tsx', import.meta.url))],
   bundle: true,
   platform: 'node',
   format: 'cjs',
   jsx: 'automatic',
   write: false,
   external: ['react', 'react/jsx-runtime', '@tanstack/react-query'],
   plugins: [
      {
         name: 'fixture-api',
         setup(builder: any) {
            builder.onLoad({ filter: /constants[.]ts$/ }, () => ({ contents: 'export const API_URL="https://example.internal/api";', loader: 'js' }));
            // Styles are presentation only; class names resolve to their own keys.
            builder.onLoad({ filter: /[.]scss$/ }, () => ({ contents: 'export default new Proxy({}, {get:(_,key)=>String(key)});', loader: 'js' }));
         },
      },
   ],
});
const compiled = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, compiled, compiled.exports);
const Panel = (compiled.exports as any).default;
const row = (patch: Partial<AssistedRecoveryJob> = {}): AssistedRecoveryJob => ({
   id: 'a'.repeat(24),
   planId: 'plan-01',
   backupId: 'backup-01',
   status: 'awaiting-approval',
   phase: 'awaiting-approval',
   createdAt: Date.now(),
   expiresAt: Date.now() + 600000,
   expired: false,
   sourceSnapshotId: 'b'.repeat(64),
   primary: { state: 'unavailable', code: 'network-unavailable' },
   candidates: [
      {
         replicationId: 'replica-01',
         position: 1,
         state: 'passed',
         destinationSnapshotId: 'd'.repeat(64),
         replicaVerified: true,
         recoveryPreflight: 'passed',
         recoveryTested: false,
      },
   ],
   target: 'Isolated Pluton staging',
   operation: 'File/directory/SQL artifact staging (no database import)',
   includes: [],
   excludes: [],
   cleanupPending: false,
   audit: [],
   ...patch,
});
async function mount(fetcher: typeof fetch, manual = true, strict = false, initialIncludes: string[] = [], extra: Record<string, unknown> = {}) {
   const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.internal' });
   const globals = ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'fetch', 'IS_REACT_ACT_ENVIRONMENT', 'BroadcastChannel'];
   const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
   class Channel {
      onmessage: any;
      constructor(_name: string) {}
      postMessage(_value: unknown) {}
      close() {}
   }
   for (const key of globals)
      Object.defineProperty(globalThis, key, {
         configurable: true,
         writable: true,
         value:
            key === 'fetch' ? fetcher : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : key === 'BroadcastChannel' ? Channel : (dom.window as any)[key],
      });
   const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
   let primaryReady = 0,
      closed = 0;
   const root = require('react-dom/client').createRoot(dom.window.document.getElementById('root'));
   const waitFor = async (check: () => unknown, label: string) => {
      const deadline = Date.now() + 2500;
      do {
         await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
         });
         if (check()) return;
      } while (Date.now() < deadline);
      assert.fail('Timed out: ' + label + ' ' + dom.window.document.body.textContent);
   };
   const button = (name: string) =>
      [...dom.window.document.querySelectorAll('button')].find((element: any) => element.textContent === name) as HTMLButtonElement | undefined;
   await act(async () => {
      function Host() {
         const [, setHandoffs] = React.useState(0);
         return React.createElement(Panel, {
            planId: 'plan-01',
            backupId: 'backup-01',
            manual,
            initialIncludes,
            ...extra,
            onPrimaryReady: () => {
               primaryReady++;
               setHandoffs((value: number) => value + 1);
            },
            close: () => closed++,
         });
      }
      const panel = React.createElement(Host);
      root.render(React.createElement(QueryClientProvider, { client }, strict ? React.createElement(React.StrictMode, {}, panel) : panel));
   });
   return {
      dom,
      client,
      waitFor,
      button,
      primaryReady: () => primaryReady,
      closed: () => closed,
      async click(name: string) {
         await waitFor(() => button(name) && !button(name)!.disabled, name);
         await act(async () => button(name)!.click());
      },
      async close() {
         await act(async () => root.unmount());
         client.clear();
         dom.window.close();
         for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete (globalThis as any)[key];
         }
      },
   };
}
function server(initial: AssistedRecoveryJob[] = []) {
   let jobs = initial;
   const calls: { method: string; path: string; body: any }[] = [];
   const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input)),
         method = init?.method || 'GET',
         body = init?.body ? JSON.parse(String(init.body)) : undefined;
      assert.equal(init?.credentials, 'include');
      calls.push({ method, path: url.pathname, body });
      if (method === 'GET') return Response.json({ success: true, result: jobs });
      if (url.pathname.endsWith('/approve')) {
         jobs = [{ ...jobs[0], status: 'running', phase: 'staged-restore' }];
         return Response.json({ success: true, result: jobs[0] }, { status: 202 });
      }
      if (url.pathname.endsWith('/cancel')) {
         jobs = [{ ...jobs[0], status: 'cancelled' }];
         return Response.json({ success: true, result: jobs[0] });
      }
      jobs = [row({ includes: body.includes || [] })];
      return Response.json({ success: true, result: jobs[0] }, { status: 202 });
   };
   return {
      fetcher,
      calls,
      get: () => jobs,
      set: (value: AssistedRecoveryJob[]) => {
         jobs = value;
      },
   };
}
test('approval and polling distinguish pending, expiry, verified completion and cleanup', () => {
   assert.equal(recoveryCanApprove(row(), 'replica-01'), true);
   assert.equal(recoveryCanApprove(row({ expired: true }), 'replica-01'), false);
   assert.equal(recoveryCanApprove(row({ status: 'running' }), 'replica-01'), false);
   assert.equal(recoveryPolling([row({ status: 'running' })]), 3000);
   assert.equal(recoveryPolling([row({ status: 'completed' })]), false);
   assert.match(recoveryStatus(row()), /No restore has started/);
   assert.match(recoveryStatus(row({ status: 'uncertain' })), /not restart automatically/);
   assert.match(recoveryStatus(row({ status: 'failed', cleanupPending: true })), /cleanup needs attention/);
});
test('rediscovered active progress shows elapsed time and stops spinning on a diagnosed failure', async () => {
   const checking = row({ status: 'checking', phase: 'replica-check', createdAt: Date.now() - 3500 });
   const s = server([checking]);
   const ui = await mount(s.fetcher);
   const content = () => ui.dom.window.document.body.textContent || '';
   const spinner = () => ui.dom.window.document.querySelector('[data-recovery-spinner]');
   try {
      await ui.waitFor(() => spinner() && /Replica check/.test(content()) && /Elapsed/.test(content()), 'active checking progress');
      assert.equal(spinner()?.getAttribute('aria-hidden'), 'true');
      assert.match(content(), /Closing this window does not cancel server work/);
      s.set([
         {
            ...row({ status: 'running', phase: 'integrity-preparation' }),
            activity: 'awaiting-archive-output',
            activeSince: Date.now() - 4000,
         } as AssistedRecoveryJob,
      ]);
      await ui.click('Refresh recovery status');
      await ui.waitFor(() => /Waiting for the repository read to produce archive data/.test(content()), 'waiting for archive output');
      assert.ok(spinner());
      assert.equal(ui.dom.window.document.querySelector('progress'), null);
      for (const [patch, message] of [
         [{ phase: 'integrity-preparation', activity: 'validating-archive-output' }, /Reading archive data/],
         [{ phase: 'integrity-preparation', activity: 'archive-output-paused' }, /No recent archive output/],
         [{ phase: 'integrity-preparation', activity: 'archive-backend-retrying' }, /Restic is retrying a repository read/],
         [{ phase: 'filesystem-validation' }, /Verifying staged files/],
         [{ phase: 'staging-cleanup' }, /Cleaning up temporary recovery resources/],
      ] as const) {
         s.set([row({ status: 'running', ...patch } as Partial<AssistedRecoveryJob>)]);
         await ui.click('Refresh recovery status');
         await ui.waitFor(() => message.test(content()), String(message));
         assert.ok(spinner());
      }
      s.set([
         {
            ...row({ status: 'failed', phase: 'recovery-stopped', failureCode: 'timeout' }),
            diagnostic: {
               phase: 'integrity-preparation',
               operation: 'archive-readback',
               timeoutCategory: 'archive-output-idle',
               elapsedMs: 600010,
               failureCode: 'timeout',
            },
         } as AssistedRecoveryJob,
      ]);
      await ui.click('Refresh recovery status');
      await ui.waitFor(() => /archive-output-idle/.test(content()), 'safe failure diagnostic');
      assert.equal(spinner(), null);
      assert.match(content(), /Archive stream stalled/);
      assert.match(content(), /Review.*storage/i);
      assert.ok(s.calls.every((call) => call.method === 'GET'));
   } finally {
      await ui.close();
   }
});

const retryDiagnostic = {
   phase: 'integrity-preparation',
   operation: 'archive-readback',
   timeoutCategory: 'archive-backend-retrying',
   elapsedMs: 600010,
   failureCode: 'timeout',
   archive: {
      backendRetries: {
         retryCount: 12,
         gaveUpCount: 0,
         recoveredCount: 0,
         serverErrorCount: 12,
         errorClasses: { 'unexpected-eof': 12 },
         loads: [{ objectType: 'data', packPrefix: '00e0e0ca8b', length: 13960, offset: 2605056, attempts: 12, lastErrorClass: 'unexpected-eof' }],
         lastRetryAfterMs: 61000,
         lastServedBytes: 2875,
         lastExpectedBytes: 13960,
      },
   },
};

test('a backend retry loop reads as retries with the retried object, not as a silent stall', async () => {
   const failed = { ...row({ status: 'failed', phase: 'recovery-stopped', failureCode: 'timeout' }), diagnostic: retryDiagnostic } as AssistedRecoveryJob;
   assert.equal(recoveryStatus(failed), 'Restic kept retrying a repository read. Recovery stopped after the inactivity limit.');
   assert.match(recoveryFailureAdvice(failed), /retried repository object/);
   const s = server([failed]);
   const ui = await mount(s.fetcher);
   const content = () => ui.dom.window.document.body.textContent || '';
   try {
      await ui.waitFor(() => /archive-backend-retrying/.test(content()), 'retry diagnostic');
      assert.match(content(), /Restic kept retrying a repository read/);
      assert.match(
         content(),
         /Restic retried a repository read 12 times · data pack 00e0e0ca8b at byte 2,605,056 \(13,960 bytes\) · last error: response ended early · server sent 2,875 of 13,960 bytes/
      );
      assert.doesNotMatch(content(), /Archive stream stalled/);
   } finally {
      await ui.close();
   }
});

test('retry summary wording covers singular counts, HTTP status, give-ups and missing data', () => {
   assert.equal(recoveryRetrySummary(undefined), undefined);
   assert.equal(recoveryRetrySummary({ ...retryDiagnostic, archive: {} }), undefined);
   const none = { ...retryDiagnostic.archive.backendRetries, retryCount: 0, serverErrorCount: 0, loads: [] };
   assert.equal(recoveryRetrySummary({ ...retryDiagnostic, archive: { backendRetries: none } }), undefined);
   const once = {
      ...none,
      retryCount: 1,
      gaveUpCount: 1,
      loads: [{ objectType: 'index', packPrefix: 'abcdef0123', attempts: 1, lastErrorClass: 'http-status', httpStatus: 503 }],
      lastServedBytes: undefined,
      lastExpectedBytes: undefined,
   };
   assert.equal(
      recoveryRetrySummary({ ...retryDiagnostic, archive: { backendRetries: once } }),
      'Restic retried a repository read 1 time · index pack abcdef0123 · last error: HTTP error (HTTP 503) · gave up 1 time'
   );
});

const replicaCandidates = [
   {
      replicationId: 'replica-01',
      position: 1,
      state: 'passed' as const,
      destinationSnapshotId: 'd'.repeat(64),
      replicaVerified: true,
      recoveryPreflight: 'passed',
      recoveryTested: false,
   },
   {
      replicationId: 'replica-02',
      position: 2,
      state: 'passed' as const,
      destinationSnapshotId: 'e'.repeat(64),
      replicaVerified: true,
      recoveryPreflight: 'passed',
      recoveryTested: true,
   },
];
const automaticCompleted = (): AssistedRecoveryJob =>
   row({
      status: 'completed',
      phase: 'integrity-verified',
      policy: 'automatic',
      primary: { state: 'unavailable', code: 'network-unavailable' },
      candidates: replicaCandidates,
      selected: 'replica-02',
      sourceSelection: {
         mode: 'automatic',
         reason: 'network-unavailable',
         attempts: [
            { replicationId: 'replica-01', position: 1, outcome: 'failed', code: 'timeout', at: Date.now() - 2000 },
            { replicationId: 'replica-02', position: 2, outcome: 'selected', at: Date.now() - 1000 },
         ],
      },
      stats: { files: 22, bytes: 4851462 },
   });

test('Automatic Failover waits for an explicit start, then reports the automatic source decision and progression', async () => {
   const s = server([]);
   const ui = await mount(s.fetcher, false, false, [], { policy: 'automatic', requireStart: true });
   const content = () => ui.dom.window.document.body.textContent || '';
   try {
      await ui.waitFor(() => ui.button('Start recovery'), 'explicit start');
      assert.match(content(), /continues automatically with the first S3 replica that passes identity and integrity checks/);
      assert.ok(s.calls.every((call) => call.method === 'GET'), 'opening the dialog must not start a recovery');
      await ui.click('Start recovery');
      await ui.waitFor(() => s.calls.some((call) => call.method === 'POST'), 'start request');
      assert.equal(s.calls.find((call) => call.method === 'POST')!.body.mode, 'prefer-primary');
      s.set([automaticCompleted()]);
      await ui.click('Refresh recovery status');
      await ui.waitFor(() => /Automatic failover succeeded/.test(content()), 'automatic success');
      assert.match(content(), /staged recovery from S3 Replica 2 passed file integrity verification/);
      assert.match(
         content(),
         /Recovery source: S3 Replica 2, chosen automatically after the primary was network unavailable · S3 Replica 1 failed: timeout\./
      );
      assert.match(content(), /Verified: 22 files · 4,851,462 bytes/);
      const steps = [...ui.dom.window.document.querySelectorAll('[data-step-state]')].map(
         (item: any) => `${item.getAttribute('data-step-state')}:${item.textContent}`,
      );
      assert.deepEqual(steps, [
         'done:Checking primary repository',
         'done:Primary repository unavailable (network unavailable)',
         'done:Failover initiated',
         'done:S3 Replica 1 verified',
         'done:S3 Replica 2 verified',
         'failed:Recovering from S3 Replica 1 (timeout)',
         'done:Recovering from S3 Replica 2',
         'done:Verifying restored files',
         'done:Integrity verified',
      ]);
      assert.equal(ui.button('Continue with S3 Replica'), undefined);
      assert.ok(ui.button('Discard staged result'));
   } finally {
      await ui.close();
   }
});

test('Automatic Failover progression reflects only server state', () => {
   const base = { policy: 'automatic' as const, candidates: [] as AssistedRecoveryJob['candidates'] };
   const states = (job: AssistedRecoveryJob) => recoverySteps(job).map((step) => `${step.state}:${step.label}`);
   assert.deepEqual(states(row({ ...base, status: 'checking', phase: 'primary-check', primary: undefined })), ['active:Checking primary repository']);
   assert.deepEqual(states(row({ ...base, status: 'primary-ready', phase: 'primary-ready', primary: { state: 'ready' } })), [
      'done:Checking primary repository',
      'done:Primary repository available',
   ]);
   assert.deepEqual(
      states(row({ ...base, status: 'checking', phase: 'replica-check', primary: { state: 'unavailable', code: 'timeout' }, candidates: [{ ...replicaCandidates[0], state: 'failed', code: 'replica-unverified' }] })),
      [
         'done:Checking primary repository',
         'done:Primary repository unavailable (timeout)',
         'done:Failover initiated',
         'failed:S3 Replica 1 rejected (replica unverified)',
         'active:Checking S3 Replica 2',
      ],
   );
   assert.deepEqual(
      states(row({ ...base, status: 'failed', phase: 'no-eligible-replica', failureCode: 'no-eligible-replica', primary: { state: 'unavailable', code: 'network-unavailable' } })).slice(-1),
      ['failed:No eligible replica found'],
   );
   const verifying = row({
      ...automaticCompleted(),
      status: 'running',
      phase: 'filesystem-validation',
      stats: undefined,
      selected: 'replica-01',
      sourceSelection: { mode: 'automatic', reason: 'timeout', attempts: [{ replicationId: 'replica-01', position: 1, outcome: 'selected', at: 1 }] },
   });
   assert.deepEqual(states(verifying).slice(-2), ['done:Recovering from S3 Replica 1', 'active:Verifying restored files']);
   assert.match(recoveryStatus(verifying), /Automatic failover in progress: recovering from S3 Replica 1/);
});

test('final automatic states read distinctly and decisions name the operator when approved manually', () => {
   const failed = (failureCode: string) => row({ status: 'failed', phase: 'check-failed', failureCode, policy: 'automatic' });
   assert.equal(recoveryStatus(failed('no-eligible-replica')), 'No eligible replica found. Recovery stopped safely and nothing was restored.');
   assert.match(recoveryStatus(failed('tls-invalid')), /security or identity restriction/);
   assert.match(recoveryStatus(failed('authentication-denied')), /does not switch sources/);
   assert.match(recoveryStatus(failed('automatic-failover-blocked')), /did not start/);
   assert.equal(
      recoveryDecision(row({ sourceSelection: { mode: 'operator', attempts: [{ replicationId: 'replica-01', position: 1, outcome: 'selected', at: 1 }] } })),
      'Recovery source: S3 Replica 1, approved by the operator.',
   );
   assert.equal(recoveryDecision(row()), undefined);
});

test('GET rediscovery restores pending approval after refresh without creating or approving any job', async () => {
   const s = server([row()]);
   const ui = await mount(s.fetcher, false);
   try {
      await ui.waitFor(() => ui.dom.window.document.body.textContent.includes('Awaiting your approval'), 'recovered approval');
      assert(s.calls.every((call) => call.method === 'GET'));
      assert.equal(ui.button('Continue with S3 Replica')?.disabled, false);
      await ui.click('Close');
      assert.equal(ui.closed(), 1);
      assert(s.calls.every((call) => call.method === 'GET'));
   } finally {
      await ui.close();
   }
   const next = await mount(s.fetcher, false);
   try {
      await next.waitFor(() => next.button('Continue with S3 Replica'), 'reopened job');
      assert(s.calls.every((call) => call.method === 'GET'));
   } finally {
      await next.close();
   }
});
test('fresh primary check does not reuse historical primary-ready and StrictMode does not duplicate admission', async () => {
   const s = server([row({ status: 'primary-ready', id: 'e'.repeat(24), primary: { state: 'ready' } })]);
   const base = s.fetcher;
   const fetcher: typeof fetch = async (input, init) => {
      const result = await base(input, init);
      if (init?.method === 'POST') {
         const current = row({ status: 'primary-ready', id: 'f'.repeat(24), primary: { state: 'ready' } });
         s.set([current]);
         return Response.json({ success: true, result: current }, { status: 202 });
      }
      return result;
   };
   const ui = await mount(fetcher, false, true);
   try {
      await ui.waitFor(() => ui.primaryReady() === 1, 'fresh primary readiness');
      assert.equal(s.calls.filter((c) => c.method === 'POST').length, 1);
   } finally {
      await ui.close();
   }
});
test('an explicit click approves one selected replica, displays indeterminate work and never infers completion', async () => {
   const s = server([row()]);
   const ui = await mount(s.fetcher);
   try {
      await ui.waitFor(() => ui.button('Continue with S3 Replica') && !ui.button('Continue with S3 Replica')!.disabled, 'candidate selected');
      await ui.click('Continue with S3 Replica');
      await ui.waitFor(() => ui.dom.window.document.body.textContent.includes('Closing this window does not cancel'), 'server running');
      assert.equal(s.calls.filter((c) => c.path.endsWith('/approve')).length, 1);
      assert.equal(s.calls.find((c) => c.path.endsWith('/approve'))!.body.replicationId, 'replica-01');
      assert.equal(ui.dom.window.document.querySelector('[role="progressbar"]'), null);
      assert(!ui.dom.window.document.body.textContent.includes('passed file integrity verification'));
      s.set([row({ status: 'completed', stats: { files: 4, bytes: 4096 } })]);
      await ui.click('Refresh recovery status');
      await ui.waitFor(() => ui.dom.window.document.body.textContent.includes('passed file integrity verification'), 'verified result');
   } finally {
      await ui.close();
   }
});
test('expired approval and invalid first replica cannot be approved; valid second replica remains selectable', async () => {
   const bad = { ...row().candidates[0], state: 'failed' as const, code: 'replica-unverified' };
   const good = { ...row().candidates[0], replicationId: 'replica-02', position: 2 };
   const s = server([row({ candidates: [bad, good] })]);
   let ui = await mount(s.fetcher);
   try {
      await ui.waitFor(() => ui.button('Continue with S3 Replica') && !ui.button('Continue with S3 Replica')!.disabled, 'second candidate');
      const radios = ui.dom.window.document.querySelectorAll('input[type=radio]');
      assert.equal((radios[0] as HTMLInputElement).disabled, true);
      assert.equal((radios[1] as HTMLInputElement).checked, true);
   } finally {
      await ui.close();
   }
   s.set([row({ expired: true })]);
   ui = await mount(s.fetcher);
   try {
      await ui.waitFor(() => ui.dom.window.document.body.textContent.includes('Approval expired'), 'expiry');
      assert.equal(ui.button('Continue with S3 Replica')?.disabled, true);
      assert(s.calls.every((c) => c.method === 'GET'));
   } finally {
      await ui.close();
   }
});
test('401, policy rejection and HTML/WAF errors are actionable and never endlessly retry admission', async () => {
   for (const response of [
      () => Response.json({ success: false, error: 'Authentication required.' }, { status: 401 }),
      () => Response.json({ success: false, error: 'This plan uses Primary Only.' }, { status: 409 }),
      () => new Response('<html>blocked</html>', { status: 405, headers: { 'Content-Type': 'text/html' } }),
   ]) {
      let calls = 0;
      const ui = await mount(async () => {
         calls++;
         return response();
      }, false);
      try {
         await ui.waitFor(() => ui.dom.window.document.querySelector('[role=alert]'), 'actionable error');
         assert.equal(calls, 1);
         assert(!ui.dom.window.document.body.textContent.includes('Waiting for connection'));
      } finally {
         await ui.close();
      }
   }
});
test('session change aborts stale owner results and performs GET-only rediscovery', async () => {
   let release!: (response: Response) => void,
      gets = 0;
   const held = new Promise<Response>((resolve) => (release = resolve));
   const ui = await mount(async (_input, init) => {
      assert.equal(init?.method, 'GET');
      gets++;
      return gets === 1 ? held : Response.json({ success: true, result: [] });
   });
   try {
      await ui.waitFor(() => gets === 1, 'initial GET');
      await act(async () => ui.dom.window.dispatchEvent(new ui.dom.window.Event('pluton-export-session')));
      await ui.waitFor(() => gets === 2, 'new session GET');
      release(Response.json({ success: true, result: [row()] }));
      await ui.waitFor(() => ui.client.isFetching() === 0, 'stale response fenced');
      assert(!ui.dom.window.document.body.textContent.includes('Awaiting your approval'));
      assert.equal(ui.dom.window.document.querySelector('input[type=radio]'), null);
   } finally {
      await ui.close();
   }
});
test('manual recovery is explicit; cancellation does not approve or silently choose another source', async () => {
   const s = server();
   const ui = await mount(s.fetcher);
   try {
      await ui.waitFor(() => ui.button('Check replica recovery'), 'manual check');
      assert(s.calls.every((c) => c.method === 'GET'));
      await ui.click('Check replica recovery');
      await ui.waitFor(() => ui.button('Cancel Recovery'), 'pending job');
      await ui.click('Cancel Recovery');
      await ui.waitFor(() => ui.dom.window.document.body.textContent.includes('Recovery cancelled'), 'cancelled');
      assert.equal(s.calls.filter((c) => c.path.endsWith('/approve')).length, 0);
      assert.equal(s.calls.filter((c) => c.path.endsWith('/cancel')).length, 1);
   } finally {
      await ui.close();
   }
});

test('LAN HTTP creates a UUID using secure random bytes when randomUUID is unavailable', () => {
   const source = {
      getRandomValues: (array: Uint8Array) => {
         array.fill(7);
         return array;
      },
   };
   assert.match(recoveryRequestId(source as any), /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
   assert.throws(() => recoveryRequestId({} as any), /Secure request identity is unavailable/);
});
test('granular restore intent is preserved, and a different pending selection cannot be approved', async () => {
   const path = '/srv/example-app/nested';
   const s = server();
   let ui = await mount(s.fetcher, false, false, [path]);
   try {
      await ui.waitFor(() => ui.button('Continue with S3 Replica') && !ui.button('Continue with S3 Replica')!.disabled, 'granular admission');
      assert.deepEqual(s.calls.find((call) => call.method === 'POST')!.body.includes, [path]);
   } finally {
      await ui.close();
   }
   s.set([row({ includes: ['/srv/other'] })]);
   const before = s.calls.length;
   ui = await mount(s.fetcher, false, false, [path]);
   try {
      await ui.waitFor(() => ui.dom.window.document.body.textContent.includes('different selection'), 'selection conflict');
      assert.equal(ui.button('Continue with S3 Replica')?.disabled, true);
      assert(s.calls.slice(before).every((call) => call.method === 'GET'));
   } finally {
      await ui.close();
   }
});

test('restart uncertainty and pending cleanup are rediscovered with GET only', async () => {
   for (const status of ['uncertain', 'failed'] as const) {
      const s = server([row({ status, cleanupPending: true, failureCode: 'restart-interrupted' })]);
      const ui = await mount(s.fetcher, false);
      try {
         await ui.waitFor(() => ui.dom.window.document.body.textContent.includes('cleanup needs attention'), 'pending cleanup');
         assert(s.calls.every((call) => call.method === 'GET'));
         assert.equal(ui.button('Continue with S3 Replica'), undefined);
      } finally {
         await ui.close();
      }
   }
});

test('phase, primary state and diagnostic codes read as words while the exact codes stay visible', async () => {
   const s = server([row({ status: 'failed', phase: 'check-failed', failureCode: 'no-eligible-replica', candidates: [] })]);
   const ui = await mount(s.fetcher, true);
   try {
      await ui.waitFor(() => ui.dom.window.document.body.textContent.includes('Check failed'), 'readable phase');
      const text = ui.dom.window.document.body.textContent;
      const phase = [...ui.dom.window.document.querySelectorAll('dt')].find((dt: any) => dt.textContent === 'Phase')!.nextElementSibling!;
      assert.equal(phase.getAttribute('title'), 'check-failed', 'the exact phase stays available');
      assert(text.includes('Network unavailable') && text.includes('network-unavailable'), 'primary code: words plus exact code');
      assert(text.includes('No eligible replica') && text.includes('no-eligible-replica'), 'diagnostic: words plus exact code');
      // The manual check is still offered exactly as before; it is only labelled as a new check.
      assert(text.includes('Start a new replica check'));
      assert(ui.button('Check replica recovery'));
      assert(
         s.calls.every((call) => call.method === 'GET'),
         'presentation only: no request was started',
      );
   } finally {
      await ui.close();
   }
});

test('without an earlier job the manual check has no "new check" heading', async () => {
   const s = server([]);
   const ui = await mount(s.fetcher, true);
   try {
      await ui.waitFor(() => ui.button('Check replica recovery'), 'manual form');
      assert(!ui.dom.window.document.body.textContent.includes('Start a new replica check'));
   } finally {
      await ui.close();
   }
});

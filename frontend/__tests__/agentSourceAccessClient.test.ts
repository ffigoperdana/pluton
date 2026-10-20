import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(new URL('../package.json', import.meta.url));
const backendRequire = createRequire(new URL('../../backend/package.json', import.meta.url));
const compiled = await backendRequire('esbuild').build({
   entryPoints: [fileURLToPath(new URL('../src/services/agentSourceAccess.ts', import.meta.url))],
   bundle: true,
   platform: 'node',
   format: 'cjs',
   write: false,
   plugins: [
      {
         name: 'source-access-api-fixture',
         setup(builder: any) {
            builder.onLoad({ filter: /[\\/]utils[\\/]constants\.ts$/ }, () => ({
               contents: 'export const API_URL="https://example.internal/api";',
               loader: 'js',
            }));
            builder.onResolve({ filter: /^@tanstack\/react-query$/ }, () => ({ path: 'query', namespace: 'test' }));
            builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
               contents:
                  'export const useMutation=options=>options;export const useQuery=options=>options;export const useQueryClient=()=>({invalidateQueries:()=>{}});',
               loader: 'js',
            }));
         },
      },
   ],
});
const module = { exports: {} as any };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const client = module.exports;
const payload = { expectedVersion: 3, expectedHostPolicyRevision: 'a'.repeat(64), roots: ['/srv/example-apps/app-01'] };

async function withFetch(
   run: (requests: { url: string; init: RequestInit }[]) => Promise<void>,
   response = () =>
      new Response(JSON.stringify({ success: true, result: { requestId: 'request-01', status: 'queued' } }), {
         status: 202,
         headers: { 'Content-Type': 'application/json' },
      }),
) {
   const previous = globalThis.fetch;
   const requests: { url: string; init: RequestInit }[] = [];
   globalThis.fetch = async (input: any, init: RequestInit = {}) => {
      requests.push({ url: String(input), init });
      return response();
   };
   try {
      await run(requests);
   } finally {
      globalThis.fetch = previous;
   }
}

test('actual validation/apply clients send only explicit bounded paths and preserve accepted status without claiming access', async () => {
   await withFetch(async (requests) => {
      for (const kind of ['validate', 'requests']) {
         const result = await client.submitSourceAccess('device/01', kind, payload);
         assert.deepEqual(result, { requestId: 'request-01', status: 'queued' });
      }
      assert.equal(requests.length, 2);
      for (const request of requests) {
         assert.match(request.url, /agent-admin\/devices\/device%2F01\/source-access\/(validate|requests)$/);
         assert.equal(request.init.method, 'POST');
         assert.equal(request.init.credentials, 'include');
         assert.equal(request.init.redirect, 'error');
         assert.deepEqual(JSON.parse(String(request.init.body)), payload);
      }
   });
});

test('mode setup posts an explicit receipt request with exact plans and never invokes a host policy setter', async () => {
   const mutation = client.useSourceModeSetup('device-01');
   assert.equal(mutation.retry, false);
   const mode = { ...payload, authorizationMode: 'server-managed', confirmedAffectedPlanIds: ['plan-01'] };
   await withFetch(async (requests) => {
      await mutation.mutationFn(mode);
      assert.equal(requests.length, 1);
      assert.match(requests[0].url, /source-access\/mode-setup$/);
      assert.deepEqual(JSON.parse(String(requests[0].init.body)), mode);
      assert.equal(requests[0].init.credentials, 'include');
      assert.equal(requests[0].init.redirect, 'error');
   });
});

test('permanent authorization failures stop automatic source polling and never reveal cached root responses', async () => {
   await withFetch(
      async (requests) => {
         let failure: any;
         try {
            await client.getSourceAccess('device-01');
         } catch (error) {
            failure = error;
         }
         assert.equal(failure.status, 403);
         const query = client.useSourceAccess('device-01');
         assert.equal(query.retry, false);
         assert.equal(query.refetchInterval({ state: { error: failure, fetchFailureCount: 1 } }), false);
         assert.equal(query.refetchInterval({ state: { error: new Error('transient'), fetchFailureCount: 4 } }), false);
         assert.equal(query.refetchInterval({ state: { data: { online: true }, fetchFailureCount: 0 } }), 3000);
         assert.equal(query.refetchInterval({ state: { data: { online: false }, fetchFailureCount: 0 } }), 10000);
         assert.equal(requests[0].init.credentials, 'include');
         assert.equal(requests[0].init.redirect, 'error');
      },
      () =>
         new Response(JSON.stringify({ success: false, error: 'Administrator session required.' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
         }),
   );
});

test('rejected mode setup preserves server refusal and never retries automatically', async () => {
   await withFetch(
      async (requests) => {
         const mutation = client.useSourceModeSetup('device-01');
         await assert.rejects(
            mutation.mutationFn({ ...payload, authorizationMode: 'host-approved', roots: [], confirmedAffectedPlanIds: [] }),
            (error: any) => error.status === 409 && /Pause/.test(error.message),
         );
         assert.equal(requests.length, 1);
         assert.equal(mutation.retry, false);
      },
      () =>
         new Response(JSON.stringify({ success: false, error: 'Pause every affected plan before changing modes.' }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
         }),
   );
});

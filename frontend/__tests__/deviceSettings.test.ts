import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { deviceSettingsPayload } from '../src/utils/deviceSettingsUpdate.ts';

const require = createRequire(new URL('../package.json', import.meta.url));
const backendRequire = createRequire(new URL('../../backend/package.json', import.meta.url));
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { JSDOM } = require('jsdom');

test('remote rename payload is metadata only, even with an old form settings snapshot', () => {
   const original = { name: 'app-01', settings: { general: { tempDir: '/srv/example-app' } } };
   assert.deepEqual(deviceSettingsPayload(original, { name: ' Renamed ', settings: {} }, true), { name: 'Renamed' });
   assert.deepEqual(deviceSettingsPayload(original, { name: 'Renamed', settings: { general: { tempDir: '/other' } } }, true), { name: 'Renamed' });
});

test('local optional edits omit unchanged/blank fields and preserve intentional numeric zero', () => {
   const original = { name: 'Local', settings: { general: { tempDir: '/srv/example-app' }, rclone: { retries: 3, transfers: 4 } } };
   assert.deepEqual(deviceSettingsPayload(original, { name: 'Local', settings: { general: { tempDir: '   ' }, rclone: { retries: 3 } } }, false), {
      name: 'Local',
   });
   assert.deepEqual(deviceSettingsPayload(original, { name: 'Local', settings: { rclone: { retries: '', transfers: 0 } } }, false), {
      name: 'Local',
      settings: { rclone: { transfers: 0 } },
   });
});

async function bundle(entry: string, dialog: boolean) {
   const output = await backendRequire('esbuild').build({
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      jsx: 'automatic',
      write: false,
      external: ['react', 'react/jsx-runtime', 'react-dom'],
      plugins: [
         {
            name: 'test-boundaries',
            setup(builder: any) {
               builder.onLoad({ filter: /\.scss$/ }, () => ({ contents: 'export default {};', loader: 'js' }));
               builder.onLoad({ filter: /utils[\\/]constants\.ts$/ }, () => ({
                  contents: 'export const API_URL="https://example.internal/api";',
                  loader: 'js',
               }));
               builder.onResolve({ filter: /^@tanstack\/react-query$/ }, () => ({ path: 'query', namespace: 'stub' }));
               builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
                  contents:
                     'export const useMutation=x=>x;export const useQuery=x=>x;export const useQueryClient=()=>({invalidateQueries:x=>globalThis.__deviceSettings.invalidations.push(x.queryKey)});',
                  loader: 'js',
               }));
               if (!dialog) return;
               builder.onLoad({ filter: /common[\\/]Icon[\\/]Icon\.tsx$/ }, () => ({ contents: 'export default ()=>null;', loader: 'js' }));
               builder.onLoad({ filter: /common[\\/]SidePanel[\\/]SidePanel\.tsx$/ }, () => ({
                  contents: 'export default p=><section>{p.children}{p.footer}</section>;',
                  loader: 'jsx',
               }));
               builder.onLoad({ filter: /common[\\/]Tabs[\\/]Tabs\.tsx$/ }, () => ({
                  contents:
                     'export const Tab=()=>null;export const TabList=p=><div>{p.children}</div>;export const TabPanel=p=><div>{p.children}</div>;export default p=><div>{p.children}</div>;',
                  loader: 'jsx',
               }));
               builder.onLoad({ filter: /services[\\/]devices\.ts$/ }, () => ({
                  contents: `
            import {useState} from 'react';
            export const useUpdateDevice=()=>{const [pending,setPending]=useState(false);return {
               isPending:pending,mutate:(payload,callbacks)=>{globalThis.__deviceSettings.submissions.push(payload);setPending(true);
                  globalThis.__deviceSettings.finish=error=>{setPending(false);error?callbacks.onError(error):callbacks.onSuccess({success:true});callbacks.onSettled();};
               }
            }};`,
                  loader: 'js',
               }));
               builder.onResolve({ filter: /^react-toastify$/ }, () => ({ path: 'toast', namespace: 'toast' }));
               builder.onLoad({ filter: /.*/, namespace: 'toast' }, () => ({
                  contents:
                     'export const toast={error:x=>globalThis.__deviceSettings.errors.push(x),success:x=>globalThis.__deviceSettings.success.push(x)};',
                  loader: 'js',
               }));
               // Unrelated local-only editors must never mount for a remote Agent.
               builder.onLoad({ filter: /(?:FolderPicker|DeviceResticSettings|DeviceRcloneSettings)\.tsx$/ }, () => ({
                  contents: 'export default ()=>{throw new Error("Remote runtime editor mounted");};',
                  loader: 'js',
               }));
            },
         },
      ],
   });
   const module = { exports: {} as any };
   new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, module, module.exports);
   return module.exports;
}
const client = await bundle('../src/services/devices.ts', false);
const EditDevice = (await bundle('../src/components/Device/EditDevice/EditDevice.tsx', true)).default;

test('rename client preserves session and PUT, encodes identity and fails safely without retries or raw HTML', async () => {
   const previous = globalThis.fetch;
   let calls = 0;
   let response = new Response(JSON.stringify({ success: true, result: { id: 'device/01' } }), { headers: { 'Content-Type': 'application/json' } });
   globalThis.fetch = async (input, init) => {
      calls++;
      assert.equal(String(input), 'https://example.internal/api/devices/device%2F01');
      assert.equal(init?.method, 'PUT');
      assert.equal(init?.credentials, 'include');
      assert.equal(init?.redirect, 'error');
      assert.deepEqual(JSON.parse(String(init?.body)), { name: 'Renamed' });
      return response;
   };
   try {
      const payload = { id: 'device/01', data: { name: 'Renamed' } };
      assert.equal((await client.updateDevice(payload)).success, true);
      response = new Response('<html>private upstream detail</html>', { status: 500, headers: { 'Content-Type': 'text/html' } });
      await assert.rejects(
         client.updateDevice(payload),
         (error) => /HTML instead of JSON/.test(String(error)) && !/private upstream detail/.test(String(error)),
      );
      response = new Response(JSON.stringify({ success: false, error: 'Name already exists' }), {
         status: 409,
         headers: { 'Content-Type': 'application/json' },
      });
      await assert.rejects(client.updateDevice(payload), /Name already exists/);
      await assert.rejects(client.updateDevice({ id: '', data: {} }), /Device ID is required/);
      assert.equal(calls, 3);
      const state = { invalidations: [] as unknown[] };
      (globalThis as any).__deviceSettings = state;
      const mutation = client.useUpdateDevice();
      assert.equal(mutation.retry, false);
      mutation.onSuccess({}, payload);
      assert.deepEqual(state.invalidations, [['devices'], ['device', 'device/01']]);
   } finally {
      globalThis.fetch = previous;
      delete (globalThis as any).__deviceSettings;
   }
});

test('real remote edit panel submits rename only, guards duplicate clicks, retains name on failure and never mounts host editors', async () => {
   const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.internal' });
   const previous = Object.fromEntries(
      ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT', '__deviceSettings'].map((key) => [
         key,
         Object.getOwnPropertyDescriptor(globalThis, key),
      ]),
   );
   const state: any = { submissions: [], errors: [], success: [] };
   for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      IS_REACT_ACT_ENVIRONMENT: true,
      __deviceSettings: state,
   }))
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
   const root = createRoot(dom.window.document.getElementById('root'));
   try {
      await act(async () =>
         root.render(React.createElement(EditDevice, { device: { id: 'device-01', name: 'app-01', settings: null }, close: () => {} })),
      );
      assert.match(dom.window.document.querySelector('[role="note"]')?.textContent || '', /including while the Agent is offline/);
      assert.equal(dom.window.document.querySelectorAll('input').length, 1);
      const button = dom.window.document.querySelector<HTMLButtonElement>('button')!;
      await act(async () => {
         button.click();
         button.click();
      });
      assert.deepEqual(state.submissions, [{ id: 'device-01', data: { name: 'app-01' } }]);
      assert.equal(button.disabled, true);
      await act(async () => state.finish(new Error('Name already exists')));
      assert.equal(button.disabled, false);
      assert.equal(dom.window.document.querySelector<HTMLInputElement>('input')?.value, 'app-01');
      assert.deepEqual(state.errors, ['Name already exists']);
      assert.equal(state.success.length, 0);
      await act(async () => button.click());
      await act(async () => state.finish(null));
      assert.equal(state.submissions.length, 2);
      assert.equal(state.success.length, 1);
   } finally {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of Object.entries(previous))
         descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete (globalThis as any)[key];
   }
});

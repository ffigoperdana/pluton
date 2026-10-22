import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../package.json', import.meta.url));
const backendRequire = createRequire(new URL('../../backend/package.json', import.meta.url));
const React = require('react');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { JSDOM } = require('jsdom');
const { act } = React;
const output = await backendRequire('esbuild').build({
   entryPoints: [fileURLToPath(new URL('../src/components/Plan/PlanSettings/PlanScheduleField.tsx', import.meta.url))],
   bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
   external: ['react', 'react/jsx-runtime', 'react-dom', '@tanstack/react-query'],
   plugins: [{ name: 'schedule-test-shell', setup(builder: any) {
      builder.onLoad({ filter: /\.scss$/ }, () => ({ contents: 'export default {};', loader: 'js' }));
      builder.onLoad({ filter: /IntervalField\.tsx$/ }, () => ({ contents: 'export default ()=>null;', loader: 'js' }));
      builder.onLoad({ filter: /utils[\\/]constants\.ts$/ }, () => ({ contents: "export const API_URL='/api';", loader: 'js' }));
   } }],
});
const module = { exports: {} as any };
new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, module, module.exports);
const Component = module.exports.default;

async function fixture(initial: any, fail = false) {
   const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.internal/' });
   const keys = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'];
   const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
   Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
   const queries: any[] = [];
   let release!: () => void;
   const ready = new Promise<void>(resolve => { release = resolve; });
   globalThis.fetch = (async (url: string, options: any) => {
      assert.equal(options.credentials, 'include');
      const value = JSON.parse(new URL(url, 'https://example.internal').searchParams.get('interval')!);
      queries.push(value);
      await ready;
      if (fail) return { ok: false, json: async () => ({ success: false }) };
      return { ok: true, json: async () => ({ success: true, result: { timeZone: value.timeZone ?? 'UTC', legacyTimeZone: !value.timeZone, nextRunAt: value.timeZone === 'Asia/Jakarta' ? '2026-10-23T21:00:00.000Z' : '2026-10-24T04:00:00.000Z', evaluatedAt: '2026-10-23T12:00:00.000Z', missedRunPolicy: 'skip' } }) };
   }) as typeof fetch;
   const updates: any[] = [];
   function Form() {
      const [interval, update] = React.useState(initial);
      return React.createElement(Component, { interval, onUpdate: (next: any) => { updates.push(next); update(next); } });
   }
   const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
   const root = require('react-dom/client').createRoot(dom.window.document.getElementById('root'));
   await act(async () => root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Form))));
   return {
      dom, updates, queries,
      text: () => dom.window.document.body.textContent || '',
      async settle() { release(); for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); },
      async close() {
         release(); await act(async () => root.unmount()); client.clear(); dom.window.close();
         for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else delete (globalThis as any)[key]; }
      },
   };
}

test('legacy editor stays unchanged until explicit timezone selection; real hook and summary share backend results', async () => {
   const initial = { type: 'daily', time: '04:00AM' };
   const ui = await fixture(initial);
   try {
      assert.match(ui.text(), /Calculating/);
      await ui.settle();
      assert.match(ui.text(), /existing plan still uses server time \(UTC\)/);
      assert.equal(ui.updates.length, 0);
      assert.equal(ui.dom.window.document.querySelector('label')?.textContent?.includes('Schedule timezone'), true);
      const select = ui.dom.window.document.querySelector('select')!;
      await act(async () => { select.value = 'Asia/Jakarta'; select.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true })); });
      await ui.settle();
      assert.deepEqual(ui.updates[0], { ...initial, timeZone: 'Asia/Jakarta' });
      assert.match(ui.text(), /24 Oct 2026, 04:00.*Asia\/Jakarta \(WIB\)/);
      assert.equal(ui.dom.window.document.querySelector('[role="status"]')?.getAttribute('aria-live'), 'polite');
      assert.equal(ui.queries.at(-1).timeZone, 'Asia/Jakarta');
      assert.equal('timeZone' in initial, false);
   } finally { await ui.close(); }
});
test('new WIB plan and API failures retain the selection and never claim a next run', async () => {
   const ui = await fixture({ type: 'daily', time: '04:00AM', timeZone: 'Asia/Jakarta' }, true);
   try {
      await ui.settle();
      assert.match(ui.text(), /Schedule preview unavailable/);
      assert.equal(ui.dom.window.document.querySelector('select')?.value, 'Asia/Jakarta');
      assert.doesNotMatch(ui.text(), /Next scheduled time:/);
      assert.equal(ui.updates.length, 0);
   } finally { await ui.close(); }
});

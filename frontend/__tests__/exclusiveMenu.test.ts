import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { announceMenuOpen, onOtherMenuOpen } from '../src/utils/exclusiveMenu.ts';
import { keepErrorToastsOpen, TOAST_AUTO_CLOSE_MS, TOAST_LIMIT } from '../src/utils/toastDefaults.ts';

const require = createRequire(new URL('../package.json', import.meta.url)),
   backendRequire = createRequire(new URL('../../backend/package.json', import.meta.url));
const React = require('react'),
   { act } = React,
   { JSDOM } = require('jsdom');

test('opening one menu closes every other menu, never itself', () => {
   const target = new EventTarget();
   const closed: string[] = [];
   const offA = onOtherMenuOpen('a', () => closed.push('a'), target);
   const offB = onOtherMenuOpen('b', () => closed.push('b'), target);
   announceMenuOpen('a', target);
   assert.deepEqual(closed, ['b']);
   announceMenuOpen('b', target);
   assert.deepEqual(closed, ['b', 'a']);
   offA();
   offB();
   announceMenuOpen('c', target);
   assert.deepEqual(closed, ['b', 'a']);
});

test('success toasts close by themselves while errors stay until closed', () => {
   assert.equal(TOAST_AUTO_CLOSE_MS, 3000);
   assert.equal(TOAST_LIMIT, 4);
   const calls: unknown[][] = [];
   const api = { error: (content: unknown, options?: Record<string, unknown>) => calls.push([content, options]) };
   keepErrorToastsOpen(api);
   keepErrorToastsOpen(api); // idempotent: no double wrapping
   api.error('Backup failed');
   api.error('Short error', { autoClose: 4000 });
   assert.deepEqual(calls, [
      ['Backup failed', { autoClose: false, closeButton: true }],
      ['Short error', { autoClose: 4000, closeButton: true }],
   ]);
});

test('the error state of toast.promise also stays open; pending and success are untouched', () => {
   const calls: unknown[][] = [];
   const api = {
      error: () => undefined,
      promise: (pending: unknown, params: unknown, options?: unknown) => calls.push([pending, params, options]),
   };
   keepErrorToastsOpen(api);
   const render = () => 'Failed to Resume Backup Plan.';
   api.promise('p1', { pending: 'Resuming...', success: 'Resumed', error: { render } });
   api.promise('p2', { pending: 'Pausing...', success: 'Paused', error: 'Failed' });
   api.promise('p3', { pending: 'Working...', success: 'Done' }, { toastId: 'x' });
   assert.deepEqual(calls, [
      ['p1', { pending: 'Resuming...', success: 'Resumed', error: { autoClose: false, closeButton: true, render } }, undefined],
      ['p2', { pending: 'Pausing...', success: 'Paused', error: { autoClose: false, closeButton: true, render: 'Failed' } }, undefined],
      ['p3', { pending: 'Working...', success: 'Done' }, { toastId: 'x' }],
   ]);
});

const bundle = await backendRequire('esbuild').build({
   entryPoints: [fileURLToPath(new URL('../src/components/common/form/Select/Select.tsx', import.meta.url))],
   bundle: true,
   platform: 'node',
   format: 'cjs',
   jsx: 'automatic',
   write: false,
   external: ['react', 'react/jsx-runtime', 'react-dom'],
   plugins: [
      {
         name: 'styles',
         setup(builder: any) {
            builder.onLoad({ filter: /[.]scss$/ }, () => ({ contents: 'export default new Proxy({}, {get:(_,key)=>String(key)});', loader: 'js' }));
         },
      },
   ],
});
const compiled = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, compiled, compiled.exports);
const Select = (compiled.exports as any).default;

test('only one dropdown is open at a time; outside press and Escape close it', async () => {
   const dom = new JSDOM('<div id="root"></div><p id="outside">outside</p>', { url: 'https://example.internal' });
   for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'IS_REACT_ACT_ENVIRONMENT'])
      Object.defineProperty(globalThis, key, {
         configurable: true,
         writable: true,
         value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : (dom.window as any)[key],
      });
   const root = require('react-dom/client').createRoot(dom.window.document.getElementById('root'));
   const options = [
      { label: 'First', value: 'first' },
      { label: 'Second', value: 'second' },
   ];
   await act(async () => {
      root.render(
         React.createElement(
            'div',
            {},
            React.createElement(Select, { label: 'Alpha', fieldValue: 'first', options, onUpdate: () => undefined }),
            React.createElement(Select, { label: 'Beta', fieldValue: 'first', options, onUpdate: () => undefined }),
         ),
      );
   });
   const toggles = () => [...dom.window.document.querySelectorAll('button[aria-haspopup="listbox"]')] as HTMLButtonElement[];
   const expanded = () => toggles().map((button) => button.getAttribute('aria-expanded'));
   const press = async (element: Element, type = 'click') =>
      act(async () => {
         element.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true }));
      });
   try {
      assert.deepEqual(expanded(), ['false', 'false']);
      await press(toggles()[0].parentElement!);
      assert.deepEqual(expanded(), ['true', 'false']);
      await press(toggles()[1].parentElement!);
      assert.deepEqual(expanded(), ['false', 'true']);
      await press(dom.window.document.getElementById('outside')!, 'mousedown');
      assert.deepEqual(expanded(), ['false', 'false']);
      await press(toggles()[0].parentElement!);
      await act(async () => {
         dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      assert.deepEqual(expanded(), ['false', 'false']);
   } finally {
      await act(async () => root.unmount());
      dom.window.close();
   }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../package.json', import.meta.url));
const backendRequire = createRequire(new URL('../../backend/package.json', import.meta.url));
const React = require('react');
const { act } = React;
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { JSDOM } = require('jsdom');
const output = await backendRequire('esbuild').build({
   stdin: {
      contents: `import React,{useState} from 'react';
         import ErrorDetails from './components/Plan/BackupEvents/BackupErrorDetails';
         import Modal from './components/common/Modal/Modal';
         export { ErrorDetails };
         export default function Fixture(props) {
            const [open,setOpen]=useState(false);
            return <><button onClick={()=>setOpen(true)}>Open error details</button>{open&&
               <Modal title="Error Details" width="680px" stableLayout closeModal={()=>setOpen(false)}>
                  <ErrorDetails {...props} onClose={()=>setOpen(false)}/>
               </Modal>}</>;
         }`,
      resolveDir: fileURLToPath(new URL('../src/', import.meta.url)),
      loader: 'tsx',
   },
   bundle: true,
   platform: 'node',
   format: 'cjs',
   jsx: 'automatic',
   write: false,
   external: ['react', 'react/jsx-runtime', 'react-dom', '@tanstack/react-query'],
   plugins: [
      {
         name: 'source-troubleshooting-fixtures',
         setup(builder: any) {
            builder.onLoad({ filter: /\.scss$/ }, () => ({ contents: 'export default {};', loader: 'js' }));
            builder.onLoad({ filter: /[\\/]Icon\.tsx$/ }, () => ({ contents: 'export default ()=>null;', loader: 'js' }));
            builder.onLoad({ filter: /[\\/]services[\\/]backups\.ts$/ }, () => ({
               contents: `export const getBackupProgress=async()=>{
         globalThis.__diagnosticV2.reads++; await new Promise(resolve=>setTimeout(resolve,10)); if(globalThis.__diagnosticV2.denied) throw new Error('Access denied');
         return globalThis.__diagnosticV2.data;
      };`,
               loader: 'js',
            }));
         },
      },
   ],
});
const module = { exports: {} as any };
new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, module, module.exports);

const failure = (count = 1) => ({
   failureStage: 'restic-backup',
   failureCode: 'source-entry-inaccessible',
   sourceDiagnostics: {
      version: 1,
      origin: 'restic',
      problemCount: count,
      countIsLowerBound: true,
      entries: Array.from({ length: count }, (_, i) => ({
         relativePath: i ? `report ${i}.pdf` : 'app/logs/id_rsa',
         entryType: 'unknown',
         errno: 'EACCES',
         excluded: false,
      })),
   },
});

async function fixture(t: test.TestContext, Component: any) {
   const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.internal/' });
   const keys = ['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT', '__diagnosticV2'];
   const previous = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
   const state = { reads: 0, denied: false, data: {}, copied: '' };
   Object.defineProperty(dom.window.navigator, 'clipboard', {
      value: {
         writeText: async (text: string) => {
            state.copied = text;
         },
      },
   });
   for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      HTMLElement: dom.window.HTMLElement,
      IS_REACT_ACT_ENVIRONMENT: true,
      __diagnosticV2: state,
   }))
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
   const query = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
   const { createRoot } = require('react-dom/client');
   const root = createRoot(dom.window.document.querySelector('#root'));
   t.after(async () => {
      await act(async () => root.unmount());
      query.clear();
      dom.window.close();
      for (const [key, descriptor] of previous) {
         if (descriptor) Object.defineProperty(globalThis, key, descriptor);
         else delete (globalThis as any)[key];
      }
   });
   return {
      dom,
      state,
      query,
      render: async (props: any) =>
         act(async () => root.render(React.createElement(QueryClientProvider, { client: query }, React.createElement(Component, props)))),
      click: async (text: string) =>
         act(async () => [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === text)!.click()),
      text: () => dom.window.document.body.textContent || '',
   };
}

test('popup renders bounded entries, truncation, sensitive-file guidance and sanitized clipboard with a fixed guide URL', async (t) => {
   const f = await fixture(t, module.exports.ErrorDetails);
   const diagnostic = failure(30);
   diagnostic.sourceDiagnostics.entries[1].relativePath = 'file$(touch synthetic)';
   await f.render({ message: 'Safe error.', failure: diagnostic, planId: 'plan-01' });
   assert.match(f.text(), /Source Access Problem/);
   assert.match(f.text(), /At least 30/);
   assert.match(f.text(), /20 representative entries/);
   assert.match(f.text(), /10 additional observations/);
   assert.equal(f.dom.window.document.querySelectorAll('li').length, 20);
   assert.match(f.text(), /Sensitive filename detected/);
   assert.match(f.text(), /Do not make SSH keys/);
   assert.match(f.text(), /plan-01/);
   assert.match(f.text(), /Not reported/);
   assert(!f.text().includes('touch synthetic'));
   const guide = f.dom.window.document.querySelector('aside a')!;
   assert.equal(guide.getAttribute('href'), '/docs/troubleshooting/source#1-understand-the-error');
   assert(!guide.getAttribute('href')!.includes('id_rsa'));
   await f.click('Copy Sanitized Diagnostics');
   assert(f.state.copied.includes('app/logs/id_rsa'));
   assert(!f.state.copied.includes('touch synthetic'));
   assert(!f.state.copied.includes('file-29'));
   assert.equal(f.state.reads, 0);
   await f.render({ message: 'Safe error.', failure: failure() });
   assert.match(f.text(), /1 representative entry shown/);
});

test('historical, disappeared, symlink and unrelated errors keep distinct explanations and valid help', async (t) => {
   const f = await fixture(t, module.exports.ErrorDetails);
   await f.render({ message: 'Generic (restic-backup/source-entry-inaccessible).' });
   assert.match(f.text(), /unavailable for this historical Agent\/job/);
   assert(!f.text().includes('EACCES)'));
   await f.render({ message: 'Missing.', failure: { failureStage: 'source-validation', failureCode: 'source-missing' } });
   assert.match(f.text(), /missing entry does not prove a permission problem/i);
   await f.render({ message: 'Policy.', failure: { failureStage: 'source-validation', failureCode: 'source-symlink-escape' } });
   assert.match(f.text(), /Do not follow the target/);
   await f.render({ message: 'Repository unavailable.\nTry later.\u001b[31m\u0000' });
   assert(f.text().includes('Repository unavailable.\nTry later.'));
   assert(!f.text().includes('\u001b'));
   assert.equal(f.dom.window.document.querySelector('aside a')!.getAttribute('href'), '/docs/troubleshooting');
   assert(!f.text().includes('Source Access Problem'));
});

test('an unsuccessful authenticated read hides even cached path data and disables diagnostic copy', async (t) => {
   const f = await fixture(t, module.exports.ErrorDetails);
   f.state.denied = true;
   f.query.setQueryData(['progress-backup', 'backup-01'], { sourceFailure: failure() });
   await f.render({ message: 'Safe failure.', backup: { id: 'backup-01', planId: 'plan-01', sourceId: 'app-01', sourceType: 'device' } });
   assert(!f.text().includes('app/logs/id_rsa'), 'cached paths must stay hidden during authentication recheck');
   await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
   });
   assert.match(f.text(), /access was denied/);
   assert(!f.text().includes('app/logs/id_rsa'));
   assert(f.dom.window.document.querySelector<HTMLButtonElement>('button')!.disabled);
   assert.equal(f.state.copied, '');
});

test('the actual modal traps keyboard focus, closes on Escape or Close and restores the trigger', async (t) => {
   const f = await fixture(t, module.exports.default);
   await f.render({ message: 'Safe failure.', failure: failure(), planId: 'plan-01' });
   const trigger = f.dom.window.document.querySelector('button')!;
   trigger.focus();
   await f.click('Open error details');
   const dialog = f.dom.window.document.querySelector('[role="dialog"]') as HTMLElement;
   assert(dialog);
   assert.equal(f.dom.window.document.activeElement, dialog);
   const close = [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Close')!;
   close.focus();
   await act(async () => close.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
   assert.equal(f.dom.window.document.activeElement, dialog.querySelector('[aria-label="Close dialog"]'));
   await act(async () => f.dom.window.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape' })));
   assert.equal(f.dom.window.document.querySelector('[role="dialog"]'), null);
   assert.equal(f.dom.window.document.activeElement, trigger);
   await f.click('Open error details');
   await f.click('Close');
   assert.equal(f.dom.window.document.activeElement, trigger);
});

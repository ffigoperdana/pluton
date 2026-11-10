import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Shared form controls must be keyboard operable and must never submit an
// enclosing <form> by accident. Rendering uses the real components with styles
// and icons stubbed, as in snapshotReview.test.ts.
const require = createRequire(new URL('../package.json', import.meta.url)),
   backendRequire = createRequire(new URL('../../backend/package.json', import.meta.url));
const React = require('react'),
   { act } = React,
   { JSDOM } = require('jsdom');
const sourceRoot = fileURLToPath(new URL('../src', import.meta.url));
const output = await backendRequire('esbuild').build({
   stdin: {
      contents: [
         'export {default as Select} from "./components/common/form/Select/Select";',
         'export {default as MultiSelect} from "./components/common/form/MultiSelect/MultiSelect";',
         'export {default as StorageProviderSelect} from "./components/common/form/StorageProviderSelect/StorageProviderSelect";',
         'export {default as TimePicker} from "./components/common/form/TimePicker/TimePicker";',
         'export {default as RadioIconSelect} from "./components/common/form/RadioIconSelect/RadioIconSelect";',
         'export {default as Tristate} from "./components/common/form/Tristate/Tristate";',
         'export {default as PlanStrategySettings} from "./components/Plan/PlanSettings/PlanStrategySettings";',
      ].join(''),
      resolveDir: sourceRoot,
      loader: 'tsx',
   },
   bundle: true,
   platform: 'node',
   format: 'cjs',
   jsx: 'automatic',
   write: false,
   external: ['react', 'react/jsx-runtime', 'react-dom'],
   plugins: [
      {
         name: 'disposable-form-controls',
         setup(build: any) {
            // StorageProviderSelect imports the whole components barrel; only two exports are used.
            build.onResolve({ filter: /^\.\.\/\.\.\/\.\.$/ }, () => ({ path: 'form-barrel', namespace: 'stub' }));
            build.onLoad({ filter: /^form-barrel$/, namespace: 'stub' }, () => ({
               contents: `export { default as FormField } from ${JSON.stringify(`${sourceRoot}/components/common/form/FormField/FormField`)}; export const Icon = () => null;`,
               loader: 'js',
               resolveDir: sourceRoot,
            }));
            build.onLoad({ filter: /\.scss$/ }, () => ({ contents: 'export default new Proxy({}, {get:(_,key)=>String(key)});', loader: 'js' }));
            build.onLoad({ filter: /[\\/]Icon\.tsx$/ }, () => ({ contents: 'export default ()=>null;', loader: 'js' }));
            // The upgrade prompt is replaced by a marker so tests can see whether it opened.
            build.onLoad({ filter: /[\\/]Upgrade[\\/]Upgrade\.tsx$/ }, () => ({
               contents: 'import { createElement } from "react"; export default ({ focus }) => createElement("div", { "data-upgrade": focus });',
               loader: 'js',
            }));
         },
      },
   ],
});
const bundle = { exports: {} as any };
new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, bundle, bundle.exports);
const { Select, MultiSelect, StorageProviderSelect, TimePicker, RadioIconSelect, Tristate, PlanStrategySettings } = bundle.exports;

async function mount(element: any) {
   const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.internal/' });
   const keys = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'];
   const old = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
   for (const key of keys)
      Object.defineProperty(globalThis, key, {
         configurable: true,
         writable: true,
         value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : (dom.window as any)[key],
      });
   const root = require('react-dom/client').createRoot(dom.window.document.getElementById('root'));
   await act(async () => root.render(element));
   const doc = dom.window.document;
   return {
      doc,
      all: (selector: string) => [...doc.querySelectorAll<HTMLElement>(selector)],
      click: async (node: Element) => act(async () => (node as HTMLElement).click()),
      key: async (node: Element, key: string) =>
         act(async () => {
            node.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
         }),
      close: async () => {
         await act(async () => root.unmount());
         dom.window.close();
         for (const [key, value] of old)
            if (value) Object.defineProperty(globalThis, key, value);
            else delete (globalThis as any)[key];
      },
   };
}

const options = [
   { label: 'Daily', value: 'daily' },
   { label: 'Weekly', value: 'weekly' },
   { label: 'Monthly', value: 'monthly', disabled: true },
];

function inForm(control: any, onSubmit: () => void) {
   return React.createElement(
      'form',
      {
         onSubmit: (event: any) => {
            event.preventDefault();
            onSubmit();
         },
      },
      control,
   );
}

test('Select caret is a labelled, non-submitting disclosure inside a form', async () => {
   let submits = 0;
   const ui = await mount(
      inForm(React.createElement(Select, { label: 'Schedule', fieldValue: 'daily', options, onUpdate: () => {} }), () => submits++),
   );
   try {
      const caret = ui.all('button')[0];
      assert.equal(caret.getAttribute('type'), 'button');
      assert.ok(caret.getAttribute('aria-label'), 'caret needs an accessible name');
      assert.equal(caret.getAttribute('aria-haspopup'), 'listbox');
      assert.equal(caret.getAttribute('aria-expanded'), 'false');
      await ui.click(caret);
      assert.equal(submits, 0, 'opening the dropdown must not submit the form');
      assert.equal(caret.getAttribute('aria-expanded'), 'true');
   } finally {
      await ui.close();
   }
});

test('Select options are keyboard-selectable listbox options and disabled options stay inert', async () => {
   const updates: string[] = [];
   const ui = await mount(
      React.createElement(Select, {
         label: 'Schedule',
         fieldValue: 'daily',
         options,
         search: true,
         onUpdate: (value: string) => updates.push(value),
      }),
   );
   try {
      await ui.click(ui.all('button')[0]);
      assert.equal(ui.all('[role="listbox"]').length, 1);
      const [daily, weekly, monthly] = ui.all('[role="option"]');
      assert.equal(daily.getAttribute('aria-selected'), 'true');
      assert.equal(weekly.getAttribute('aria-selected'), 'false');
      assert.equal(weekly.tabIndex, 0);
      assert.equal(monthly.getAttribute('aria-disabled'), 'true');
      assert.equal(monthly.tabIndex, -1);
      await ui.key(monthly, 'Enter');
      assert.deepEqual(updates, []);
      await ui.key(weekly, 'Enter');
      assert.deepEqual(updates, ['weekly']);
      assert.equal(ui.all('[role="listbox"]').length, 0, 'choosing an option closes the list, as a click does');
   } finally {
      await ui.close();
   }
});

test('Select search clear button is labelled and does not submit', async () => {
   let submits = 0;
   const ui = await mount(inForm(React.createElement(Select, { fieldValue: 'daily', options, search: true, onUpdate: () => {} }), () => submits++));
   try {
      await ui.click(ui.all('button')[0]);
      const input = ui.doc.querySelector('input')!;
      await act(async () => {
         const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
         setter.call(input, 'week');
         input.dispatchEvent(new (input.ownerDocument.defaultView as any).Event('input', { bubbles: true }));
      });
      const clear = ui.all('button').find((button) => button.getAttribute('aria-label') === 'Clear search');
      assert.ok(clear, 'clear-search button needs a name');
      assert.equal(clear.getAttribute('type'), 'button');
      await ui.click(clear);
      assert.equal(submits, 0);
   } finally {
      await ui.close();
   }
});

test('MultiSelect toggles options with Space and marks its listbox multiselectable', async () => {
   let value: string[] = ['daily'];
   let submits = 0;
   const ui = await mount(
      inForm(
         React.createElement(MultiSelect, {
            label: 'Days',
            fieldValue: value,
            options: options.slice(0, 2),
            onUpdate: (next: string[]) => {
               value = next;
            },
         }),
         () => submits++,
      ),
   );
   try {
      const caret = ui.all('button')[0];
      assert.equal(caret.getAttribute('type'), 'button');
      assert.ok(caret.getAttribute('aria-label'));
      await ui.click(caret);
      assert.equal(submits, 0);
      assert.equal(ui.all('[role="listbox"]')[0].getAttribute('aria-multiselectable'), 'true');
      const weekly = ui.all('[role="option"]')[1];
      assert.equal(weekly.getAttribute('aria-selected'), 'false');
      await ui.key(weekly, ' ');
      assert.deepEqual(value, ['daily', 'weekly']);
   } finally {
      await ui.close();
   }
});

test('StorageProviderSelect caret does not submit and providers select with Enter', async () => {
   let submits = 0;
   const updates: string[] = [];
   const ui = await mount(
      inForm(
         React.createElement(StorageProviderSelect, {
            label: 'Provider',
            fieldValue: '',
            options: [
               { label: 'SFTP', value: 'sftp' },
               { label: 'S3', value: 's3' },
            ],
            onUpdate: (value: string) => updates.push(value),
         }),
         () => submits++,
      ),
   );
   try {
      const caret = ui.all('button')[0];
      assert.equal(caret.getAttribute('type'), 'button');
      assert.ok(caret.getAttribute('aria-label'));
      await ui.click(caret);
      assert.equal(submits, 0);
      await ui.key(ui.all('[role="option"]')[1], 'Enter');
      assert.deepEqual(updates, ['s3']);
   } finally {
      await ui.close();
   }
});

test('TimePicker caret does not submit and AM/PM expose which one is active', async () => {
   let submits = 0;
   const ui = await mount(inForm(React.createElement(TimePicker, { label: 'Time', fieldValue: '10:00AM', onUpdate: () => {} }), () => submits++));
   try {
      const caret = ui.all('button')[0];
      assert.equal(caret.getAttribute('type'), 'button');
      assert.ok(caret.getAttribute('aria-label'));
      await ui.click(caret);
      assert.equal(submits, 0);
      assert.equal(caret.getAttribute('aria-expanded'), 'true');
      const am = ui.all('button').find((b) => b.textContent?.trim() === 'AM')!;
      const pm = ui.all('button').find((b) => b.textContent?.trim() === 'PM')!;
      assert.equal(am.getAttribute('aria-pressed'), 'true');
      assert.equal(pm.getAttribute('type'), 'button');
      await ui.click(pm);
      assert.equal(submits, 0);
      assert.equal(pm.getAttribute('aria-pressed'), 'true');
      assert.equal(am.getAttribute('aria-pressed'), 'false');
   } finally {
      await ui.close();
   }
});

test('RadioIconSelect is a keyboard radio group and keeps the disabled-option callback', async () => {
   const updates: string[] = [];
   const disabledClicks: string[] = [];
   const ui = await mount(
      React.createElement(RadioIconSelect, {
         label: 'Strategy',
         fieldValue: 'incremental',
         options: [
            { label: 'Incremental', description: 'Snapshots', value: 'incremental', icon: 'box' },
            { label: 'Sync', description: 'Mirror', value: 'sync', icon: 'sync' },
            { label: 'System', description: 'Image', value: 'system', icon: 'linux', disabled: true },
         ],
         onUpdate: (value: string) => updates.push(value),
         onDisableClick: (value: string) => disabledClicks.push(value),
      }),
   );
   try {
      assert.equal(ui.all('[role="radiogroup"]').length, 1);
      const [incremental, sync, system] = ui.all('[role="radio"]');
      assert.equal(incremental.getAttribute('aria-checked'), 'true');
      assert.equal(sync.getAttribute('aria-checked'), 'false');
      assert.equal(sync.tabIndex, 0);
      assert.equal(system.getAttribute('aria-disabled'), 'true');
      await ui.key(sync, 'Enter');
      assert.deepEqual(updates, ['sync']);
      // A disabled option still reports through onDisableClick, exactly as a mouse click does.
      await ui.key(system, ' ');
      assert.deepEqual(disabledClicks, ['system']);
      assert.deepEqual(updates, ['sync']);
   } finally {
      await ui.close();
   }
});

const radioOptions = [
   { label: 'Incremental', description: 'Snapshots', value: 'incremental', icon: 'box' },
   { label: 'Sync', description: 'Mirror', value: 'sync', icon: 'sync' },
   { label: 'System', description: 'Image', value: 'system', icon: 'linux', disabled: true },
];
const radioNamed = (ui: any, text: string) => ui.all('[role="radio"]').find((r: HTMLElement) => r.textContent?.includes(text))!;

test('RadioIconSelect: an individually disabled option without onDisableClick is never selected', async () => {
   const updates: string[] = [];
   const ui = await mount(
      React.createElement(RadioIconSelect, {
         label: 'Strategy',
         fieldValue: 'incremental',
         options: radioOptions,
         onUpdate: (value: string) => updates.push(value),
      }),
   );
   try {
      const system = radioNamed(ui, 'System');
      assert.equal(system.getAttribute('aria-disabled'), 'true');
      assert.equal(system.tabIndex, -1);
      await ui.click(system);
      await ui.key(system, 'Enter');
      await ui.key(system, ' ');
      assert.deepEqual(updates, [], 'a disabled option must not reach onUpdate by mouse or keyboard');
      await ui.click(radioNamed(ui, 'Sync'));
      assert.deepEqual(updates, ['sync'], 'enabled options keep working');
   } finally {
      await ui.close();
   }
});

test('RadioIconSelect: a disabled group ignores mouse and keyboard and announces it', async () => {
   const updates: string[] = [];
   const disabledClicks: string[] = [];
   const ui = await mount(
      React.createElement(RadioIconSelect, {
         label: 'Strategy',
         fieldValue: 'incremental',
         options: radioOptions,
         disabled: true,
         onUpdate: (value: string) => updates.push(value),
         onDisableClick: (value: string) => disabledClicks.push(value),
      }),
   );
   try {
      assert.equal(ui.all('[role="radiogroup"]')[0].getAttribute('aria-disabled'), 'true');
      for (const radio of ui.all('[role="radio"]')) {
         assert.equal(radio.getAttribute('aria-disabled'), 'true');
         assert.equal(radio.tabIndex, -1, 'a disabled group is removed from the tab order');
      }
      const sync = radioNamed(ui, 'Sync');
      await ui.click(sync);
      await ui.key(sync, 'Enter');
      await ui.key(sync, ' ');
      await ui.click(radioNamed(ui, 'System'));
      await ui.key(radioNamed(ui, 'System'), 'Enter');
      assert.deepEqual(updates, []);
      assert.deepEqual(disabledClicks, [], 'a disabled group does not open option prompts either');
      assert.equal(radioNamed(ui, 'Incremental').getAttribute('aria-checked'), 'true', 'the saved value stays visible');
   } finally {
      await ui.close();
   }
});

// Mirrors the strategy options PlanForm passes in Add Plan and Edit Plan.
const strategyOptions = [
   { value: 'backup', icon: 'backup', label: 'Incremental Backup', description: 'Incremental snapshots' },
   { value: 'sync', icon: 'sync', label: 'Real-time Sync', description: 'Identical source', disabled: true },
   { value: 'storage-sync', icon: 'storage-sync', label: 'Storage Sync', description: 'Storage to storage', disabled: true },
   { value: 'rescue', icon: 'rescue', label: 'Linux Server Backup', description: 'Bootable image', disabled: true },
];

test('Edit Plan: the edit-mode strategy selector cannot change an existing plan strategy or open the upgrade prompt', async () => {
   const updates: string[] = [];
   const ui = await mount(
      React.createElement(PlanStrategySettings, {
         // An existing storage-source plan: changing it to "backup" would be invalid.
         plan: { sourceType: 'storage', method: 'sync' },
         disabled: true,
         options: strategyOptions,
         onUpdate: (method: string) => updates.push(method),
      }),
   );
   try {
      assert.equal(radioNamed(ui, 'Storage Sync').getAttribute('aria-checked'), 'true');
      const incremental = radioNamed(ui, 'Incremental Backup');
      await ui.click(incremental);
      await ui.key(incremental, 'Enter');
      await ui.key(incremental, ' ');
      assert.deepEqual(updates, [], 'Edit Plan must not change the backup strategy');
      await ui.click(radioNamed(ui, 'Linux Server Backup'));
      assert.equal(ui.all('[data-upgrade]').length, 0, 'no upgrade prompt from a locked selector');
   } finally {
      await ui.close();
   }
});

test('Add Plan: the same strategy selector stays selectable and still offers the upgrade prompt', async () => {
   const updates: string[] = [];
   const ui = await mount(
      React.createElement(PlanStrategySettings, {
         plan: { sourceType: 'device', method: 'backup' },
         disabled: false,
         options: strategyOptions,
         onUpdate: (method: string) => updates.push(method),
      }),
   );
   try {
      await ui.key(radioNamed(ui, 'Incremental Backup'), 'Enter');
      assert.deepEqual(updates, ['backup']);
      await ui.click(radioNamed(ui, 'Linux Server Backup'));
      assert.equal(ui.all('[data-upgrade="rescue"]').length, 1, 'unavailable strategies still explain themselves');
      assert.deepEqual(updates, ['backup'], 'an unavailable strategy is never selected');
   } finally {
      await ui.close();
   }
});

test('PlanForm locks the strategy selector only in edit mode', () => {
   const form = source('components/Plan/PlanForm/PlanForm.tsx');
   assert.match(form, /<PlanStrategySettings[\s\S]*?disabled=\{type === 'edit' \? true : false\}/);
});

test('Tristate options are keyboard radios and disabled options are ignored', async () => {
   const updates: string[] = [];
   const ui = await mount(
      React.createElement(Tristate, {
         label: 'Mode',
         fieldValue: 'auto',
         options: [
            { label: 'Auto', value: 'auto' },
            { label: 'On', value: 'on' },
            { label: 'Off', value: 'off', disabled: true },
         ],
         onUpdate: (value: string) => updates.push(value),
      }),
   );
   try {
      assert.equal(ui.all('[role="radiogroup"]').length, 1);
      const radios = ui.all('[role="radio"]');
      const on = radios.find((r) => r.textContent?.includes('On'))!;
      const off = radios.find((r) => r.textContent?.includes('Off'))!;
      assert.equal(off.getAttribute('aria-disabled'), 'true');
      assert.equal(off.tabIndex, -1);
      await ui.key(off, 'Enter');
      assert.deepEqual(updates, []);
      await ui.key(on, ' ');
      assert.deepEqual(updates, ['on']);
   } finally {
      await ui.close();
   }
});

function source(path: string) {
   return readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
}

test('icon-only selection toggles, range options and the backup title actions are named and keyboard reachable', () => {
   const fileManager = source('components/common/FileManager/FileManager.tsx');
   assert.match(fileManager, /aria-label=\{`Select \$\{item\.name\}`\}/);
   assert.match(fileManager, /aria-pressed=\{isPathSelected\(item\.path\)\}/);
   const restore = source('components/Restore/RestoreFileSelector/RestoreFileSelector.tsx');
   assert.equal((restore.match(/aria-label=\{`Select /g) || []).length, 2, 'file and folder selection buttons are named');
   assert.equal((restore.match(/aria-pressed=/g) || []).length, 2, 'file and folder selection buttons expose state');
   const chart = source('components/Plan/PlanSizeChart/PlanSizeChart.tsx');
   assert.match(chart, /aria-expanded=\{open\}/);
   assert.match(chart, /role="option"/);
   assert.match(chart, /onKeyDown=/);
   const backups = source('components/Plan/Backups/Backups.tsx');
   assert.match(backups, /aria-label="Edit title and description"/);
   assert.match(backups, /aria-label=\{isSync \? undefined : `Show events for /);
   assert.match(backups, /onKeyDown=\{isSync \? undefined : onActivateKey\(\(\) => setShowBackupEvents\(id\)\)\}/);
   const styles = source('components/Plan/Backups/Backups.module.scss');
   const editIcon = /\.editIcon \{[^}]*\}/.exec(styles)![0];
   assert.ok(!editIcon.includes('visibility: hidden'), 'a visibility:hidden control cannot receive keyboard focus');
   assert.match(styles, /\.editIcon:focus-visible/);
});

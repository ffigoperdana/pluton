import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { ComponentType } from 'react';
const frontendRequire = createRequire(new URL('../package.json', import.meta.url));
const backendRequire = createRequire(new URL('../../backend/package.json', import.meta.url));
const React = frontendRequire('react');
const { renderToStaticMarkup } = frontendRequire('react-dom/server');
const { JSDOM } = frontendRequire('jsdom');
const modules: Record<string, ComponentType<Record<string, unknown>>> = {};
for (const [name, component] of Object.entries({
   card: 'PlanItems/PlanItem',
   summary: 'RecoveryTesting/RecoverySummary',
   exclusions: 'PlanSettings/PlanBackupExclusions',
})) {
   const result = await backendRequire('esbuild').build({
      entryPoints: [fileURLToPath(new URL(`../src/components/Plan/${component}.tsx`, import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      jsx: 'automatic',
      write: false,
      external: ['react', 'react/jsx-runtime', 'react-dom', 'react-router'],
      plugins: [
         {
            name: 'plan-view-fixture',
            setup(builder: { onLoad: (options: { filter: RegExp }, loader: () => { contents: string; loader: string }) => void }) {
               const load = (filter: RegExp, contents: string) => builder.onLoad({ filter }, () => ({ contents, loader: 'js' }));
               load(/\.scss$/, 'export default {};');
               load(
                  /[\\/]services[\\/]plans\.ts$/,
                  'export const useDeletePlan=()=>({}), usePausePlan=()=>({}), usePerformBackup=()=>({}), useResumePlan=()=>({});',
               );
               load(/[\\/]services[\\/]storage\.ts$/, 'export const useGetStorages=()=>({data:{result:[]}});');
               load(/[\\/]services[\\/]recoveryTests\.ts$/, 'export const useRecoveryTests=()=>({data:[]});');
               load(/[\\/](PlanStorageInfo|PlanHistory)\.tsx$/, 'export default ()=>null;');
               load(/[\\/]utils[\\/]plans\.ts$/, 'export const planIntervalName=()=>"Daily";');
               load(
                  /[\\/]utils[\\/]helpers\.ts$/,
                  'export const formatDateTime=value=>value, timeAgo=()=>"Today", getBackupIconName=()=>"backup", formatBytes=()=>"0 B";',
               );
            },
         },
      ],
   });
   const module = { exports: {} as { default: ComponentType<Record<string, unknown>> } };
   new Function('require', 'module', 'exports', result.outputFiles[0].text)(frontendRequire, module, module.exports);
   modules[name] = module.exports.default;
}
const database = { engine: 'mariadb', database: 'synthetic-private-name', password: 'synthetic-private-marker' };
const plan = {
   id: 'plan-01',
   title: 'Example application',
   method: 'backup',
   sourceType: 'device',
   sourceId: 'agent-01',
   settings: { interval: { type: 'daily' }, remoteLifecycle: { version: 1, database } },
   sourceConfig: { includes: ['/srv/example-app'], excludes: ['.git/', '.cache/'] },
   stats: { snapshots: [] },
   backups: [],
   tags: [],
   storage: { id: 'storage-01', name: 'Example storage' },
   device: { id: 'agent-01', name: 'app-01' },
};

test('actual database cards/details distinguish configuration from unverified or failed snapshots and never render secrets', () => {
   for (const backups of [[], [{ id: 'backup-01', status: 'failed', started: '2026-01-01', completionStats: {} }]]) {
      const card = renderToStaticMarkup(
         React.createElement(
            frontendRequire('react-router').MemoryRouter,
            {},
            React.createElement(modules.card, { plan: { ...plan, backups }, layout: 'grid' }),
         ),
      );
      const summary = renderToStaticMarkup(React.createElement(modules.summary, { plan: { ...plan, backups } }));
      assert.match(card, /DB · MariaDB/);
      assert.match(summary, /Database: MariaDB · 1 configured/);
      assert.match(summary, /Not tested/);
      assert.doesNotMatch(card + summary, /synthetic-private/);
   }
   const filesystem = { ...plan, settings: { interval: { type: 'daily' } } };
   const card = renderToStaticMarkup(
      React.createElement(frontendRequire('react-router').MemoryRouter, {}, React.createElement(modules.card, { plan: filesystem })),
   );
   assert.doesNotMatch(card, /DB ·/);
   assert.match(renderToStaticMarkup(React.createElement(modules.summary, { plan: filesystem })), /Database: Not configured/);
});

test('actual exclusion editor displays saved values, scope/recovery warnings and Agent capability requirement', () => {
   const html = renderToStaticMarkup(React.createElement(modules.exclusions, { plan, device: { agent: { capabilities: {} } }, onUpdate: () => {} }));
   const dom = new JSDOM(html);
   assert.equal(dom.window.document.querySelector('textarea')!.value, '.git/\n.cache/');
   assert.match(html, /will not exist in the recovery snapshot/);
   assert.match(html, /Update this Agent/);
   dom.window.close();
});

test('actual editor changes/removes exclusions and surfaces invalid patterns without recreating the plan', async () => {
   const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.invalid' });
   const previous = new Map<string, PropertyDescriptor | undefined>();
   for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      navigator: dom.window.navigator,
      HTMLElement: dom.window.HTMLElement,
      IS_REACT_ACT_ENVIRONMENT: true,
   })) {
      previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
   }
   const { createRoot } = frontendRequire('react-dom/client'),
      root = createRoot(dom.window.document.getElementById('root'));
   let current = plan;
   const render = () =>
      root.render(
         React.createElement(modules.exclusions, {
            plan: current,
            device: { agent: { capabilities: { backupExclusionsVersion: 1 } } },
            onUpdate: (value: typeof plan) => {
               current = value;
               render();
            },
         }),
      );
   try {
      await React.act(async () => render());
      const textarea = dom.window.document.querySelector('textarea')!;
      for (const text of ['node_modules/\n**/cache/', '../escape', '']) {
         await React.act(async () => {
            Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
            textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
         });
         assert.deepEqual(current.sourceConfig.excludes, text ? text.split('\n') : []);
         assert.equal(textarea.getAttribute('aria-invalid'), text === '../escape' ? 'true' : 'false');
         assert.equal(current.id, plan.id);
      }
   } finally {
      await React.act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of previous) {
         if (descriptor) Object.defineProperty(globalThis, key, descriptor);
         else Reflect.deleteProperty(globalThis, key);
      }
   }
});

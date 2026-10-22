import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { SourceAccessView } from '../src/@types/agentSourceAccess.ts';

const require = createRequire(new URL('../package.json', import.meta.url));
const backendRequire = createRequire(new URL('../../backend/package.json', import.meta.url));
const React = require('react');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { act } = React;
const { JSDOM } = require('jsdom');
const revision = 'a'.repeat(64);
const appRoot = '/srv/example-app';
const workerRoot = '/srv/example-worker';
const access = (): SourceAccessView => ({
   supported: true,
   online: true,
   reportFresh: true,
   report: {
      version: 1,
      hostPolicyRevision: revision,
      effectiveVersion: 3,
      approvedRoots: [appRoot, workerRoot],
      effectiveRoots: [appRoot],
      rootStatuses: [{ path: appRoot, status: 'readable' }],
   },
   requests: [],
   affectedPlans: [],
});

async function component(relative: string) {
   const output = await backendRequire('esbuild').build({
      entryPoints: [fileURLToPath(new URL(`../src/${relative}.tsx`, import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      jsx: 'automatic',
      write: false,
      external: ['react', 'react/jsx-runtime', 'react-dom', '@tanstack/react-query'],
      plugins: [
         {
            name: 'source-access-fixtures',
            setup(builder: any) {
               const load = (filter: RegExp, contents: string) => builder.onLoad({ filter }, () => ({ contents, loader: 'js' }));
               load(/\.scss$/, 'export default {};');
               load(/[\\/]Icon\.tsx$/, 'export default ()=>null;');
               load(/[\\/]Modal\.tsx$/, `import React from 'react';export default p=>React.createElement('section',{},p.children);`);
               load(/[\\/]SidePanel\.tsx$/, `import React from 'react';export default p=>React.createElement('section',{},p.children,p.footer);`);
               load(
                  /[\\/]services[\\/]agentSourceAccess\.ts$/,
                  `
            export const useSourceAccess=()=>globalThis.__sourceAccessUi.query;
            export const useSourceAccessHistory=()=>globalThis.__sourceAccessUi.history;
            export const useSourceAccessMutation=(id,kind)=>globalThis.__sourceAccessUi.mutations[kind];
            export const useRefreshSourceAccess=()=>globalThis.__sourceAccessUi.refresh;
            export const useCancelSourceAccess=()=>globalThis.__sourceAccessUi.cancel;
            export const useSourceModeSetup=()=>globalThis.__sourceAccessUi.modeSetup;
         `,
               );
               load(
                  /[\\/]services[\\/]devices\.ts$/,
                  `
            export const useGetDevice=()=>({data:{result:{device:{id:'main'}}}});
            export const useGetDevices=()=>({data:{success:true,result:globalThis.__sourceAccessUi.devices}});
            export const useCreateAgentEnrollment=()=>globalThis.__sourceAccessUi.enrollment;
            export const useRevokeAgentEnrollment=()=>({isPending:false,mutateAsync:async()=>{}});
         `,
               );
               load(/[\\/]services[\\/]storage\.ts$/, 'export const useGetStorages=()=>({data:{result:[]}});');
               load(/[\\/]services[\\/]settings\.ts$/, 'export const useGetSettings=()=>({data:{result:{settings:{}}}});');
               load(/[\\/]utils[\\/]plans\.ts$/, 'export const isPlanSettingsValid=()=>true;');
               load(/[\\/]PlanAdvancedSettings\.tsx$/, 'export default ()=>null;');
               load(/[\\/]PlanReplicationSettings\.tsx$/, 'export default ()=>null;');
               load(/[\\/]PlanPruneSettings\.tsx$/, 'export default ()=>null;');
               load(/[\\/]PathPicker\.tsx$/, 'export default ()=>null;');
               load(/[\\/]StoragePicker\.tsx$/, 'export default ()=>null;');
               load(/[\\/]IntervalField\.tsx$/, 'export default ()=>null;');
            },
         },
      ],
   });
   const module = { exports: {} as any };
   new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, module, module.exports);
   return module.exports.default;
}
const SourceAccess = await component('components/Device/SourceAccess/SourceAccess');
const ModeSetup = await component('components/Device/SourceAccess/SourceAuthorizationSetup');
const Picker = await component('components/Plan/PlanSettings/RemoteSourcePicker');
const PlanForm = await component('components/Plan/PlanForm/PlanForm');
const Enrollment = await component('components/Device/AgentEnrollment/AgentEnrollment');

async function fixture(Component: any, initial: Record<string, unknown>, custom: Record<string, unknown> = {}) {
   const dom = new JSDOM('<div id="root"></div>', { url: 'https://example.internal/' });
   const keys = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT', '__sourceAccessUi'];
   const previous = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
   const submissions: any[] = [];
   const updates: any[] = [];
   const state = {
      query: { data: access(), isPending: false, isError: false },
      history: { data: { requests: [], total: 0, pageSize: 10, cursor: 'synthetic-history-cursor' }, isPending: false, isFetching: false },
      modeSetup: {
         isPending: false,
         mutateAsync: async (payload: any) => {
            submissions.push({ kind: 'mode-setup', ...payload });
            return { requestId: `mode-setup-${submissions.length}`, status: 'queued' };
         },
      },
      mutations: Object.fromEntries(
         ['validate', 'requests'].map((kind) => [
            kind,
            {
               isPending: false,
               mutateAsync: async (payload: any) => {
                  submissions.push({ kind, ...payload });
                  return { requestId: `request-${submissions.length}`, status: 'queued' };
               },
            },
         ]),
      ),
      refresh: {
         isPending: false,
         mutateAsync: async () => {
            submissions.push({ kind: 'refresh' });
         },
      },
      cancel: {
         isPending: false,
         mutateAsync: async (requestId: string) => {
            submissions.push({ kind: 'cancel', requestId });
         },
      },
      enrollment: {
         isPending: false,
         isError: false,
         mutateAsync: async () => ({
            id: 'enrollment-01',
            token: 'synthetic-enrollment-token',
            serverUrl: 'https://example.internal',
            insecureHttpAllowed: false,
            expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
            distribution: { repositoryUrl: 'https://git.example.internal/agents/pluton-agent.git', commit: 'a'.repeat(40), version: '0.7.0', contract: 'pluton-agent-standalone-v1' },
         }),
      },
      devices: [
         {
            id: 'device-01',
            name: 'app-01',
            isRemote: true,
            agent: {
               status: 'online',
               resticVersion: '0.18.0',
               rcloneVersion: '1.70.0',
               capabilities: { filesystemRootsConfigured: true, commandTypes: ['BACKUP_FILESYSTEM'], sourceAccessVersion: 1 },
            },
         },
      ],
      ...custom,
   };
   for (const key of keys)
      Object.defineProperty(globalThis, key, {
         configurable: true,
         writable: true,
         value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : key === '__sourceAccessUi' ? state : (dom.window as any)[key],
      });
   const { createRoot } = require('react-dom/client');
   const root = createRoot(dom.window.document.getElementById('root'));
   const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
   let props: any = { onUpdate: (value: any) => updates.push(value), onDraftBlocked: (value: any) => updates.push({ blocked: value }), ...initial };
   const renderComponent = () =>
      root.render(React.createElement(QueryClientProvider, { client: queryClient }, React.createElement(Component, props)));
   await act(async () => renderComponent());
   const render = async (next: Record<string, unknown> = {}) => {
      props = { ...props, ...next };
      await act(async () => renderComponent());
   };
   const button = (label: string) =>
      [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.includes(label));
   const setValue = async (selector: string, value: string) => {
      const field = dom.window.document.querySelector(selector)!;
      await act(async () => {
         const prototype = field.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
         Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value);
         field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
         field.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      });
   };
   return {
      dom,
      state,
      updates,
      submissions,
      render,
      button,
      setValue,
      text: () => dom.window.document.body.textContent || '',
      cleanup: async () => {
         await act(async () => root.unmount());
         queryClient.clear();
         dom.window.close();
         for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete (globalThis as any)[key];
      },
   };
}

test('Source Access lists exact canonical roots, enables a host-approved root and validates without policy mutation', async () => {
   const ui = await fixture(SourceAccess, { deviceId: 'device-01', agentId: 'agent-01' });
   try {
      assert.match(ui.text(), /Host-approved and enabled roots/);
      assert.match(ui.text(), /Effective roots/);
      assert.equal(ui.submissions.length, 0);
      await ui.setValue('textarea', '/srv/example-new');
      await act(async () => ui.button('Validate paths')!.click());
      assert.deepEqual(ui.submissions[0], {
         kind: 'validate',
         expectedVersion: 3,
         expectedHostPolicyRevision: revision,
         roots: ['/srv/example-new'],
      });
      assert.equal(ui.state.query.data.report!.effectiveRoots.length, 1);
      const toggle = ui.dom.window.document.querySelector<HTMLInputElement>(`input[aria-label="Enable ${workerRoot}"]`)!;
      await act(async () => toggle.click());
      await act(async () => ui.button('Apply enabled roots')!.click());
      assert.deepEqual(ui.submissions[1], {
         kind: 'requests',
         expectedVersion: 3,
         expectedHostPolicyRevision: revision,
         roots: [appRoot, workerRoot],
      });
   } finally {
      await ui.cleanup();
   }
});

test('disabling access requires every affected plan paused and explicit exact-ID confirmation', async () => {
   const data = access();
   data.affectedPlans = [{ id: 'plan-01', title: 'Example application', sourcePath: `${appRoot}/public`, isActive: true }];
   const ui = await fixture(SourceAccess, { deviceId: 'device-01', agentId: 'agent-01' }, { query: { data, isPending: false, isError: false } });
   try {
      await act(async () => ui.dom.window.document.querySelector<HTMLInputElement>(`input[aria-label="Enable ${appRoot}"]`)!.click());
      assert.match(ui.text(), /Active — pause required/);
      assert.equal(ui.button('Apply enabled roots')!.disabled, true);
      data.affectedPlans[0].isActive = false;
      await ui.render();
      assert.equal(ui.button('Apply enabled roots')!.disabled, true);
      const confirmation = [...ui.dom.window.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((item) =>
         item.parentElement!.textContent!.includes('I reviewed'),
      )!;
      await act(async () => confirmation.click());
      await act(async () => ui.button('Apply enabled roots')!.click());
      assert.deepEqual(ui.submissions, [
         { kind: 'requests', expectedVersion: 3, expectedHostPolicyRevision: revision, roots: [], confirmedAffectedPlanIds: ['plan-01'] },
      ]);
   } finally {
      await ui.cleanup();
   }
});

test('offline, stale, unsupported and administrator errors never permit enabling access', async () => {
   for (const patch of [{ online: false }, { reportFresh: false }, { supported: false }]) {
      const ui = await fixture(
         SourceAccess,
         { deviceId: 'device-01', agentId: 'agent-01' },
         { query: { data: { ...access(), ...patch }, isPending: false, isError: false } },
      );
      try {
         assert.equal(ui.submissions.length, 0);
         assert.equal(ui.button('Apply enabled roots')?.disabled ?? true, true);
      } finally {
         await ui.cleanup();
      }
   }
   const ui = await fixture(
      SourceAccess,
      { deviceId: 'device-01', agentId: 'agent-01' },
      { query: { data: access(), error: Object.assign(new Error('forbidden'), { status: 403 }), isPending: false, isError: true } },
   );
   try {
      assert.match(ui.text(), /authenticated administrator/);
      assert.ok(!ui.text().includes(appRoot));
   } finally {
      await ui.cleanup();
   }
});

test('selected canonical children can be disabled even when only their parent is host-approved', async () => {
   const data = access();
   const child = `${appRoot}/public`;
   data.report!.approvedRoots = [appRoot];
   data.report!.effectiveRoots = [child];
   data.report!.rootStatuses = [{ path: child, status: 'readable' }];
   const ui = await fixture(SourceAccess, { deviceId: 'device-01', agentId: 'agent-01' }, { query: { data, isPending: false, isError: false } });
   try {
      const toggle = ui.dom.window.document.querySelector<HTMLInputElement>(`input[aria-label="Enable ${child}"]`)!;
      assert.equal(toggle.checked, true);
      await act(async () => toggle.click());
      await act(async () => ui.button('Apply enabled roots')!.click());
      assert.deepEqual(ui.submissions[0].roots, []);
   } finally {
      await ui.cleanup();
   }
});

test('adding a root preserves selected unreadable roots until an explicit removal', async () => {
   const data = access();
   data.report!.effectiveRoots = [];
   data.report!.rootStatuses = [{ path: appRoot, status: 'unreadable', code: 'source-root-not-readable' }];
   data.affectedPlans = [{ id: 'plan-01', title: 'Example application', sourcePath: appRoot, isActive: true }];
   const ui = await fixture(SourceAccess, { deviceId: 'device-01', agentId: 'agent-01' }, { query: { data, isPending: false, isError: false } });
   try {
      assert.equal(ui.dom.window.document.querySelector<HTMLInputElement>(`input[aria-label="Enable ${appRoot}"]`)!.checked, true);
      await act(async () => ui.dom.window.document.querySelector<HTMLInputElement>(`input[aria-label="Enable ${workerRoot}"]`)!.click());
      assert.equal(ui.button('Apply enabled roots')!.disabled, false);
      await act(async () => ui.button('Apply enabled roots')!.click());
      assert.deepEqual(ui.submissions[0].roots, [appRoot, workerRoot]);
      assert.equal(ui.submissions[0].confirmedAffectedPlanIds, undefined);
   } finally {
      await ui.cleanup();
   }
});

test('revoked host paths can be deselected but cannot be enabled again', async () => {
   const data = access();
   data.report!.approvedRoots = [];
   data.report!.effectiveRoots = [];
   data.report!.rootStatuses = [{ path: appRoot, status: 'rejected', code: 'outside-approved-roots' }];
   const ui = await fixture(SourceAccess, { deviceId: 'device-01', agentId: 'agent-01' }, { query: { data, isPending: false, isError: false } });
   try {
      const toggle = ui.dom.window.document.querySelector<HTMLInputElement>(`input[aria-label="Enable ${appRoot}"]`)!;
      assert.equal(toggle.disabled, false);
      await act(async () => toggle.click());
      assert.equal(toggle.checked, false);
      assert.equal(toggle.disabled, true);
      assert.match(ui.text(), /host approval revoked/);
   } finally {
      await ui.cleanup();
   }
});

test('changed or reapproved host grants require explicit review and apply even when selected paths are unchanged', async () => {
   for (const code of ['source-host-approval-changed', 'source-host-approval-revoked']) {
      const data = access();
      data.report!.hostPolicyRevision = 'b'.repeat(64);
      data.report!.effectiveRoots = [];
      data.report!.rootStatuses = [{ path: appRoot, status: 'rejected', code }];
      data.affectedPlans = [{ id: 'plan-01', title: 'Example application', sourcePath: appRoot, isActive: true }];
      const ui = await fixture(SourceAccess, { deviceId: 'device-01', agentId: 'agent-01' }, { query: { data, isPending: false, isError: false } });
      try {
         assert.match(ui.text(), /unavailable until you review the new grant and explicitly apply/);
         assert.match(ui.text(), /No roots are enabled/);
         assert.equal(ui.dom.window.document.querySelector<HTMLInputElement>(`input[aria-label="Enable ${appRoot}"]`)!.checked, true);
         assert.equal(ui.button('Apply enabled roots')!.disabled, true);
         assert.equal(ui.submissions.length, 0);
         const review = [...ui.dom.window.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((item) =>
            item.parentElement!.textContent!.includes('I reviewed the changed host approval'),
         )!;
         await act(async () => review.click());
         assert.equal(ui.button('Apply enabled roots')!.disabled, false);
         assert.equal(ui.submissions.length, 0, 'review alone never applies a selection');
         await act(async () => ui.button('Apply enabled roots')!.click());
         assert.deepEqual(ui.submissions, [{ kind: 'requests', expectedVersion: 3, expectedHostPolicyRevision: 'b'.repeat(64), roots: [appRoot] }]);
         assert.deepEqual(data.report!.effectiveRoots, [], 'accepted request is not an effective-access confirmation');
      } finally {
         await ui.cleanup();
      }
   }
});

test('grant re-confirmation cannot enable another selected path outside the current host maximum', async () => {
   const data = access();
   data.report!.approvedRoots = [workerRoot];
   data.report!.effectiveRoots = [];
   data.report!.rootStatuses = [
      { path: appRoot, status: 'rejected', code: 'source-host-approval-revoked' },
      { path: workerRoot, status: 'rejected', code: 'source-host-approval-changed' },
   ];
   data.affectedPlans = [{ id: 'plan-01', title: 'Example application', sourcePath: appRoot, isActive: false }];
   const ui = await fixture(SourceAccess, { deviceId: 'device-01', agentId: 'agent-01' }, { query: { data, isPending: false, isError: false } });
   try {
      const review = () =>
         [...ui.dom.window.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((item) =>
            item.parentElement!.textContent!.includes('I reviewed the changed host approval'),
         )!;
      await act(async () => review().click());
      assert.equal(ui.button('Apply enabled roots')!.disabled, true);
      assert.equal(ui.submissions.length, 0);
      const outside = ui.dom.window.document.querySelector<HTMLInputElement>(`input[aria-label="Enable ${appRoot}"]`)!;
      await act(async () => outside.click());
      assert.equal(outside.checked, false);
      assert.equal(outside.disabled, true);
      assert.match(ui.text(), /Example application — Paused/);
      const removal = [...ui.dom.window.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((item) =>
         item.parentElement!.textContent!.includes('I reviewed every affected plan'),
      )!;
      await act(async () => removal.click());
      await act(async () => review().click());
      await act(async () => ui.button('Apply enabled roots')!.click());
      assert.deepEqual(ui.submissions, [
         { kind: 'requests', expectedVersion: 3, expectedHostPolicyRevision: revision, roots: [workerRoot], confirmedAffectedPlanIds: ['plan-01'] },
      ]);
   } finally {
      await ui.cleanup();
   }
});

test('pending-host validation shows canonical host command and never claims effective backup access', async () => {
   const data = access();
   data.requests = [
      {
         id: 'request-01',
         requestId: 'request-01',
         kind: 'apply',
         status: 'pending-host-approval',
         roots: ['/srv/example-link'],
         expectedVersion: 3,
         expectedHostPolicyRevision: revision,
         validation: [{ requestedPath: '/srv/example-link', canonicalPath: '/srv/example-canonical', status: 'pending-host-approval' }],
         createdAt: '2026-01-01T00:00:00Z',
      },
   ];
   const ui = await fixture(SourceAccess, { deviceId: 'device-01', agentId: 'agent-01' }, { query: { data, isPending: false, isError: false } });
   try {
      assert.match(ui.text(), /Pending host approval/);
      assert.doesNotMatch(ui.text(), /Pending paths cannot be backed up|source-access approve/);
      const details = ui.dom.window.document.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!;
      assert.ok(details, 'request details are collapsed by default');
      await act(async () => details.click());
      assert.equal(details.getAttribute('aria-expanded'), 'true');
      assert.match(ui.text(), /Pending paths cannot be backed up/);
      assert.match(ui.text(), /source-access approve/);
      assert.ok(ui.text().includes("--root '/srv/example-canonical'"));
      assert.match(ui.text(), /Host approval alone does not enable backup access/);
      assert.equal(data.report!.effectiveRoots.includes('/srv/example-canonical'), false);
      let copied = '';
      ui.dom.window.document.execCommand = (command: string) => {
         assert.equal(command, 'copy');
         copied = ui.dom.window.document.querySelector<HTMLTextAreaElement>('textarea[readonly]')!.value;
         return true;
      };
      await act(async () => ui.button('Copy host approval command')!.click());
      assert.ok(copied.includes("--root '/srv/example-canonical'"));
      assert.ok(copied.includes(`--expected-host-policy-revision '${revision}'`));
      assert.ok(ui.button('Copied host approval command'));
      await act(async () => ui.button('Cancel request')!.click());
      assert.deepEqual(ui.submissions, [{ kind: 'cancel', requestId: 'request-01' }]);
   } finally {
      await ui.cleanup();
   }
});

test('plan picker applies effective dropdown roots and canonical validated subpaths only', async () => {
   const data = access();
   const ui = await fixture(Picker, { deviceId: 'device-01', sourcePath: '', isEditing: false, access: data });
   try {
      const options = [...ui.dom.window.document.querySelectorAll<HTMLOptionElement>('option')].map((option) => option.value);
      assert.deepEqual(options, ['', appRoot]);
      await ui.setValue('input[type="text"]', `${appRoot}/link`);
      assert.deepEqual(ui.updates.at(-1), { blocked: true });
      await act(async () => ui.button('Validate source path')!.click());
      data.requests = [
         {
            id: 'request-1',
            requestId: 'request-1',
            kind: 'validate',
            status: 'validated',
            roots: [`${appRoot}/link`],
            expectedVersion: 3,
            expectedHostPolicyRevision: revision,
            validation: [{ requestedPath: `${appRoot}/link`, canonicalPath: `${appRoot}/public`, status: 'approved' }],
            createdAt: '2026-01-01T00:00:00Z',
         },
      ];
      await ui.render();
      assert.ok(ui.button('Use validated canonical path'));
      assert.match(ui.text(), /source access was not changed/);
      await act(async () => ui.button('Use validated canonical path')!.click());
      assert.deepEqual(ui.updates.slice(-2), [`${appRoot}/public`, { blocked: false }]);
   } finally {
      await ui.cleanup();
   }
});

test('plan pending request keeps source unselected and displays actionable Source Access link', async () => {
   const data = access();
   const ui = await fixture(Picker, { deviceId: 'device-01', sourcePath: '', isEditing: false, access: data });
   try {
      await ui.setValue('input[type="text"]', '/srv/example-new');
      await act(async () => ui.button('Request access for this path')!.click());
      assert.deepEqual(ui.submissions[0].roots, [appRoot, '/srv/example-new']);
      assert.ok(ui.updates.every((update) => typeof update !== 'string'));
      assert.match(ui.text(), /does not select a backup source/);
      assert.equal(ui.dom.window.document.querySelector('a')!.getAttribute('href'), '/device/device-01');
      assert.equal(ui.button('Use validated canonical path'), undefined);
   } finally {
      await ui.cleanup();
   }
});

test('rejected and stale source validation cannot apply a path', async () => {
   for (const result of [{ status: 'rejected', code: 'source-root-not-readable' }, { status: 'approved' }]) {
      const data = access();
      const ui = await fixture(Picker, { deviceId: 'device-01', sourcePath: '', isEditing: false, access: data });
      try {
         await ui.setValue('input[type="text"]', `${appRoot}/public`);
         await act(async () => ui.button('Validate source path')!.click());
         data.requests = [
            {
               id: 'request-1',
               requestId: 'request-1',
               kind: 'validate',
               status: 'validated',
               roots: [`${appRoot}/public`],
               expectedVersion: result.status === 'approved' ? 2 : 3,
               expectedHostPolicyRevision: revision,
               validation: [{ requestedPath: `${appRoot}/public`, canonicalPath: `${appRoot}/public`, ...result } as any],
               createdAt: '2026-01-01T00:00:00Z',
            },
         ];
         await ui.render();
         assert.equal(ui.button('Use validated canonical path'), undefined);
         assert.ok(ui.updates.every((update) => typeof update !== 'string'));
         assert.match(ui.text(), result.status === 'approved' ? /host policy changed/ : /source-root-not-readable/);
      } finally {
         await ui.cleanup();
      }
   }
});

test('enrollment generates multiple root flags and explains separate host approval', async () => {
   const ui = await fixture(Enrollment, { close() {} });
   try {
      await ui.setValue('input[type="text"]', 'app-01');
      await act(async () => ui.button('Create enrollment token')!.click());
      await ui.setValue('textarea', `${appRoot}\n${workerRoot}`);
      const commands = [...ui.dom.window.document.querySelectorAll('pre')].map((pre) => pre.textContent || '');
      const installs = commands.filter((command) => command.includes('sudo bash install-agent.sh'));
      assert.equal(installs.length, 1);
      for (const command of installs) assert.equal(command.match(/--allowed-root/g)?.length, 2);
      assert.doesNotMatch(installs[0], /--token|synthetic-enrollment-token|installers\/install-agent|uninstall/);
      assert.equal(ui.text().includes('synthetic-enrollment-token'), false);
      await act(async () => ui.button('Show token')!.click());
      assert.match(ui.text(), /synthetic-enrollment-token/);
      await act(async () => ui.button('Hide token')!.click());
      assert.equal(ui.text().includes('synthetic-enrollment-token'), false);
      assert.match(ui.text(), /Token expires:/);
      assert.match(ui.text(), /single agent can serve multiple application plans/);
      assert.match(ui.text(), /host approval followed by an explicit enable action/);
   } finally {
      await ui.cleanup();
   }
});

test('enrollment failure has a focused in-flow alert outside the input label and clears on retry', async () => {
   const ui = await fixture(Enrollment, { close() {} });
   try {
      const original = ui.state.enrollment.mutateAsync;
      ui.state.enrollment.mutateAsync = async () => {
         ui.state.enrollment.isError = true;
         throw new Error('synthetic enrollment failure');
      };
      await ui.setValue('input[type="text"]', 'app-01');
      await act(async () => ui.button('Create enrollment token')!.click());
      await ui.render();
      const alert = ui.dom.window.document.querySelector<HTMLElement>('[role="alert"]')!;
      assert.equal(alert.textContent?.trim(), 'Could not create enrollment token. Ask the administrator to verify the standalone Agent distribution configuration.');
      assert.equal(alert.parentElement, ui.dom.window.document.querySelector('input[type="text"]')!.parentElement!.parentElement!.parentElement);
      assert.equal(alert.closest('label'), null);
      assert.equal(alert.closest('[class*="formField"]'), null);
      assert.equal(ui.dom.window.document.activeElement, alert, 'focus brings the alert into view after a long dialog submission');
      assert.equal(ui.dom.window.document.querySelector<HTMLInputElement>('input[type="text"]')!.value, 'app-01');
      assert.equal(ui.button('Create enrollment token')!.disabled, false);

      ui.state.enrollment.isError = false;
      ui.state.enrollment.isPending = true;
      await ui.render();
      assert.equal(ui.dom.window.document.querySelector('[role="alert"]'), null);
      assert.equal(ui.button('Creating…')!.disabled, true);
      ui.state.enrollment.isPending = false;
      ui.state.enrollment.mutateAsync = original;
      await ui.render();
      await act(async () => ui.button('Create enrollment token')!.click());
      assert.match(ui.text(), /One-time enrollment token/);
      assert.equal(ui.dom.window.document.querySelector('[role="alert"]'), null);
   } finally { await ui.cleanup(); }
});

test('enrollment fails clearly on unavailable distribution or HTTP without old installer fallback', async () => {
   for (const patch of [{ distribution: undefined }, { serverUrl: 'http://example.internal', insecureHttpAllowed: true }]) {
      const ui = await fixture(Enrollment, { close() {} });
      try {
         const original = ui.state.enrollment.mutateAsync;
         ui.state.enrollment.mutateAsync = async () => ({ ...await original(), ...patch });
         await ui.setValue('input[type="text"]', 'app-01');
         await act(async () => ui.button('Create enrollment token')!.click());
         await ui.setValue('#enrollment-source-roots', appRoot);
         assert.match(ui.text(), /Installation instructions unavailable/);
         assert.equal(ui.button('Copy installation commands'), undefined);
         assert.doesNotMatch(ui.text(), /git clone|installers\/install-agent|--allow-insecure-http/);
         assert.equal(ui.dom.window.localStorage.length, 0);
         assert.equal(ui.dom.window.sessionStorage.length, 0);
      } finally { await ui.cleanup(); }
   }
});

test('expired enrollment token is identified, hidden and cannot generate installation commands', async () => {
   const ui = await fixture(Enrollment, { close() {} });
   try {
      const original = ui.state.enrollment.mutateAsync;
      ui.state.enrollment.mutateAsync = async () => ({ ...await original(), expiresAt: '2020-01-01T00:00:00Z' });
      await ui.setValue('input[type="text"]', 'app-01');
      await act(async () => ui.button('Create enrollment token')!.click());
      await ui.setValue('#enrollment-source-roots', appRoot);
      assert.match(ui.text(), /Token expired/);
      assert.equal(ui.button('Show token')!.disabled, true);
      assert.equal(ui.button('Copy installation commands'), undefined);
      assert.doesNotMatch(ui.text(), /synthetic-enrollment-token/);
   } finally { await ui.cleanup(); }
});

test('form allows legacy unrelated edits and blocks v1 pending paths without mutating settings', async () => {
   const plan = {
      title: 'Example plan',
      sourceId: 'device-01',
      sourceType: 'device',
      method: 'backup',
      sourceConfig: { includes: ['/srv/pending-app'], excludes: [] },
      storage: { id: 'storage-01', name: 'Primary' },
      storagePath: 'example-repository',
      settings: {
         interval: { type: 'daily' },
         notification: { email: { enabled: false }, webhook: { enabled: false } },
         remoteLifecycle: { version: 2, databases: [{ databaseId: 'db_example', passwordConfigured: true }] },
      },
   };
   const original = JSON.stringify(plan);
   let submissions = 0;
   const ui = await fixture(PlanForm, {
      type: 'edit',
      title: 'Edit plan',
      planSettings: plan,
      onPlanSettingsChange() {},
      onSubmit() {
         submissions++;
      },
      isSubmitting: false,
      close() {},
   });
   try {
      assert.equal(ui.button('Update Plan')!.disabled, true);
      assert.match(ui.text(), /Pending access requests cannot be used for backup/);
      ui.state.query.data.supported = false;
      await ui.render();
      assert.equal(ui.button('Update Plan')!.disabled, false);
      await act(async () => ui.button('Update Plan')!.click());
      assert.equal(submissions, 1);
      assert.equal(JSON.stringify(plan), original);
   } finally {
      await ui.cleanup();
   }
});

const formPlan = () => ({
   title: 'Example plan',
   sourceId: 'device-01',
   sourceType: 'device',
   method: 'backup',
   sourceConfig: { includes: [appRoot], excludes: ['/srv/example-app/cache'] },
   storage: { id: 'storage-01', name: 'Primary' },
   storagePath: 'example-repository',
   tags: ['example'],
   settings: {
      interval: { type: 'daily' },
      notification: { email: { enabled: false }, webhook: { enabled: false } },
      remoteLifecycle: { version: 2, databases: [{ databaseId: 'db_example', passwordConfigured: true }] },
      replication: { enabled: true, storages: [{ replicationId: 'replica-01', storageId: 'storage-02', storagePath: 'example-replica' }] },
   },
});

function ControlledForm(props: any) {
   const [plan, setPlan] = React.useState(props.planSettings);
   return React.createElement(PlanForm, {
      ...props,
      planSettings: plan,
      onPlanSettingsChange: (next: any) => {
         props.onChanged?.(next);
         setPlan(next);
      },
   });
}

async function selectValue(ui: Awaited<ReturnType<typeof fixture>>, selector: string, value: string) {
   const select = ui.dom.window.document.querySelector<HTMLSelectElement>(selector)!;
   await act(async () => {
      select.value = value;
      select.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
   });
}

test('canonical source and draft blocking survive source-step unmounts without changing credentials', async () => {
   const initial = formPlan();
   const changes: any[] = [];
   const ui = await fixture(ControlledForm, {
      type: 'add',
      title: 'Add plan',
      planSettings: initial,
      onChanged: (plan: any) => changes.push(plan),
      onSubmit() {},
      isSubmitting: false,
      close() {},
   });
   try {
      await act(async () => ui.button('Next: Configure Source')!.click());
      await selectValue(ui, 'select[id^="approved-source-"]', appRoot);
      await act(async () => ui.button('Next: Setup Schedule')!.click());
      assert.equal(ui.dom.window.document.querySelector('input[id^="remote-source-"]'), null);
      await act(async () => ui.button('Back')!.click());
      assert.equal(ui.dom.window.document.querySelector<HTMLInputElement>('input[id^="remote-source-"]')!.value, appRoot);
      assert.equal(ui.button('Next: Setup Schedule')!.disabled, false);
      await ui.setValue('input[id^="remote-source-"]', '/srv/example-pending');
      assert.equal(ui.button('Next: Setup Schedule')!.disabled, true);
      await act(async () => ui.button('Back')!.click());
      await act(async () => ui.button('Next: Configure Source')!.click());
      assert.equal(ui.button('Next: Setup Schedule')!.disabled, true, 'unmounted draft cannot bypass the form gate');
      await selectValue(ui, 'select[id^="approved-source-"]', appRoot);
      assert.equal(ui.button('Next: Setup Schedule')!.disabled, false);
      assert.deepEqual(changes.at(-1).settings.remoteLifecycle, initial.settings.remoteLifecycle);
      assert.equal(changes.at(-1).settings.remoteLifecycle, initial.settings.remoteLifecycle);
      assert.equal(changes.at(-1).settings.replication, initial.settings.replication);
      assert.deepEqual(changes.at(-1).tags, initial.tags);
   } finally {
      await ui.cleanup();
   }
});

test('device switching clears the old source while preserving destination, lifecycle credentials and replication', async () => {
   const initial = formPlan();
   const changes: any[] = [];
   const second = {
      id: 'device-02',
      name: 'app-02',
      isRemote: true,
      agent: {
         status: 'online',
         resticVersion: '0.18.0',
         rcloneVersion: '1.70.0',
         capabilities: { filesystemRootsConfigured: true, commandTypes: ['BACKUP_FILESYSTEM'], sourceAccessVersion: 1 },
      },
   };
   const ui = await fixture(ControlledForm, {
      type: 'add',
      title: 'Add plan',
      planSettings: initial,
      onChanged: (plan: any) => changes.push(plan),
      onSubmit() {},
      isSubmitting: false,
      close() {},
   });
   try {
      ui.state.devices.push(second);
      await act(async () => ui.button('Next: Configure Source')!.click());
      await ui.setValue('input[id^="remote-source-"]', '/srv/example-pending');
      const dropdown = [...ui.dom.window.document.querySelectorAll('button')].find((button) =>
         button.parentElement?.textContent?.includes('app-01'),
      )!;
      await act(async () => dropdown.click());
      const choice = [...ui.dom.window.document.querySelectorAll('li')].find((item) => item.textContent?.startsWith('app-02'))!;
      await act(async () => choice.click());
      const next = changes.at(-1);
      assert.equal(next.sourceId, 'device-02');
      assert.deepEqual(next.sourceConfig, { includes: [], excludes: [] });
      assert.equal(ui.dom.window.document.querySelector<HTMLInputElement>('#remote-source-device-02')!.value, '');
      assert.equal(ui.button('Next: Setup Schedule')!.disabled, true);
      assert.equal(next.storage, initial.storage);
      assert.equal(next.storagePath, initial.storagePath);
      assert.equal(next.settings.remoteLifecycle, initial.settings.remoteLifecycle);
      assert.equal(next.settings.replication, initial.settings.replication);
   } finally {
      await ui.cleanup();
   }
});

test('new plans on a legacy static agent keep manual sources and nested credentials without requiring an upgrade', async () => {
   const initial = formPlan();
   initial.sourceConfig = { includes: [], excludes: [] };
   const changes: any[] = [];
   let saved = false;
   const data = { ...access(), supported: false };
   const ui = await fixture(
      ControlledForm,
      {
         type: 'add',
         title: 'Add plan',
         planSettings: initial,
         onChanged: (plan: any) => changes.push(plan),
         onSubmit() {
            saved = true;
         },
         isSubmitting: false,
         close() {},
      },
      { query: { data, isPending: false, isError: false } },
   );
   try {
      await act(async () => ui.button('Next: Configure Source')!.click());
      assert.match(ui.text(), /host-configured static roots/);
      const input = ui.dom.window.document.querySelector<HTMLInputElement>('input[id^="remote-source-"]')!;
      assert.equal(input.disabled, false);
      await ui.setValue('input[id^="remote-source-"]', '/srv/../example-app');
      assert.equal(ui.button('Next: Setup Schedule')!.disabled, true);
      await ui.setValue('input[id^="remote-source-"]', appRoot);
      assert.equal(ui.button('Next: Setup Schedule')!.disabled, false);
      await act(async () => ui.button('Next: Setup Schedule')!.click());
      await act(async () => ui.button('Next: Advanced')!.click());
      await act(async () => ui.button('Create Plan')!.click());
      assert.equal(saved, true);
      assert.equal(ui.submissions.length, 0, 'static plan creation does not send v1 access commands');
      assert.deepEqual(changes.at(-1).sourceConfig.includes, [appRoot]);
      assert.equal(changes.at(-1).settings.remoteLifecycle, initial.settings.remoteLifecycle);
      assert.equal(changes.at(-1).settings.replication, initial.settings.replication);
   } finally {
      await ui.cleanup();
   }
});

const delegatedScope = '/srv/example-apps';
const delegatedView = (): SourceAccessView => {
   const data = access();
   data.report!.authorizationMode = 'server-managed';
   data.report!.delegatedRoots = [delegatedScope, '/srv/example-workers'];
   data.modeSetupSupported = true;
   data.modeChangeBlocked = false;
   data.modeChangePlans = [];
   data.activeOperationCount = 0;
   return data;
};
function validationRequest(id: string, roots: string[], canonical: string[], patch: Record<string, unknown> = {}): any {
   return {
      id,
      requestId: id,
      kind: 'validate',
      status: 'validated',
      roots,
      expectedVersion: 3,
      expectedHostPolicyRevision: revision,
      validation: roots.map((requestedPath, index) => ({ requestedPath, canonicalPath: canonical[index], status: 'approved' })),
      createdAt: '2026-01-01T00:00:00Z',
      ...patch,
   };
}
const radio = (ui: Awaited<ReturnType<typeof fixture>>, label: string) =>
   [...ui.dom.window.document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((item) =>
      item.parentElement!.textContent?.includes(label),
   )!;
const checkbox = (ui: Awaited<ReturnType<typeof fixture>>, label: string) =>
   [...ui.dom.window.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((item) =>
      item.parentElement!.textContent?.includes(label),
   )!;

test('Server-Managed bulk paths require current validation and canonical preview before explicit Apply without SSH', async () => {
   const data = delegatedView();
   const paths = ['/var/www/example-alias', '/srv/example-workers/job-01'];
   const canonical = [`${delegatedScope}/app-01`, paths[1]];
   const ui = await fixture(SourceAccess, { deviceId: 'device-01', agentId: 'agent-01' }, { query: { data, isPending: false, isError: false } });
   try {
      assert.match(ui.text(), /Current authorization mode: Server-Managed/);
      assert.match(ui.text(), /Host-delegated scope/);
      await ui.setValue('#source-paths-device-01', paths.join('\n'));
      assert.equal(ui.button('Apply validated paths')!.disabled, true);
      assert.equal(ui.submissions.length, 0);
      await act(async () => ui.button('Validate paths')!.click());
      assert.deepEqual(ui.submissions[0].roots, paths);
      data.requests = [validationRequest('request-1', paths, canonical)];
      await ui.render();
      assert.match(ui.text(), /Canonical path preview/);
      assert.equal(ui.button('Apply validated paths')!.disabled, false);
      assert.equal(ui.submissions.length, 1, 'validation result never auto-applies a source');
      await act(async () => ui.button('Apply validated paths')!.click());
      assert.deepEqual(ui.submissions[1], {
         kind: 'requests',
         expectedVersion: 3,
         expectedHostPolicyRevision: revision,
         roots: [appRoot, ...canonical],
      });
      assert.deepEqual(data.report!.effectiveRoots, [appRoot]);
      assert.equal(ui.button('Copy host approval command'), undefined);
   } finally {
      await ui.cleanup();
   }
});

test('Server-Managed outside-scope, unreadable and substituted canonical results cannot be applied', async () => {
   for (const code of ['source-outside-delegated-scope', 'source-root-not-readable', 'substituted-canonical']) {
      const data = delegatedView();
      const path = `${delegatedScope}/app-01`;
      const ui = await fixture(SourceAccess, { deviceId: 'device-01', agentId: 'agent-01' }, { query: { data, isPending: false, isError: false } });
      try {
         await ui.setValue('#source-paths-device-01', path);
         await act(async () => ui.button('Validate paths')!.click());
         data.requests = [
            validationRequest(
               'request-1',
               [path],
               ['/srv/outside-scope'],
               code === 'substituted-canonical' ? {} : { status: 'rejected', validation: [{ requestedPath: path, status: 'rejected', code }] },
            ),
         ];
         await ui.render();
         assert.equal(ui.button('Apply validated paths')!.disabled, true);
         assert.equal(ui.submissions.length, 1);
         const details = ui.dom.window.document.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!;
         assert.ok(details, 'validation reason remains available in expanded audit details');
         await act(async () => details.click());
         assert.equal(details.getAttribute('aria-expanded'), 'true');
         if (code === 'source-outside-delegated-scope') assert.match(ui.text(), /Outside host-delegated scope/);
         if (code === 'source-root-not-readable') assert.match(ui.text(), /cannot read this directory/);
      } finally {
         await ui.cleanup();
      }
   }
});

test('Server-Managed validation is invalidated by scope revision or edited input', async () => {
   const data = delegatedView();
   const path = `${delegatedScope}/app-01`;
   const ui = await fixture(SourceAccess, { deviceId: 'device-01', agentId: 'agent-01' }, { query: { data, isPending: false, isError: false } });
   try {
      await ui.setValue('#source-paths-device-01', path);
      await act(async () => ui.button('Validate paths')!.click());
      data.requests = [validationRequest('request-1', [path], [path])];
      await ui.render();
      assert.equal(ui.button('Apply validated paths')!.disabled, false);
      data.report!.hostPolicyRevision = 'b'.repeat(64);
      await ui.render();
      assert.equal(ui.button('Apply validated paths')!.disabled, true);
      data.report!.hostPolicyRevision = revision;
      await ui.setValue('#source-paths-device-01', `${delegatedScope}/app-02`);
      assert.equal(ui.button('Apply validated paths')!.disabled, true);
      assert.equal(ui.submissions.length, 1);
   } finally {
      await ui.cleanup();
   }
});

test('existing strict agent mode selection requests a drained receipt and never grants delegation by radio alone', async () => {
   const data = access();
   data.modeSetupSupported = true;
   data.modeChangeBlocked = false;
   data.activeOperationCount = 0;
   data.modeChangePlans = [{ id: 'plan-01', title: 'Example application', sourcePath: appRoot, isActive: false }];
   const ui = await fixture(SourceAccess, { deviceId: 'device-01', agentId: 'agent-01' }, { query: { data, isPending: false, isError: false } });
   try {
      assert.match(ui.text(), /Current authorization mode: Host-Approved/);
      assert.equal(radio(ui, 'Host-Approved').checked, true);
      await act(async () => radio(ui, 'Server-Managed').click());
      await ui.setValue('#delegation-scope-device-01', `${delegatedScope}\n/srv/example-workers`);
      assert.match(ui.text(), /Pending host setup/);
      assert.equal(ui.submissions.length, 0);
      assert.equal(ui.button('Request one-time host setup')!.disabled, true);
      await act(async () => checkbox(ui, 'I reviewed the scope').click());
      await act(async () => ui.button('Request one-time host setup')!.click());
      assert.deepEqual(ui.submissions[0], {
         kind: 'mode-setup',
         expectedVersion: 3,
         expectedHostPolicyRevision: revision,
         authorizationMode: 'server-managed',
         roots: [delegatedScope, '/srv/example-workers'],
         confirmedAffectedPlanIds: ['plan-01'],
      });
      assert.equal(ui.button('Copy one-time host setup command'), undefined);
      const request: any = {
         ...validationRequest('mode-setup-1', [delegatedScope, '/srv/example-workers'], []),
         kind: 'mode-setup',
         requestedMode: 'server-managed',
         status: 'pending-host-setup',
         setupExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      };
      data.requests = [request];
      await ui.render();
      assert.match(ui.text(), /Current authorization mode: Host-Approved/);
      assert.equal(ui.button('Validate paths')!.disabled, true);
      assert.ok(ui.button('Copy one-time host setup command'));
      let copied = '';
      ui.dom.window.document.execCommand = () => {
         copied = ui.dom.window.document.querySelector<HTMLTextAreaElement>('textarea[readonly]')!.value;
         return true;
      };
      await act(async () => ui.button('Copy one-time host setup command')!.click());
      assert.match(copied, /source-access delegate/);
      assert.match(copied, /--request-id 'mode-setup-1'/);
      assert.match(copied, /--confirm-delegation/);
      assert.match(copied, /--confirm-drained/);
      assert.match(ui.text(), /expires after 15 minutes/);
      assert.equal(data.report!.authorizationMode, undefined);
   } finally {
      await ui.cleanup();
   }
});

test('mode setup blocks active plans/operations and unsupported agents; changed plan inventory clears review', async () => {
   for (const state of [
      { modeSetupSupported: false },
      { modeChangeBlocked: true, activeOperationCount: 1 },
      { modeChangePlans: [{ id: 'plan-01', title: 'Application', sourcePath: appRoot, isActive: true }] },
   ]) {
      const data: SourceAccessView = {
         ...access(),
         modeSetupSupported: true,
         modeChangeBlocked: false,
         activeOperationCount: 0,
         modeChangePlans: [],
         ...state,
      };
      const ui = await fixture(ModeSetup, { deviceId: 'device-01', agentId: 'agent-01', access: data });
      try {
         await act(async () => radio(ui, 'Server-Managed').click());
         await ui.setValue('textarea', delegatedScope);
         await act(async () => checkbox(ui, 'I reviewed the scope').click());
         assert.equal(ui.button('Request one-time host setup')!.disabled, true);
         assert.equal(ui.submissions.length, 0);
      } finally {
         await ui.cleanup();
      }
   }
   const data: SourceAccessView = { ...access(), modeSetupSupported: true, modeChangeBlocked: false, activeOperationCount: 0, modeChangePlans: [] };
   const ui = await fixture(ModeSetup, { deviceId: 'device-01', agentId: 'agent-01', access: data });
   try {
      await act(async () => radio(ui, 'Server-Managed').click());
      await ui.setValue('textarea', delegatedScope);
      await act(async () => checkbox(ui, 'I reviewed the scope').click());
      assert.equal(ui.button('Request one-time host setup')!.disabled, false);
      data.modeChangePlans!.push({ id: 'plan-02', title: 'Worker', sourcePath: workerRoot, isActive: false });
      await ui.render();
      assert.equal(checkbox(ui, 'I reviewed the scope').checked, false);
      assert.equal(ui.button('Request one-time host setup')!.disabled, true);
   } finally {
      await ui.cleanup();
   }
});

test('current Server-Managed scope can be edited and renews an expired setup only after another explicit request', async () => {
   const data = delegatedView();
   const ui = await fixture(ModeSetup, { deviceId: 'device-01', agentId: 'agent-01', access: data });
   try {
      assert.ok(ui.dom.window.document.querySelector('textarea'), 'scope editor is available before it changes');
      await ui.setValue('textarea', '/srv/example-new-apps');
      await act(async () => checkbox(ui, 'I reviewed the scope').click());
      await act(async () => ui.button('Request one-time host setup')!.click());
      data.requests = [
         {
            ...validationRequest('mode-setup-1', ['/srv/example-new-apps'], []),
            kind: 'mode-setup',
            requestedMode: 'server-managed',
            status: 'rejected',
            resultCode: 'source-mode-setup-expired',
         },
      ];
      await ui.render();
      assert.equal(ui.button('Copy one-time host setup command'), undefined);
      assert.deepEqual(data.report!.delegatedRoots, [delegatedScope, '/srv/example-workers']);
      assert.equal(ui.submissions.length, 1);
      assert.equal(ui.button('Request one-time host setup')!.disabled, false);
      await act(async () => ui.button('Request one-time host setup')!.click());
      assert.equal(ui.submissions.length, 2);
   } finally {
      await ui.cleanup();
   }
});

test('switching back requests Host-Approved with all plans and no delegated roots before any local transition', async () => {
   const data = delegatedView();
   data.modeChangePlans = [{ id: 'plan-01', title: 'Application', sourcePath: `${delegatedScope}/app-01`, isActive: false }];
   const ui = await fixture(ModeSetup, { deviceId: 'device-01', agentId: 'agent-01', access: data });
   try {
      await act(async () => radio(ui, 'Host-Approved').click());
      assert.match(ui.text(), /switching back does not retain roots that require delegation/);
      await act(async () => checkbox(ui, 'I reviewed the scope').click());
      await act(async () => ui.button('Request one-time host setup')!.click());
      assert.deepEqual(ui.submissions[0], {
         kind: 'mode-setup',
         expectedVersion: 3,
         expectedHostPolicyRevision: revision,
         authorizationMode: 'host-approved',
         roots: [],
         confirmedAffectedPlanIds: ['plan-01'],
      });
      assert.equal(data.report!.authorizationMode, 'server-managed');
   } finally {
      await ui.cleanup();
   }
});

test('Server-Managed plan enables its validated canonical path through UI and waits for effective confirmation', async () => {
   const data = delegatedView();
   const path = `${delegatedScope}/app-01`;
   const ui = await fixture(Picker, { deviceId: 'device-01', sourcePath: '', isEditing: false, access: data });
   try {
      await ui.setValue('input[type="text"]', path);
      assert.equal(ui.button('Apply source access')!.disabled, true);
      await act(async () => ui.button('Validate source path')!.click());
      data.requests = [validationRequest('request-1', [path], [path])];
      await ui.render();
      assert.equal(ui.button('Apply source access')!.disabled, false);
      assert.equal(ui.button('Use validated canonical path'), undefined);
      await act(async () => ui.button('Apply source access')!.click());
      assert.deepEqual(ui.submissions[1].roots, [appRoot, path]);
      assert.ok(ui.updates.every((update) => typeof update !== 'string'));
      data.requests.unshift({ ...validationRequest('request-2', [appRoot, path], []), kind: 'apply', status: 'applied' });
      data.report!.effectiveVersion = 4;
      data.report!.lastAppliedRequestId = 'request-2';
      data.report!.effectiveRoots.push(path);
      data.report!.rootStatuses.push({ path, status: 'readable' });
      await ui.render();
      assert.ok(ui.button('Use validated canonical path'));
      await act(async () => ui.button('Use validated canonical path')!.click());
      assert.deepEqual(ui.updates.slice(-2), [path, { blocked: false }]);
      assert.equal(ui.button('Request access for this path'), undefined);
   } finally {
      await ui.cleanup();
   }
});

test('Server-Managed enrollment is an explicit reviewed intent; installer stays strict until one-time host setup', async () => {
   const ui = await fixture(Enrollment, { close() {} });
   try {
      assert.equal(radio(ui, 'Host-Approved').checked, true);
      await ui.setValue('input[type="text"]', 'app-01');
      await act(async () => radio(ui, 'Server-Managed').click());
      assert.equal(ui.button('Create enrollment token')!.disabled, true);
      await ui.setValue('#enrollment-delegation-scope', '/etc');
      assert.match(ui.text(), /broad and system roots cannot be requested/);
      await ui.setValue('#enrollment-delegation-scope', `${delegatedScope}\n/srv/example-workers`);
      await act(async () => checkbox(ui, 'I reviewed this trust boundary').click());
      await act(async () => ui.button('Create enrollment token')!.click());
      assert.match(ui.text(), /Server-Managed — pending one-time host setup/);
      await ui.setValue('#enrollment-source-roots', `${appRoot}\n${workerRoot}`);
      const commands = [...ui.dom.window.document.querySelectorAll('pre')]
         .map((item) => item.textContent || '')
         .filter((item) => item.includes('sudo bash install-agent.sh'));
      assert.equal(commands.length, 1);
      for (const command of commands) {
         assert.equal(command.match(/--allowed-root /g)?.length, 2);
         assert.doesNotMatch(command, /--delegat|--source-access|server-managed/);
      }
      assert.match(ui.text(), /It does not silently delegate this scope/);
      assert.match(ui.text(), /future readable directories inside the scope can be validated and applied entirely in Pluton/);
   } finally {
      await ui.cleanup();
   }
});

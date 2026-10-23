import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { authorizationStatus, connectionInstructions, type McpGrant } from '../src/utils/mcp.ts';
const req = createRequire(new URL('../package.json', import.meta.url));
const backend = createRequire(new URL('../../backend/package.json', import.meta.url));
const React = req('react');
const { renderToStaticMarkup } = req('react-dom/server');
const { QueryClient, QueryClientProvider } = req('@tanstack/react-query');
const { build } = backend('esbuild');
const grant: McpGrant = {
   id: 'client-01',
   name: 'Example client',
   clientType: 'Codex',
   subject: 'example-user',
   oauthClientId: 'example-client',
   scopes: ['plans:read'],
   planIds: ['plan-01'],
   agentIds: [],
   storageIds: [],
   expiresAt: null,
   revokedAt: null,
   lastUsedAt: null,
   createdAt: 1,
};
const overview = {
   enabled: false,
   configured: true,
   configuredClients: 1,
   recentlyActive: 0,
   disabledTools: [],
   endpoint: 'https://backup.example.internal/mcp',
   protocols: ['2025-11-25'],
   transport: 'Streamable HTTP',
   pendingApprovals: 0,
   scopes: ['plans:read', 'agents:read'],
};
async function compile(file = 'routes/Mcp/Mcp.tsx', stub = true) {
   const result = await build({
      entryPoints: [fileURLToPath(new URL(`../src/${file}`, import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      jsx: 'automatic',
      write: false,
      external: ['react', 'react/jsx-runtime', '@tanstack/react-query'],
      define: { 'import.meta.env': JSON.stringify({ MODE: 'test', VITE_BACKEND_URL: 'https://backup.example.internal' }) },
      plugins: [
         {
            name: 'mcp-fixtures',
            setup(builder: any) {
               builder.onLoad({ filter: /\.scss$/ }, () => ({ contents: 'export default {};', loader: 'js' }));
               builder.onLoad({ filter: /PageHeader\.tsx$/ }, () => ({
                  contents: `import React from 'react'; export default p=>React.createElement('h2',null,p.title);`,
                  loader: 'js',
               }));
               builder.onLoad({ filter: /Modal\.tsx$/ }, () => ({
                  contents: `import React from 'react'; export default p=>React.createElement('section',{'role':'dialog','aria-label':p.title},p.children);`,
                  loader: 'js',
               }));
               if (stub)
                  builder.onLoad({ filter: /services[\\/]mcp\.ts$/ }, () => ({
                     contents: `const f=()=>globalThis.__mcpFixture; export const useMcpOverview=()=>f().overview; export const useMcpTools=()=>f().tools; export const useMcpClients=()=>f().clients; export const useMcpActivity=()=>f().activity; export const mcpRequest=async(...args)=>{globalThis.__mcpRequests.push(args); return {}};`,
                     loader: 'js',
                  }));
            },
         },
      ],
   });
   const module = { exports: {} as any };
   new Function('require', 'module', 'exports', result.outputFiles[0].text)(req, module, module.exports);
   return module.exports;
}
function fixture(overrides: any = {}) {
   (globalThis as any).__mcpFixture = {
      overview: { data: overview },
      tools: { data: [{ name: 'pluton_list_plans', scope: 'plans:read', description: 'Stored plans', enabled: true }] },
      clients: { data: { items: [grant], hasMore: false } },
      activity: { data: { items: [], hasMore: false } },
      ...overrides,
   };
   (globalThis as any).__mcpRequests = [];
}
test('authorization statuses are factual and expiry/revocation override recency', () => {
   assert.equal(authorizationStatus(grant), 'Never used');
   assert.equal(authorizationStatus({ ...grant, lastUsedAt: 1000 }, 2000), 'Recently active');
   assert.equal(authorizationStatus({ ...grant, lastUsedAt: 1000 }, 1000000), 'Authorized');
   assert.equal(authorizationStatus({ ...grant, lastUsedAt: 1000, expiresAt: 1500 }, 2000), 'Expired');
   assert.equal(authorizationStatus({ ...grant, revokedAt: 1, expiresAt: 1500 }, 2000), 'Revoked');
});
test('connection examples use documented fields and identify unverified Grok consumer support', () => {
   assert.match(connectionInstructions('Codex', overview.endpoint), /bearer_token_env_var/);
   assert.match(connectionInstructions('Claude', overview.endpoint), /OAuth/);
   assert.match(connectionInstructions('Grok', overview.endpoint), /consumer Grok custom connector has not been verified/);
   assert.match(connectionInstructions('Custom', null), /Authorization: Bearer/);
   assert.ok(!connectionInstructions('Codex', overview.endpoint).includes('OPENAI_API_KEY'));
});
test('overview, client evidence, tool controls, paginated activity and unavailable approvals render honest states', async () => {
   const Component = (await compile()).default;
   fixture();
   const client = new QueryClient();
   const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(Component)));
   for (const text of [
      'Secure operational access',
      'Never used',
      'Add MCP client',
      'Permissions',
      'Revoke',
      'No activity matches',
      'Next activity',
      'Next clients',
      'Write requests and approvals are unavailable',
   ])
      assert.ok(html.includes(text), text);
   assert.ok(!html.includes('Online'));
   assert.ok(!html.includes('Production ready'));
   assert.match(html, /aria-labelledby="mcp-tools"/);
   client.clear();
});
test('loading, failed overview, empty collections and per-section errors have accessible feedback', async () => {
   const Component = (await compile()).default;
   const client = new QueryClient();
   const render = () => renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(Component)));
   fixture({ overview: { isLoading: true } });
   assert.match(render(), /role="status"/);
   fixture({ overview: { isError: true } });
   assert.match(render(), /role="alert"/);
   fixture({ clients: { data: { items: [] } } });
   assert.match(render(), /No client authorizations/);
   fixture({ clients: { isError: true }, tools: { isError: true }, activity: { isError: true } });
   assert.match(render(), /Client authorizations could not/);
   assert.match(render(), /Tool catalog could not/);
   assert.match(render(), /Activity could not/);
   client.clear();
});
test('interactive registration, permission editing, revocation confirmation and backend tool switch send concrete operations', async () => {
   const { JSDOM } = req('jsdom');
   const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://backup.example.internal' });
   const saved = Object.getOwnPropertyDescriptors(globalThis);
   for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent'])
      Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true });
   (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
   const { createRoot } = req('react-dom/client');
   const Component = (await compile()).default;
   fixture();
   const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
   const root = createRoot(document.getElementById('root'));
   const click = async (text: string) => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent === text);
      assert.ok(button, text);
      await React.act(async () => {
         button.click();
      });
   };
   try {
      await React.act(async () => {
         root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Component)));
      });
      await click('Add MCP client');
      assert.match(document.body.textContent!, /Verified OAuth subject/);
      assert.ok(!document.querySelector('input[type=password]'));
      // Native form defaults are empty: resource grants are never silently global.
      assert.ok([...document.querySelectorAll('textarea')].every((item) => !item.value));
      const registration = document.querySelector('[role=dialog]')!;
      const textInputs = [...registration.querySelectorAll('input:not([type])')];
      for (const [index, value] of ['New example client', 'example-user-02', 'example-client-02'].entries()) {
         await React.act(async () => {
            Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(textInputs[index], value);
            textInputs[index].dispatchEvent(new dom.window.Event('input', { bubbles: true }));
         });
      }
      await React.act(async () => {
         (registration.querySelector('input[type=checkbox]') as HTMLInputElement).click();
      });
      await React.act(async () => {
         registration.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      });
      await React.act(async () => {
         await new Promise((resolve) => setTimeout(resolve, 15));
      });
      const registered = (globalThis as any).__mcpRequests[0];
      assert.equal(registered[0], 'clients');
      assert.equal(registered[1], 'POST');
      assert.equal(registered[2].name, 'New example client');
      assert.equal(registered[2].subject, 'example-user-02');
      assert.equal(registered[2].oauthClientId, 'example-client-02');
      assert.deepEqual(registered[2].planIds, []);
      (globalThis as any).__mcpRequests = [];
      await React.act(async () => {
         root.unmount();
      });
      const root2 = createRoot(document.getElementById('root'));
      await React.act(async () => {
         root2.render(React.createElement(QueryClientProvider, { client }, React.createElement(Component)));
      });
      await click('Permissions');
      const dialog = document.querySelector('[role=dialog]')!;
      assert.equal(dialog.querySelector('input[disabled]')?.getAttribute('value'), 'example-user');
      assert.equal(dialog.querySelector('textarea')?.value, 'plan-01');
      await React.act(async () => {
         dialog.querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      });
      await React.act(async () => {
         await new Promise((resolve) => setTimeout(resolve, 15));
      });
      const updates = (globalThis as any).__mcpRequests;
      assert.equal(updates[0][0], 'clients/client-01');
      assert.equal(updates[0][1], 'PUT');
      assert.deepEqual(updates[0][2].planIds, ['plan-01']);
      await click('Revoke');
      assert.equal(updates.length, 1); // Opening the confirmation does not revoke.
      await click('Confirm revocation');
      await React.act(async () => {
         await new Promise((resolve) => setTimeout(resolve, 15));
      });
      assert.equal(updates[1][0], 'clients/client-01/revoke');
      const checkbox = document.querySelector('#mcp-tools')!.parentElement!.querySelector('input')!;
      await React.act(async () => {
         checkbox.click();
      });
      await React.act(async () => {
         await new Promise((resolve) => setTimeout(resolve, 15));
      });
      assert.deepEqual(updates[2][2], { enabled: false, disabledTools: ['pluton_list_plans'] });
      await React.act(async () => {
         root2.unmount();
      });
   } finally {
      client.clear();
      dom.window.close();
      for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent']) {
         if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
         else delete (globalThis as any)[key];
      }
      delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
   }
});
test('API client uses cookie-authenticated JSON and rejects WAF HTML rather than implying success', async () => {
   const service = await compile('services/mcp.ts', false);
   const original = globalThis.fetch;
   const calls: any[] = [];
   try {
      globalThis.fetch = async (url, options) => {
         calls.push({ url, options });
         return new Response(JSON.stringify({ success: true, result: { revoked: true } }), { headers: { 'Content-Type': 'application/json' } });
      };
      assert.equal((await service.mcpRequest('clients/client-01/revoke', 'POST', {})).revoked, true);
      assert.equal(calls[0].options.credentials, 'include');
      assert.equal(calls[0].options.redirect, 'error');
      globalThis.fetch = async () => new Response('<html>WAF</html>', { status: 403, headers: { 'Content-Type': 'text/html' } });
      await assert.rejects(service.mcpRequest('policy', 'PUT', {}), /HTML instead of JSON/);
   } finally {
      globalThis.fetch = original;
   }
});

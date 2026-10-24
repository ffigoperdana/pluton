import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Modal from '../../components/common/Modal/Modal';
import { mcpRequest, useMcpTools, type McpPage } from '../../services/mcp';
import classes from './Mcp.module.scss';

export type TokenInput = {
   name: string;
   purpose: string;
   mode: 'read' | 'write' | 'read_write';
   tools: string[];
   planIds: string[];
   agentIds: string[];
   storageIds: string[];
   ttlHours: number;
   approvalPolicy: 'always';
};
type Token = Omit<TokenInput, 'ttlHours'> & {
   id: string;
   issuer: string;
   createdAt: number;
   expiresAt: number;
   lastUsedAt: number | null;
   revokedAt: number | null;
   disabled: boolean;
};
type Action = {
   id: string;
   tokenId: string;
   action: string;
   planId: string;
   status: string;
   createdAt: number;
   expiresAt: number;
   argumentsHash: string;
   arguments: unknown;
   preview: { before: unknown; after: unknown; warnings: string[] };
   outcomeCode: string | null;
   resultId: string | null;
   decidedBy: string | null;
   execution?: { state: string; terminal: boolean; success: boolean | null } | null;
};
const blank: TokenInput = {
   name: '',
   purpose: '',
   mode: 'read',
   tools: [],
   planIds: [],
   agentIds: [],
   storageIds: [],
   ttlHours: 168,
   approvalPolicy: 'always',
};
const date = (value: number | null) => (value === null ? 'Never' : new Date(value).toLocaleString());
const json = (value: unknown) => JSON.stringify(value, null, 2);

function ResourcePicker({
   kind,
   selected,
   change,
}: {
   kind: 'plans' | 'agents' | 'storages';
   selected: string[];
   change: (value: string[]) => void;
}) {
   const [offset, setOffset] = useState(0);
   const result = useQuery({
      queryKey: ['mcp', 'resources', kind, offset],
      queryFn: () => mcpRequest<McpPage<{ id: string; name: string }>>(`resources?kind=${kind}&limit=20&offset=${offset}`),
      retry: false,
   });
   return (
      <fieldset>
         <legend>
            Allowed {kind} ({selected.length} selected)
         </legend>
         {result.isLoading && <p role="status">Loading resources…</p>}
         {result.isError && <p role="alert">Resources could not be loaded.</p>}
         {result.data?.items.map((row) => (
            <label key={row.id}>
               <input
                  type="checkbox"
                  checked={selected.includes(row.id)}
                  onChange={(event) => change(event.target.checked ? [...selected, row.id] : selected.filter((id) => id !== row.id))}
               />
               {row.name} <code>{row.id}</code>
            </label>
         ))}
         <div className={classes.pager}>
            <button type="button" disabled={!offset || result.isFetching} onClick={() => setOffset(offset - 20)}>
               Previous {kind}
            </button>
            <button type="button" disabled={!result.data?.hasMore || result.isFetching} onClick={() => setOffset(offset + 20)}>
               Next {kind}
            </button>
         </div>
         <p className={classes.muted}>An empty list grants no resources. Selections on other pages remain selected.</p>
      </fieldset>
   );
}
function TokenForm({ initial, busy, save }: { initial: Token | 'new'; busy: boolean; save: (value: TokenInput) => void }) {
   const [value, setValue] = useState<TokenInput>(
      initial === 'new'
         ? blank
         : {
              name: initial.name,
              purpose: initial.purpose,
              mode: initial.mode,
              tools: initial.tools,
              planIds: initial.planIds,
              agentIds: initial.agentIds,
              storageIds: initial.storageIds,
              ttlHours: 168,
              approvalPolicy: 'always',
           },
   );
   const catalog = useMcpTools();
   function submit(event: FormEvent) {
      event.preventDefault();
      save(value);
   }
   return (
      <form className={classes.form} onSubmit={submit}>
         <label>
            Token name
            <input autoFocus required maxLength={80} value={value.name} onChange={(e) => setValue({ ...value, name: e.target.value })} />
         </label>
         <label>
            Purpose
            <input maxLength={240} value={value.purpose} onChange={(e) => setValue({ ...value, purpose: e.target.value })} />
         </label>
         <label>
            Permission mode
            <select value={value.mode} onChange={(e) => setValue({ ...value, mode: e.target.value as TokenInput['mode'], tools: [] })}>
               <option value="read">Read only</option>
               <option value="write">Write only</option>
               <option value="read_write">Read and write</option>
            </select>
         </label>
         <p>Write only can request actions and read its own action status. Every write requires separate approval by a human administrator.</p>
         <fieldset>
            <legend>Allowed tools</legend>
            {catalog.isError && <p role="alert">Tool catalog unavailable.</p>}
            {catalog.data
               ?.filter((tool) => !tool.implicit && (value.mode === 'read_write' || (value.mode === 'write') === tool.approvalRequired))
               .map((tool) => (
                  <label key={tool.name}>
                     <input
                        type="checkbox"
                        checked={value.tools.includes(tool.name)}
                        onChange={(e) =>
                           setValue({
                              ...value,
                              tools: e.target.checked ? [...value.tools, tool.name] : value.tools.filter((name) => name !== tool.name),
                           })
                        }
                     />
                     <code>{tool.name}</code>
                     {!tool.enabled && ' (disabled by service policy)'}
                  </label>
               ))}
         </fieldset>
         <ResourcePicker kind="plans" selected={value.planIds} change={(planIds) => setValue({ ...value, planIds })} />
         <ResourcePicker kind="agents" selected={value.agentIds} change={(agentIds) => setValue({ ...value, agentIds })} />
         <ResourcePicker kind="storages" selected={value.storageIds} change={(storageIds) => setValue({ ...value, storageIds })} />
         {initial === 'new' ? (
            <label>
               Expires after (hours, maximum 2160)
               <input
                  type="number"
                  min={1}
                  max={2160}
                  required
                  value={value.ttlHours}
                  onChange={(e) => setValue({ ...value, ttlHours: Number(e.target.value) })}
               />
            </label>
         ) : (
            <p>Permission edits keep the existing expiration and invalidate pending approvals. Rotate to replace the credential.</p>
         )}
         <button disabled={busy || !value.tools.length} type="submit">
            {busy ? 'Saving…' : initial === 'new' ? 'Create token' : 'Save token permissions'}
         </button>
      </form>
   );
}

export default function McpV2Panel({ enabled, endpoint }: { enabled: boolean; endpoint: string | null }) {
   const cache = useQueryClient();
   const [tokenOffset, setTokenOffset] = useState(0);
   const [actionOffset, setActionOffset] = useState(0);
   const [pendingOnly, setPendingOnly] = useState(true);
   const [editor, setEditor] = useState<Token | 'new' | null>(null);
   // Plaintext exists only in this mounted component. Never place it in persisted query/mutation caches.
   const [issued, setIssued] = useState<string | null>(null);
   const [busy, setBusy] = useState(false);
   const [error, setError] = useState('');
   const [message, setMessage] = useState('');
   const [review, setReview] = useState<Action | null>(null);
   const [confirm, setConfirm] = useState<{ route: string; body: unknown; title: string; detail: string } | null>(null);
   const tokens = useQuery({
      queryKey: ['mcp', 'tokens', tokenOffset],
      queryFn: () => mcpRequest<McpPage<Token>>(`tokens?limit=20&offset=${tokenOffset}`),
      retry: false,
   });
   const actions = useQuery({
      queryKey: ['mcp', 'actions', actionOffset, pendingOnly],
      queryFn: () => mcpRequest<McpPage<Action>>(`actions?limit=20&offset=${actionOffset}&pending=${pendingOnly}`),
      retry: false,
      refetchInterval: 15000,
   });
   async function run(route: string, body: unknown, method = 'POST', secret = false) {
      setBusy(true);
      setError('');
      setMessage('');
      try {
         const result = await mcpRequest<{ token?: string }>(route, method, body);
         if (secret && result.token) setIssued(result.token);
         setEditor(null);
         setReview(null);
         setConfirm(null);
         await cache.invalidateQueries({ queryKey: ['mcp'] });
      } catch (cause) {
         const code = cause instanceof Error ? cause.message : '';
         const messages: Record<string, string> = {
            resource_changed_request_again: 'The plan or related resource changed. Reject the old request and submit a new one.',
            authorization_changed: 'Token permissions changed. Submit a new request.',
            action_not_pending: 'This action is no longer awaiting approval. Refresh its history.',
            invalid_token: 'The token expired, was disabled or was revoked.',
            insufficient_scope: 'This token does not have the required tool and plan permissions.',
            resource_not_granted: 'Grant the associated plan, Agent and storage before requesting this action.',
            pending_action_limit: 'The pending action limit has been reached. Review existing requests first.',
         };
         setError(messages[code] || code || 'Request failed. Refresh before retrying.');
      } finally {
         setBusy(false);
      }
   }
   async function copy() {
      if (!issued) return;
      try {
         await navigator.clipboard.writeText(issued);
         setMessage('Copied. Keep it in a secret manager; your clipboard now contains the token.');
      } catch {
         setMessage('Select and copy the token manually.');
      }
   }
   async function testConnection() {
      if (!issued || !endpoint) return;
      setBusy(true);
      setMessage('');
      try {
         const response = await fetch(endpoint, {
            method: 'POST',
            credentials: 'omit',
            redirect: 'error',
            headers: { Authorization: `Bearer ${issued}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: json({
               jsonrpc: '2.0',
               id: 1,
               method: 'initialize',
               params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'pluton-admin-check', version: '2' } },
            }),
         });
         const result = await response.json();
         setMessage(
            response.ok && result.result?.serverInfo?.name === 'pluton'
               ? 'Authentication and MCP initialization succeeded from this browser. This does not verify a provider connection.'
               : `Connection check failed (HTTP ${response.status}). Check service policy, HTTPS and token status.`,
         );
      } catch {
         setMessage('Connection check failed. Check HTTPS, endpoint and service policy.');
      } finally {
         setBusy(false);
      }
   }
   return (
      <>
         {error && (
            <p role="alert" className={classes.error}>
               {error}
            </p>
         )}
         <section className={classes.card} aria-labelledby="mcp-tokens">
            <div className={classes.heading}>
               <h3 id="mcp-tokens">API Tokens</h3>
               <button
                  disabled={!enabled || busy}
                  onClick={() => {
                     setError('');
                     setEditor('new');
                  }}
               >
                  Create API token
               </button>
            </div>
            {!enabled && (
               <p>
                  Native tokens are disabled in server configuration. Set MCP_NATIVE_TOKENS_ENABLED=true with an HTTPS MCP_RESOURCE_URL, restart, then
                  enable the service above.
               </p>
            )}
            <p>
               Tokens are separate from OAuth, browser sessions, Agent credentials and model-provider keys. All operational writes require human
               approval.
            </p>
            {tokens.isLoading ? (
               <p role="status">Loading tokens…</p>
            ) : tokens.isError ? (
               <p role="alert">Tokens could not be loaded.</p>
            ) : !tokens.data?.items.length ? (
               <p>No native tokens on this page.</p>
            ) : (
               <div className={classes.scroll}>
                  <table>
                     <thead>
                        <tr>
                           <th>Name / permission</th>
                           <th>Resources / tools</th>
                           <th>Lifetime / issuer</th>
                           <th>Actions</th>
                        </tr>
                     </thead>
                     <tbody>
                        {tokens.data.items.map((token) => (
                           <tr key={token.id}>
                              <td>
                                 <strong>{token.name}</strong>
                                 <br />
                                 {token.purpose}
                                 <br />
                                 {token.mode}
                                 <br />
                                 {token.revokedAt !== null
                                    ? 'Revoked'
                                    : token.expiresAt <= Date.now()
                                      ? 'Expired'
                                      : token.disabled
                                        ? 'Disabled'
                                        : 'Active'}
                                 <br />
                                 <code>{token.id}</code>
                              </td>
                              <td>
                                 {token.tools.join(', ')}
                                 <br />
                                 Plans: {token.planIds.join(', ') || 'None'}
                                 <br />
                                 Agents: {token.agentIds.join(', ') || 'None'}
                                 <br />
                                 Storage: {token.storageIds.join(', ') || 'None'}
                              </td>
                              <td>
                                 Created {date(token.createdAt)}
                                 <br />
                                 Expires {date(token.expiresAt)}
                                 <br />
                                 Last used {date(token.lastUsedAt)}
                                 <br />
                                 Issuer {token.issuer}
                              </td>
                              <td>
                                 <div className={classes.actions}>
                                    <button
                                       disabled={busy || token.revokedAt !== null || token.disabled || token.expiresAt <= Date.now()}
                                       onClick={() => setEditor(token)}
                                    >
                                       Edit permissions
                                    </button>
                                    <button
                                       disabled={busy || token.revokedAt !== null}
                                       onClick={() => void run(`tokens/${token.id}/state`, { disabled: !token.disabled })}
                                    >
                                       {token.disabled ? 'Enable token' : 'Disable token'}
                                    </button>
                                    <button
                                       disabled={busy || !enabled || token.revokedAt !== null || token.disabled || token.expiresAt <= Date.now()}
                                       onClick={() =>
                                          setConfirm({
                                             route: `tokens/${token.id}/rotate`,
                                             body: { ttlHours: 168 },
                                             title: 'Rotate API token',
                                             detail: `Replace ${token.name} with a new 7-day token and immediately revoke the old credential. Pending approvals become invalid.`,
                                          })
                                       }
                                    >
                                       Rotate
                                    </button>
                                    <button
                                       disabled={busy || token.revokedAt !== null}
                                       onClick={() =>
                                          setConfirm({
                                             route: `tokens/${token.id}/revoke`,
                                             body: {},
                                             title: 'Revoke API token',
                                             detail: `Immediately revoke ${token.name}. Already dispatched work is not cancelled.`,
                                          })
                                       }
                                    >
                                       Revoke token
                                    </button>
                                 </div>
                              </td>
                           </tr>
                        ))}
                     </tbody>
                  </table>
               </div>
            )}
            <div className={classes.pager}>
               <button disabled={!tokenOffset || tokens.isFetching} onClick={() => setTokenOffset(tokenOffset - 20)}>
                  Previous tokens
               </button>
               <button disabled={!tokens.data?.hasMore || tokens.isFetching} onClick={() => setTokenOffset(tokenOffset + 20)}>
                  Next tokens
               </button>
            </div>
            <button
               disabled={busy}
               onClick={() =>
                  setConfirm({
                     route: 'tokens/revoke-all',
                     body: { confirm: 'REVOKE ALL NATIVE TOKENS' },
                     title: 'Emergency revoke all native tokens',
                     detail: 'Immediately revoke every native token. OAuth grants remain separate. Already dispatched work is not cancelled.',
                  })
               }
            >
               Emergency revoke all native tokens
            </button>
         </section>
         <section className={classes.card} aria-labelledby="mcp-approvals">
            <h3 id="mcp-approvals">Approvals and action history</h3>
            <label>
               <input
                  type="checkbox"
                  checked={pendingOnly}
                  onChange={(e) => {
                     setPendingOnly(e.target.checked);
                     setActionOffset(0);
                  }}
               />
               Pending approvals only
            </label>
            <p>
               Review the exact parameters and before/after values. Approval expires after 15 minutes or token expiration. Changes to permissions or
               resources require a fresh request.
            </p>
            {actions.isLoading ? (
               <p role="status">Loading actions…</p>
            ) : actions.isError ? (
               <p role="alert">Actions could not be loaded.</p>
            ) : !actions.data?.items.length ? (
               <p>No actions on this page.</p>
            ) : (
               <div className={classes.scroll}>
                  <table>
                     <thead>
                        <tr>
                           <th>Action / plan</th>
                           <th>Token / status</th>
                           <th>Dates / outcome</th>
                           <th>Review</th>
                        </tr>
                     </thead>
                     <tbody>
                        {actions.data.items.map((action) => (
                           <tr key={action.id}>
                              <td>
                                 {action.action}
                                 <br />
                                 <code>{action.planId}</code>
                                 <br />
                                 <code>{action.id}</code>
                              </td>
                              <td>
                                 <code>{action.tokenId}</code>
                                 <br />
                                 {action.status}
                              </td>
                              <td>
                                 Requested {date(action.createdAt)}
                                 <br />
                                 Expires {date(action.expiresAt)}
                                 <br />
                                 {action.outcomeCode}
                                 <br />
                                 {action.resultId}
                                 <br />
                                 {action.execution
                                    ? `Job: ${action.execution.state}${action.execution.terminal ? ' (finished)' : ''}`
                                    : 'Job progress unavailable'}
                                 <br />
                                 {action.decidedBy}
                              </td>
                              <td>
                                 <button disabled={busy} onClick={() => setReview(action)}>
                                    Review action
                                 </button>
                              </td>
                           </tr>
                        ))}
                     </tbody>
                  </table>
               </div>
            )}
            <div className={classes.pager}>
               <button disabled={!actionOffset || actions.isFetching} onClick={() => setActionOffset(actionOffset - 20)}>
                  Previous actions
               </button>
               <button disabled={!actions.data?.hasMore || actions.isFetching} onClick={() => setActionOffset(actionOffset + 20)}>
                  Next actions
               </button>
            </div>
            <p className={classes.muted}>
               Dispatched means accepted by a domain service. Check the backup or recovery history for completion. Uncertain actions are never retried
               automatically.
            </p>
         </section>
         <section className={classes.card}>
            <h3>Connect a client</h3>
            <p>
               Endpoint: <code>{endpoint || 'Not configured'}</code>
            </p>
            <details>
               <summary>Codex CLI and IDE</summary>
               <pre
                  className={classes.instructions}
               >{`[mcp_servers.pluton]\nurl = ${JSON.stringify(endpoint || 'https://backup.example.internal/mcp')}\nbearer_token_env_var = "PLUTON_MCP_ACCESS_TOKEN"`}</pre>
               <p>Set the environment variable securely before starting Codex. Keep the real token out of configuration files and shell history.</p>
            </details>
            <details>
               <summary>Claude remote connector</summary>
               <p>
                  In Settings → Connectors → Add custom connector, enter the endpoint. Where Request headers is available, add Authorization with
                  Bearer followed by your native token. Keep the value private. Your administrator may need to allow custom connectors and endpoint
                  access.
               </p>
            </details>
            <details>
               <summary>OpenAI API and ChatGPT</summary>
               <p>
                  The Responses API MCP tool accepts the token in its authorization field. Your OpenAI API key is separate and stays in your
                  application. ChatGPT custom connectors use the supported OAuth flow; native token entry there has not been verified. Configure the
                  external OAuth provider for that flow.
               </p>
            </details>
            <p>
               These instructions were checked against official documentation. Real provider accounts have not been tested. See{' '}
               <a href="/docs/reference/mcp">the MCP setup guide</a> for scope, examples and troubleshooting.
            </p>
         </section>
         {editor && (
            <Modal
               stableLayout
               title={editor === 'new' ? 'Create native API token' : 'Edit token permissions'}
               width="760px"
               closeDisabled={busy}
               closeModal={() => setEditor(null)}
            >
               <div className={classes.page}>
                  {error && <p role="alert">{error}</p>}
                  <TokenForm
                     initial={editor}
                     busy={busy}
                     save={(body) =>
                        void run(editor === 'new' ? 'tokens' : `tokens/${editor.id}`, body, editor === 'new' ? 'POST' : 'PUT', editor === 'new')
                     }
                  />
               </div>
            </Modal>
         )}
         {issued && (
            <Modal
               stableLayout
               title="Copy your token now"
               width="700px"
               closeDisabled={busy}
               closeModal={() => {
                  setIssued(null);
                  setMessage('');
               }}
            >
               <p>This is the only display of this credential. Store it securely before closing. It cannot be retrieved later.</p>
               <textarea readOnly aria-label="New API token" value={issued} autoComplete="off" spellCheck={false} />
               <div className={classes.actions}>
                  <button onClick={() => void copy()}>Copy token</button>
                  <button disabled={busy || !endpoint} onClick={() => void testConnection()}>
                     Test connection
                  </button>
                  <button
                     disabled={busy}
                     onClick={() => {
                        setIssued(null);
                        setMessage('');
                     }}
                  >
                     I have saved it
                  </button>
               </div>
               <p role="status">{message}</p>
            </Modal>
         )}
         {confirm && (
            <Modal stableLayout title={confirm.title} width="500px" closeDisabled={busy} closeModal={() => setConfirm(null)}>
               <p>{confirm.detail}</p>
               {error && <p role="alert">{error}</p>}
               <button disabled={busy} onClick={() => void run(confirm.route, confirm.body, 'POST', confirm.route.endsWith('/rotate'))}>
                  Confirm
               </button>
            </Modal>
         )}
         {review && (
            <Modal stableLayout title="Review requested action" width="800px" closeDisabled={busy} closeModal={() => setReview(null)}>
               <div className={classes.page}>
                  <p>
                     {review.action} · {review.status} · Plan {review.planId} · Token {review.tokenId}
                  </p>
                  <p>Operational risk · Human approval required · Expires {date(review.expiresAt)}</p>
                  {review.preview.warnings.map((warning) => (
                     <p key={warning}>{warning}</p>
                  ))}
                  <h4>Before</h4>
                  <pre className={classes.instructions}>{json(review.preview.before)}</pre>
                  <h4>After</h4>
                  <pre className={classes.instructions}>{json(review.preview.after)}</pre>
                  <h4>Exact request</h4>
                  <pre className={classes.instructions}>{json(review.arguments)}</pre>
                  <p>
                     Request hash: <code>{review.argumentsHash}</code>
                  </p>
                  {error && <p role="alert">{error}</p>}
                  {review.status === 'pending_approval' && (
                     <div className={classes.actions}>
                        <button
                           disabled={busy || !enabled}
                           onClick={() => void run(`actions/${review.id}/approve`, { argumentsHash: review.argumentsHash })}
                        >
                           Approve this exact action
                        </button>
                        <button disabled={busy} onClick={() => void run(`actions/${review.id}/reject`, {})}>
                           Reject action
                        </button>
                     </div>
                  )}
                  {review.status === 'uncertain' && (
                     <>
                        <p>First inspect domain history and resolve any ongoing work. Reconciliation closes this request without replaying it.</p>
                        <button
                           disabled={busy}
                           onClick={() => {
                              setReview(null);
                              setConfirm({
                                 route: `actions/${review.id}/reconcile`,
                                 body: { confirm: 'RECONCILED' },
                                 title: 'Confirm operator reconciliation',
                                 detail:
                                    'Confirm that you inspected the actual operation and resolved its uncertain outcome. This will not execute or retry anything.',
                              });
                           }}
                        >
                           Reconcile uncertain action
                        </button>
                     </>
                  )}
               </div>
            </Modal>
         )}
      </>
   );
}

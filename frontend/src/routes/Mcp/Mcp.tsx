import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import PageHeader from '../../components/common/PageHeader/PageHeader';
import Modal from '../../components/common/Modal/Modal';
import { useMcpOverview, useMcpTools, useMcpClients, useMcpActivity, mcpRequest } from '../../services/mcp';
import { authorizationStatus, connectionInstructions, type McpGrant, type McpGrantInput } from '../../utils/mcp';
import classes from './Mcp.module.scss';
import McpV2Panel from './McpV2Panel';

const blank: McpGrantInput = {
   name: '',
   clientType: 'Custom',
   subject: '',
   oauthClientId: '',
   scopes: [],
   planIds: [],
   agentIds: [],
   storageIds: [],
   expiresAt: null,
};
const date = (value: number | null) => (value === null ? 'Never' : new Date(value).toLocaleString());
const ids = (value: string) => [...new Set(value.split(/[\s,]+/).filter(Boolean))];

function ClientForm({
   initial,
   scopes,
   endpoint,
   pending,
   save,
}: {
   initial?: McpGrant;
   scopes: string[];
   endpoint: string | null;
   pending: boolean;
   save: (value: McpGrantInput) => void;
}) {
   const [value, setValue] = useState<McpGrantInput>(initial || blank);
   const [resourceText, setResourceText] = useState({
      planIds: initial?.planIds.join(', ') || '',
      agentIds: initial?.agentIds.join(', ') || '',
      storageIds: initial?.storageIds.join(', ') || '',
   });
   function submit(event: FormEvent) {
      event.preventDefault();
      const { name, clientType, subject, oauthClientId, scopes: selected, expiresAt } = value;
      save({
         name,
         clientType,
         subject,
         oauthClientId,
         scopes: selected,
         expiresAt,
         planIds: ids(resourceText.planIds),
         agentIds: ids(resourceText.agentIds),
         storageIds: ids(resourceText.storageIds),
      });
   }
   return (
      <form className={classes.form} onSubmit={submit}>
         <p>
            Register an existing OAuth user and client. Pluton stores permission grants and does not issue model-provider keys or OAuth credentials.
         </p>
         <label>
            Friendly name
            <input autoFocus required maxLength={80} value={value.name} onChange={(event) => setValue({ ...value, name: event.target.value })} />
         </label>
         <label>
            Intended client type
            <select
               value={value.clientType}
               onChange={(event) => setValue({ ...value, clientType: event.target.value as McpGrantInput['clientType'] })}
            >
               {['Claude', 'Codex', 'Grok', 'Custom'].map((type) => (
                  <option key={type}>{type}</option>
               ))}
            </select>
         </label>
         <p className={classes.muted}>
            This label is declared by an administrator. It does not verify a model or provide access to private conversations.
         </p>
         <label>
            Verified OAuth subject (sub)
            <input
               required
               disabled={!!initial}
               maxLength={256}
               value={value.subject}
               onChange={(event) => setValue({ ...value, subject: event.target.value })}
            />
         </label>
         <label>
            Registered OAuth client ID (client_id)
            <input
               required
               disabled={!!initial}
               maxLength={512}
               value={value.oauthClientId}
               onChange={(event) => setValue({ ...value, oauthClientId: event.target.value })}
            />
         </label>
         <fieldset>
            <legend>Approved read scopes</legend>
            <div className={classes.checks}>
               {scopes.map((scope) => (
                  <label key={scope}>
                     <input
                        type="checkbox"
                        checked={value.scopes.includes(scope)}
                        onChange={(event) =>
                           setValue({
                              ...value,
                              scopes: event.target.checked ? [...value.scopes, scope] : value.scopes.filter((item) => item !== scope),
                           })
                        }
                     />
                     {scope}
                  </label>
               ))}
            </div>
         </fieldset>
         <p>Enter exact resource IDs, separated by commas. Empty lists grant no resources. Wildcards are unavailable.</p>
         {(['planIds', 'agentIds', 'storageIds'] as const).map((key, index) => (
            <label key={key}>
               {['Plan IDs (also restrict backups, replication and recovery)', 'Agent IDs', 'Storage IDs'][index]}
               <textarea value={resourceText[key]} onChange={(event) => setResourceText({ ...resourceText, [key]: event.target.value })} />
            </label>
         ))}
         <label>
            Authorization expiration (optional)
            <input
               type="datetime-local"
               onChange={(event) => setValue({ ...value, expiresAt: event.target.value ? new Date(event.target.value).getTime() : null })}
               defaultValue={
                  initial?.expiresAt
                     ? new Date(initial.expiresAt - new Date(initial.expiresAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16)
                     : ''
               }
            />
         </label>
         <details>
            <summary>Connection instructions</summary>
            <pre className={classes.instructions}>{connectionInstructions(value.clientType, endpoint)}</pre>
         </details>
         <button disabled={pending || !value.scopes.length} type="submit">
            {pending ? 'Saving…' : initial ? 'Save permissions' : 'Register authorization'}
         </button>
      </form>
   );
}
export default function Mcp() {
   const cache = useQueryClient();
   const [clientOffset, setClientOffset] = useState(0);
   const [activityOffset, setActivityOffset] = useState(0);
   const [clientFilter, setClientFilter] = useState('');
   const [outcome, setOutcome] = useState('');
   const [editor, setEditor] = useState<McpGrant | 'new' | null>(null);
   const [revoke, setRevoke] = useState<McpGrant | null>(null);
   const [enableConfirmation, setEnableConfirmation] = useState(false);
   const [copyMessage, setCopyMessage] = useState('');
   const overview = useMcpOverview();
   const tools = useMcpTools();
   const clients = useMcpClients(clientOffset);
   const activity = useMcpActivity(activityOffset, clientFilter, outcome);
   const mutation = useMutation({
      retry: false,
      mutationFn: ({ route, method, body }: { route: string; method: string; body: unknown }) => mcpRequest(route, method, body),
      onSuccess: () => {
         void cache.invalidateQueries({ queryKey: ['mcp'] });
         setEditor(null);
         setRevoke(null);
         setEnableConfirmation(false);
      },
   });
   async function copy(value: string) {
      try {
         await navigator.clipboard.writeText(value);
         setCopyMessage('Copied.');
      } catch {
         setCopyMessage('Copy is unavailable. Select and copy the text above.');
      }
   }
   if (overview.isLoading) return <div role="status">Loading MCP administration…</div>;
   if (overview.isError || !overview.data)
      return (
         <div role="alert">
            MCP administration could not be loaded. <button onClick={() => void overview.refetch()}>Try again</button>
         </div>
      );
   const state = overview.data;
   function policy(enabled: boolean, disabledTools = state.disabledTools) {
      mutation.mutate({ route: 'policy', method: 'PUT', body: { enabled, disabledTools } });
   }
   return (
      <div className={classes.page}>
         <PageHeader
            title="MCP"
            icon="lock"
            rightSection={<button onClick={() => void cache.invalidateQueries({ queryKey: ['mcp'] })}>Refresh</button>}
         />
         {mutation.isError && (
            <p className={classes.error} role="alert">
               {mutation.error.message}
            </p>
         )}
         <section className={classes.card} aria-labelledby="mcp-overview">
            <div className={classes.heading}>
               <h3 id="mcp-overview">Secure operational access</h3>
               <span className={classes.badge}>{state.enabled ? 'Enabled' : 'Disabled'}</span>
            </div>
            <p>
               Let approved assistants inspect selected records and request operational actions. Native write actions require separate human approval.
            </p>
            <div className={classes.overview}>
               <dl>
                  <dt>Service</dt>
                  <dd>{state.enabled ? 'Enabled' : 'Disabled'}</dd>
               </dl>
               <dl>
                  <dt>Client authorizations</dt>
                  <dd>{state.configuredClients}</dd>
               </dl>
               <dl>
                  <dt>Active in last 15 minutes</dt>
                  <dd>{state.recentlyActive || 0}</dd>
               </dl>
               <dl>
                  <dt>Pending approvals</dt>
                  <dd>{state.pendingApprovals}</dd>
               </dl>
            </div>
            <p>
               <strong>Endpoint</strong>
               <br />
               <code>{state.endpoint || 'Configure an HTTPS resource URL and native tokens or OAuth first.'}</code>
            </p>
            <p className={classes.muted}>
               {state.transport} · Protocols {state.protocols.join(', ')}
               <br />
               {state.configured
                  ? 'Server configuration present. Provider connectivity has not been verified.'
                  : 'Configure HTTPS and native tokens or an OAuth provider.'}
            </p>
            <div className={classes.actions}>
               {state.endpoint && <button onClick={() => void copy(state.endpoint!)}>Copy endpoint</button>}
               <button
                  disabled={mutation.isPending || !state.configured}
                  onClick={() => (state.enabled ? policy(false) : setEnableConfirmation(true))}
               >
                  {state.enabled ? 'Disable service' : 'Enable service'}
               </button>
            </div>
            <p role="status">{copyMessage}</p>
         </section>
         <McpV2Panel enabled={!!state.nativeTokensEnabled} endpoint={state.endpoint} />
         <section className={classes.card} aria-labelledby="mcp-clients">
            <div className={classes.heading}>
               <h3 id="mcp-clients">OAuth client authorizations</h3>
               <button
                  disabled={state.oauthEnabled === false}
                  onClick={() => {
                     mutation.reset();
                     setEditor('new');
                  }}
               >
                  Add MCP client
               </button>
            </div>
            <p className={classes.muted}>
               Activity reflects successful authentication. Client labels do not identify or verify the underlying AI model.
            </p>
            {clients.isLoading ? (
               <p role="status">Loading authorizations…</p>
            ) : clients.isError ? (
               <p role="alert">Client authorizations could not be loaded.</p>
            ) : !clients.data?.items.length ? (
               <p>No client authorizations on this page.</p>
            ) : (
               <div className={classes.scroll}>
                  <table>
                     <thead>
                        <tr>
                           <th>Client</th>
                           <th>Status</th>
                           <th>Scopes</th>
                           <th>Dates</th>
                           <th>Actions</th>
                        </tr>
                     </thead>
                     <tbody>
                        {clients.data.items.map((row) => (
                           <tr key={row.id}>
                              <td>
                                 <strong>{row.name}</strong>
                                 <br />
                                 {row.clientType} (declared)
                                 <br />
                                 <code>{row.id}</code>
                              </td>
                              <td>
                                 <span className={classes.badge}>{authorizationStatus(row)}</span>
                              </td>
                              <td>{row.scopes.join(', ')}</td>
                              <td>
                                 Created {date(row.createdAt)}
                                 <br />
                                 Last authenticated {date(row.lastUsedAt)}
                                 <br />
                                 Expires {row.expiresAt ? date(row.expiresAt) : 'No grant expiration'}
                                 <br />
                                 Revoked {date(row.revokedAt)}
                              </td>
                              <td>
                                 <div className={classes.actions}>
                                    <button
                                       disabled={row.revokedAt !== null || mutation.isPending}
                                       onClick={() => {
                                          mutation.reset();
                                          setEditor(row);
                                       }}
                                    >
                                       Permissions
                                    </button>
                                    <button
                                       disabled={row.revokedAt !== null || mutation.isPending}
                                       onClick={() => {
                                          mutation.reset();
                                          setRevoke(row);
                                       }}
                                    >
                                       Revoke
                                    </button>
                                    <button onClick={() => void copy(connectionInstructions(row.clientType, state.endpoint))}>
                                       Copy connection example
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
               <button disabled={!clientOffset || clients.isFetching} onClick={() => setClientOffset(Math.max(0, clientOffset - 20))}>
                  Previous clients
               </button>
               <span>Page {clientOffset / 20 + 1}</span>
               <button disabled={!clients.data?.hasMore || clients.isFetching} onClick={() => setClientOffset(clientOffset + 20)}>
                  Next clients
               </button>
            </div>
         </section>
         <section className={classes.card} aria-labelledby="mcp-tools">
            <h3 id="mcp-tools">Tools & permissions</h3>
            <p>Turning off a tool blocks discovery and execution on the backend, including its REST read route.</p>
            {tools.isLoading ? (
               <p role="status">Loading tools…</p>
            ) : tools.isError ? (
               <p role="alert">Tool catalog could not be loaded.</p>
            ) : (
               tools.data?.map((tool) => (
                  <div className={classes.tool} key={tool.name}>
                     <label>
                        <input
                           type="checkbox"
                           checked={tool.enabled}
                           disabled={mutation.isPending || tool.implicit}
                           onChange={(event) =>
                              policy(
                                 state.enabled,
                                 event.target.checked
                                    ? state.disabledTools.filter((name) => name !== tool.name)
                                    : [...state.disabledTools, tool.name],
                              )
                           }
                        />
                        <code>{tool.name}</code>
                     </label>
                     <p>{tool.description}</p>
                     <span className={classes.badge}>{tool.scope}</span>{' '}
                     <span className={classes.muted}>
                        {tool.implicit
                           ? 'Own action status · Available with write permission'
                           : tool.approvalRequired
                             ? 'Operational · Human approval required'
                             : 'Read · No approval required'}
                     </span>
                  </div>
               ))
            )}
         </section>
         <section className={classes.card} aria-labelledby="mcp-activity">
            <h3 id="mcp-activity">Activity & audit</h3>
            <div className={classes.actions}>
               <label>
                  Client authorization ID{' '}
                  <input
                     value={clientFilter}
                     maxLength={128}
                     onChange={(event) => {
                        setClientFilter(event.target.value);
                        setActivityOffset(0);
                     }}
                  />
               </label>
               <label>
                  Outcome{' '}
                  <select
                     value={outcome}
                     onChange={(event) => {
                        setOutcome(event.target.value);
                        setActivityOffset(0);
                     }}
                  >
                     <option value="">All outcomes</option>
                     {[
                        'success',
                        'started',
                        'pending_approval',
                        'executing',
                        'dispatched',
                        'rejected',
                        'expired',
                        'uncertain',
                        'failed',
                        'insufficient_scope',
                        'not_found',
                        'invalid_request',
                        'protocol_rejected',
                        'internal_error',
                     ].map((value) => (
                        <option key={value}>{value}</option>
                     ))}
                  </select>
               </label>
            </div>
            {activity.isLoading ? (
               <p role="status">Loading activity…</p>
            ) : activity.isError ? (
               <p role="alert">Activity could not be loaded.</p>
            ) : !activity.data?.items.length ? (
               <p>No activity matches these filters.</p>
            ) : (
               <div className={classes.scroll}>
                  <table>
                     <thead>
                        <tr>
                           <th>Time / principal</th>
                           <th>Client / tool</th>
                           <th>Target / outcome</th>
                           <th>Duration / trace</th>
                        </tr>
                     </thead>
                     <tbody>
                        {activity.data.items.map((row) => (
                           <tr key={row.id}>
                              <td>
                                 {date(row.timestamp)}
                                 <br />
                                 {row.principal}
                              </td>
                              <td>
                                 {row.clientId || 'Administrator'}
                                 <br />
                                 <code>{row.operation}</code>
                              </td>
                              <td>
                                 {row.target || '—'}
                                 <br />
                                 {row.outcome}
                              </td>
                              <td>
                                 {row.durationMs === null ? '—' : `${row.durationMs} ms`}
                                 <br />
                                 <code>{row.traceId}</code>
                              </td>
                           </tr>
                        ))}
                     </tbody>
                  </table>
               </div>
            )}
            <div className={classes.pager}>
               <button disabled={!activityOffset || activity.isFetching} onClick={() => setActivityOffset(Math.max(0, activityOffset - 20))}>
                  Previous activity
               </button>
               <span>Page {activityOffset / 20 + 1}</span>
               <button disabled={!activity.data?.hasMore || activity.isFetching} onClick={() => setActivityOffset(activityOffset + 20)}>
                  Next activity
               </button>
            </div>
         </section>
         {editor && (
            <Modal
               stableLayout
               title={editor === 'new' ? 'Add MCP client' : 'Edit client permissions'}
               width="650px"
               closeDisabled={mutation.isPending}
               closeModal={() => setEditor(null)}
            >
               <div className={classes.page}>
                  {mutation.isError && <p role="alert">{mutation.error.message}</p>}
                  <ClientForm
                     initial={editor === 'new' ? undefined : editor}
                     scopes={state.scopes}
                     endpoint={state.endpoint}
                     pending={mutation.isPending}
                     save={(body) =>
                        mutation.mutate({
                           route: editor === 'new' ? 'clients' : `clients/${editor.id}`,
                           method: editor === 'new' ? 'POST' : 'PUT',
                           body,
                        })
                     }
                  />
               </div>
            </Modal>
         )}
         {revoke && (
            <Modal stableLayout title="Revoke MCP client" width="420px" closeDisabled={mutation.isPending} closeModal={() => setRevoke(null)}>
               <p>Revoke {revoke.name}? Future requests using this authorization will be refused.</p>
               <button
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate({ route: `clients/${revoke.id}/revoke`, method: 'POST', body: {} })}
               >
                  Confirm revocation
               </button>
            </Modal>
         )}
         {enableConfirmation && (
            <Modal
               stableLayout
               title="Enable MCP service"
               width="450px"
               closeDisabled={mutation.isPending}
               closeModal={() => setEnableConfirmation(false)}
            >
               <p>
                  Enable access for native tokens and registered OAuth clients with their exact permissions and resource lists. Verify your
                  authentication settings, TLS and reverse proxy settings before connecting clients.
               </p>
               <button disabled={mutation.isPending} onClick={() => policy(true)}>
                  Enable service
               </button>
            </Modal>
         )}
      </div>
   );
}

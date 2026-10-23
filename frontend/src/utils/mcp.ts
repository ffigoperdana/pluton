export type McpGrantInput = {
   name: string;
   clientType: 'Claude' | 'Codex' | 'Grok' | 'Custom';
   subject: string;
   oauthClientId: string;
   scopes: string[];
   planIds: string[];
   agentIds: string[];
   storageIds: string[];
   expiresAt: number | null;
};
export type McpGrant = McpGrantInput & { id: string; createdAt: number; revokedAt: number | null; lastUsedAt: number | null };
export function authorizationStatus(row: McpGrant, now = Date.now()) {
   if (row.revokedAt !== null) return 'Revoked';
   if (row.expiresAt !== null && row.expiresAt <= now) return 'Expired';
   if (row.lastUsedAt === null) return 'Never used';
   return now - row.lastUsedAt < 900000 ? 'Recently active' : 'Authorized';
}
export function connectionInstructions(type: McpGrantInput['clientType'], endpoint: string | null) {
   const url = endpoint || 'https://backup.example.internal/mcp';
   if (type === 'Codex')
      return `[mcp_servers.pluton]\nurl = ${JSON.stringify(url)}\nbearer_token_env_var = "PLUTON_MCP_ACCESS_TOKEN"\n\nObtain a resource-bound access token from your approved identity provider, or use codex mcp login pluton with a registered OAuth client. CLI and IDE share configuration.`;
   if (type === 'Claude')
      return `In Claude Settings → Connectors → Add custom connector, enter ${url}. Use the approved identity provider sign-in. Register the OAuth client identity and your subject here. Your organization must allow Claude's cloud infrastructure to reach the endpoint.`;
   if (type === 'Grok')
      return (
         JSON.stringify({ type: 'mcp', server_url: url, server_label: 'pluton', authorization: '<resource-bound MCP access token>' }, null, 2) +
         '\n\nxAI documents this configuration for its Responses API. A consumer Grok custom connector has not been verified. Model-provider authentication is separate and is not needed by Pluton.'
      );
   return `Connect using Streamable HTTP to ${url}. Send Authorization: Bearer <resource-bound MCP access token>. Use the OAuth issuer advertised by protected-resource metadata. Never send an Agent enrollment token, device secret or Pluton API key.`;
}

export function mcpConfigurationMessage(reason?: string) {
   return (
      (
         {
            'resource-url-missing':
               'MCP_RESOURCE_URL is missing. Set the HTTPS Pluton resource URL ending in /mcp, recreate the application container, then explicitly enable the service.',
            'resource-url-invalid': 'MCP_RESOURCE_URL must be an exact HTTPS URL ending in /mcp, without credentials, query or fragment.',
            'authentication-not-configured': 'Configure native tokens or a complete OAuth provider before enabling MCP.',
            'oauth-incomplete': 'OAuth configuration is incomplete. Configure both issuer and JWKS URL.',
            'oauth-url-invalid': 'OAuth URLs are invalid. HTTPS and exact URLs without credentials, query or fragment are required.',
            ready: 'Server configuration is valid. Service activation is a separate explicit administrator action; connectivity is not verified.',
         } as Record<string, string>
      )[reason || ''] || 'Review server MCP configuration. No service is enabled automatically.'
   );
}

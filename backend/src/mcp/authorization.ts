import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { McpFault, type Principal } from './contracts';
import type { McpStore } from './McpStore';

export type McpConfig = { resource: string; issuer: string; jwksUrl: string };
export function mcpConfig(env: {
	MCP_RESOURCE_URL?: string;
	MCP_OAUTH_ISSUER?: string;
	MCP_OAUTH_JWKS_URL?: string;
}): McpConfig | undefined {
	const values = [env.MCP_RESOURCE_URL, env.MCP_OAUTH_ISSUER, env.MCP_OAUTH_JWKS_URL];
	if (values.some(value => !value)) return undefined;
	try {
		const urls = values.map(value => new URL(value!));
		if (
			urls.some(
				(url, i) =>
					url.protocol !== 'https:' ||
					url.username ||
					url.password ||
					url.search ||
					url.hash ||
					url.href !== values[i]
			)
		)
			return undefined;
		if (urls[0].pathname !== '/mcp') return undefined;
		return { resource: values[0]!, issuer: values[1]!, jwksUrl: values[2]! };
	} catch {
		return undefined;
	}
}
/** Only a statically configured IdP is contacted. No token-controlled jku, x5u or issuer discovery. */
export function createTokenVerifier(
	config: McpConfig,
	store: McpStore,
	key: JWTVerifyGetKey = createRemoteJWKSet(new URL(config.jwksUrl), {
		timeoutDuration: 3000,
		cooldownDuration: 30000,
	})
) {
	return async (token: string): Promise<Principal> => {
		try {
			const { payload, protectedHeader } = await jwtVerify(token, key, {
				issuer: config.issuer,
				audience: config.resource,
				algorithms: ['RS256', 'ES256'],
				requiredClaims: ['sub', 'exp', 'iat'],
				maxTokenAge: '1h',
				typ: 'at+jwt',
			});
			if (
				protectedHeader.jku ||
				protectedHeader.x5u ||
				typeof payload.sub !== 'string' ||
				typeof payload.scope !== 'string' ||
				typeof payload.exp !== 'number' ||
				payload.exp * 1000 <= Date.now() ||
				payload.exp - Number(payload.iat) > 3600
			)
				throw new Error();
			// RFC 9068 client_id is mandatory; initialize.clientInfo is never an identity source.
			if (
				typeof payload.client_id !== 'string' ||
				(payload.azp !== undefined && payload.azp !== payload.client_id)
			)
				throw new Error();
			const grant = store.find(payload.sub, payload.client_id);
			if (!grant) throw new Error();
			const principal = {
				grant,
				tokenScopes: payload.scope.split(' '),
				expiresAt: payload.exp * 1000,
			};
			store.assertActive(principal);
			return principal;
		} catch {
			throw new McpFault(401, 'invalid_token');
		}
	};
}

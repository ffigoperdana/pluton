import type Database from 'better-sqlite3';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { McpFault, parse, type Grant, type Principal } from './contracts';
import { tokenInput, type NativeToken, type TokenInput } from './v2Contracts';
import { toolCatalog } from './OperationalReadService';

type Row = {
	id: string;
	verifier: string;
	configuration: string;
	issuer: string;
	created_at: number;
	expires_at: number;
	last_used_at: number | null;
	revoked_at: number | null;
	disabled: number;
	revision: number;
};
const digest = (value: string) => createHash('sha256').update(value).digest();
function view(row: Row): NativeToken {
	const { ttlHours: _ttl, ...configuration } = parse(tokenInput, JSON.parse(row.configuration));
	return {
		...configuration,
		id: row.id,
		issuer: row.issuer,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		lastUsedAt: row.last_used_at,
		revokedAt: row.revoked_at,
		disabled: !!row.disabled,
		revision: row.revision,
	};
}
/** 256 random secret bits; a SHA-256 verifier is safe against offline guessing of this entropy.
 * Native tokens have their own namespace and never enter browser/OAuth/Agent authentication. */
export class NativeTokenStore {
	constructor(
		private readonly db: Database.Database,
		private readonly audit: (actor: string, id: string, operation: string) => void
	) {}
	get(id: string) {
		const row = this.db.prepare('SELECT * FROM mcp_tokens WHERE id=?').get(id) as Row | undefined;
		return row ? view(row) : undefined;
	}
	list(limit: number, offset: number) {
		const rows = this.db
			.prepare('SELECT * FROM mcp_tokens ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?')
			.all(limit + 1, offset) as Row[];
		return { items: rows.slice(0, limit).map(view), hasMore: rows.length > limit, limit, offset };
	}
	create(input: unknown, actor: string) {
		const value = parse(tokenInput, input);
		return this.db.transaction(() => {
			if ((this.db.prepare('SELECT count(*) n FROM mcp_tokens').get() as { n: number }).n >= 1000)
				throw new McpFault(409, 'token_limit');
			const id = randomBytes(12).toString('hex');
			const plaintext = `pluton_mcp_${id}.${randomBytes(32).toString('base64url')}`;
			this.db
				.prepare(
					'INSERT INTO mcp_tokens(id,verifier,configuration,issuer,created_at,expires_at) VALUES(?,?,?,?,?,?)'
				)
				.run(
					id,
					digest(plaintext).toString('hex'),
					JSON.stringify(value),
					actor,
					Date.now(),
					Date.now() + value.ttlHours * 3600000
				);
			this.audit(actor, id, 'token.create');
			return { token: plaintext, metadata: this.get(id)! };
		})();
	}
	/** Uniform verifier work for known, unknown, malformed and revoked IDs. No raw token logs. */
	authenticate(raw: string): Principal {
		const match = /^pluton_mcp_([a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/.exec(raw);
		const row = this.db
			.prepare('SELECT * FROM mcp_tokens WHERE id=?')
			.get(match?.[1] || 'invalid') as Row | undefined;
		const matches = timingSafeEqual(
			digest(raw),
			Buffer.from(row?.verifier || '0'.repeat(64), 'hex')
		);
		if (!match || !row || !matches) throw new McpFault(401, 'invalid_token');
		const token = this.active(row.id);
		return {
			nativeTokenId: token.id,
			grant: this.grant(token),
			tokenScopes: [
				...(token.mode === 'write' ? [] : ['mcp:read']),
				...(token.mode === 'read' ? [] : ['mcp:write']),
				...this.grant(token).scopes,
			],
			expiresAt: token.expiresAt,
		};
	}
	active(id: string) {
		const token = this.get(id);
		if (!token || token.revokedAt !== null || token.disabled || token.expiresAt <= Date.now())
			throw new McpFault(401, 'invalid_token');
		return token;
	}
	grant(token: NativeToken): Grant {
		return {
			id: `native-${token.id}`,
			subject: `mcp-token:${token.id}`,
			oauthClientId: 'native-token',
			name: token.name,
			clientType: 'Custom',
			scopes: [
				...new Set(
					toolCatalog
						.filter(tool => token.tools.includes(tool.name) && token.mode !== 'write')
						.map(tool => tool.scope)
				),
			],
			planIds: token.planIds,
			agentIds: token.agentIds,
			storageIds: token.storageIds,
			expiresAt: token.expiresAt,
			createdAt: token.createdAt,
			lastUsedAt: token.lastUsedAt,
			revokedAt: token.revokedAt,
		};
	}
	can(id: string, tool: string, planId?: string) {
		const token = this.active(id);
		return (
			token.tools.includes(tool) &&
			(tool.startsWith('pluton_request_') ? token.mode !== 'read' : token.mode !== 'write') &&
			(!planId || token.planIds.includes(planId))
		);
	}
	used(id: string) {
		this.db.prepare('UPDATE mcp_tokens SET last_used_at=? WHERE id=?').run(Date.now(), id);
	}
	edit(id: string, input: unknown, actor: string) {
		const value = parse(tokenInput, input);
		return this.db.transaction(() => {
			const old = this.active(id);
			// Permission edits never extend credential lifetime; rotate for a fresh expiry.
			this.db
				.prepare('UPDATE mcp_tokens SET configuration=?,revision=revision+1 WHERE id=?')
				.run(JSON.stringify(value), id);
			this.audit(actor, id, 'token.permissions');
			return { ...this.get(id)!, expiresAt: old.expiresAt };
		})();
	}
	setDisabled(id: string, disabled: boolean, actor: string) {
		this.db.transaction(() => {
			if (!this.get(id) || this.get(id)!.revokedAt !== null) throw new McpFault(404, 'not_found');
			this.db
				.prepare('UPDATE mcp_tokens SET disabled=?,revision=revision+1 WHERE id=?')
				.run(+disabled, id);
			this.audit(actor, id, disabled ? 'token.disable' : 'token.enable');
		})();
	}
	revoke(id: string, actor: string) {
		this.db.transaction(() => {
			if (!this.get(id)) throw new McpFault(404, 'not_found');
			this.db
				.prepare(
					'UPDATE mcp_tokens SET revoked_at=coalesce(revoked_at,?),revision=revision+1 WHERE id=?'
				)
				.run(Date.now(), id);
			this.audit(actor, id, 'token.revoke');
		})();
	}
	rotate(id: string, ttlHours: number, actor: string) {
		return this.db.transaction(() => {
			const old = this.active(id);
			const {
				id: _id,
				issuer: _issuer,
				createdAt: _created,
				expiresAt: _expires,
				lastUsedAt: _used,
				revokedAt: _revoked,
				disabled: _disabled,
				revision: _revision,
				...configuration
			} = old;
			const issued = this.create({ ...configuration, ttlHours }, actor);
			this.revoke(id, actor);
			this.audit(actor, id, 'token.rotate');
			return issued;
		})();
	}
	revokeAll(actor: string) {
		this.db.transaction(() => {
			this.db
				.prepare('UPDATE mcp_tokens SET revoked_at=coalesce(revoked_at,?),revision=revision+1')
				.run(Date.now());
			this.audit(actor, 'all-native-tokens', 'token.revoke_all');
		})();
	}
}

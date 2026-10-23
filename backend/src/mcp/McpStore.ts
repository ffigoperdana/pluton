import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { grantInput, McpFault, parse, type Grant, type Principal } from './contracts';

type GrantRow = {
	id: string;
	configuration: string;
	created_at: number;
	revoked_at: number | null;
	last_used_at: number | null;
};
const decode = (row: GrantRow): Grant => ({
	...parse(grantInput, JSON.parse(row.configuration)),
	id: row.id,
	createdAt: row.created_at,
	revokedAt: row.revoked_at,
	lastUsedAt: row.last_used_at,
});
export class McpStore {
	constructor(private readonly db: Database.Database) {}
	policy(): { enabled: boolean; disabledTools: string[] } {
		const row = this.db
			.prepare('SELECT enabled,disabled_tools FROM mcp_policy WHERE id=1')
			.get() as { enabled: number; disabled_tools: string };
		return { enabled: row.enabled === 1, disabledTools: JSON.parse(row.disabled_tools) };
	}
	setPolicy(enabled: boolean, disabledTools: string[], actor: string) {
		this.db.transaction(() => {
			this.db
				.prepare('UPDATE mcp_policy SET enabled=?,disabled_tools=? WHERE id=1')
				.run(+enabled, JSON.stringify(disabledTools));
			this.audit(actor, null, enabled ? 'policy.enable' : 'policy.disable', null, 'success');
		})();
	}
	get(id: string): Grant | undefined {
		const row = this.db.prepare('SELECT * FROM mcp_authorizations WHERE id=?').get(id) as
			| GrantRow
			| undefined;
		return row && decode(row);
	}
	find(subject: string, clientId: string): Grant | undefined {
		const row = this.db
			.prepare('SELECT * FROM mcp_authorizations WHERE subject=? AND oauth_client_id=?')
			.get(subject, clientId) as GrantRow | undefined;
		return row && decode(row);
	}
	clients(limit: number, offset: number) {
		const rows = this.db
			.prepare('SELECT * FROM mcp_authorizations ORDER BY created_at DESC,id LIMIT ? OFFSET ?')
			.all(limit + 1, offset) as GrantRow[];
		return { items: rows.slice(0, limit).map(decode), hasMore: rows.length > limit, limit, offset };
	}
	save(input: unknown, actor: string, id?: string) {
		const value = parse(grantInput, input);
		if (value.expiresAt !== null && value.expiresAt <= Date.now())
			throw new McpFault(400, 'invalid_expiration');
		return this.db.transaction(() => {
			const previous = id ? this.get(id) : undefined;
			if (id && !previous) throw new McpFault(404, 'not_found');
			if (previous?.revokedAt) throw new McpFault(409, 'authorization_revoked');
			if (
				previous &&
				(previous.subject !== value.subject || previous.oauthClientId !== value.oauthClientId)
			)
				throw new McpFault(400, 'identity_immutable');
			if (
				!id &&
				(this.db.prepare('SELECT count(*) AS n FROM mcp_authorizations').get() as { n: number })
					.n >= 1000
			)
				throw new McpFault(409, 'authorization_limit');
			if (
				this.find(value.subject, value.oauthClientId)?.id !== id &&
				this.find(value.subject, value.oauthClientId)
			)
				throw new McpFault(409, 'authorization_exists');
			const grantId = id || randomUUID();
			if (id)
				this.db
					.prepare('UPDATE mcp_authorizations SET configuration=?,expires_at=? WHERE id=?')
					.run(JSON.stringify(value), value.expiresAt, id);
			else
				this.db
					.prepare(
						'INSERT INTO mcp_authorizations(id,subject,oauth_client_id,configuration,created_at,expires_at) VALUES(?,?,?,?,?,?)'
					)
					.run(
						grantId,
						value.subject,
						value.oauthClientId,
						JSON.stringify(value),
						Date.now(),
						value.expiresAt
					);
			this.audit(actor, grantId, id ? 'client.update' : 'client.register', grantId, 'success');
			return this.get(grantId)!;
		})();
	}
	revoke(id: string, actor: string) {
		this.db.transaction(() => {
			if (!this.get(id)) throw new McpFault(404, 'not_found');
			this.db
				.prepare('UPDATE mcp_authorizations SET revoked_at=coalesce(revoked_at,?) WHERE id=?')
				.run(Date.now(), id);
			this.audit(actor, id, 'client.revoke', id, 'success');
		})();
	}
	assertActive(principal: Principal) {
		const current = this.get(principal.grant.id);
		if (
			!current ||
			current.revokedAt ||
			(current.expiresAt !== null && current.expiresAt <= Date.now()) ||
			principal.expiresAt <= Date.now()
		)
			throw new McpFault(401, 'invalid_token');
		return current;
	}
	used(id: string) {
		this.db.prepare('UPDATE mcp_authorizations SET last_used_at=? WHERE id=?').run(Date.now(), id);
	}
	audit(
		principal: string,
		clientId: string | null,
		operation: string,
		target: string | null,
		outcome: string,
		traceId: string = randomUUID()
	) {
		return Number(
			this.db
				.prepare(
					'INSERT INTO mcp_audit(timestamp,principal,client_id,operation,target,outcome,trace_id) VALUES(?,?,?,?,?,?,?)'
				)
				.run(Date.now(), principal, clientId, operation, target, outcome, traceId).lastInsertRowid
		);
	}
	finish(id: number, outcome: string, duration: number) {
		this.db
			.prepare('UPDATE mcp_audit SET outcome=?,duration_ms=? WHERE id=?')
			.run(outcome, duration, id);
	}
	target(id: number, target: string) {
		this.db.prepare('UPDATE mcp_audit SET target=? WHERE id=?').run(target, id);
	}
	activity(limit: number, offset: number, clientId?: string, outcome?: string) {
		const rows = this.db
			.prepare(
				`SELECT id,timestamp,principal,client_id AS clientId,operation,target,outcome,duration_ms AS durationMs,trace_id AS traceId FROM mcp_audit WHERE (? IS NULL OR client_id=?) AND (? IS NULL OR outcome=?) ORDER BY timestamp DESC,id DESC LIMIT ? OFFSET ?`
			)
			.all(clientId || null, clientId || null, outcome || null, outcome || null, limit + 1, offset);
		return { items: rows.slice(0, limit), hasMore: rows.length > limit, limit, offset };
	}
	counts() {
		return this.db
			.prepare(
				'SELECT count(*) AS configuredClients,sum(CASE WHEN revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) AND last_used_at>? THEN 1 ELSE 0 END) AS recentlyActive FROM mcp_authorizations'
			)
			.get(Date.now(), Date.now() - 900000) as {
			configuredClients: number;
			recentlyActive: number | null;
		};
	}
}

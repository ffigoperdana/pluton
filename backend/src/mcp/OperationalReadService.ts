import type { DatabaseType } from '../db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { plans } from '../db/schema/plans';
import { backups } from '../db/schema/backups';
import { agentIdentities } from '../db/schema/agents';
import { agentSourceAccessState } from '../db/schema/agentSourceAccess';
import { storages } from '../db/schema/storages';
import { recoveryTests } from '../db/schema/recoveryTests';
import { z } from 'zod';
import { McpFault, pageInput, resourceId, type Grant } from './contracts';

const timestamp = z.string().datetime().nullable();
const idOutput = z.string().max(128);
const safeCode = z
	.string()
	.max(80)
	.regex(/^[a-z0-9_-]+$/)
	.nullable();
const planView = z
	.object({
		id: idOutput,
		active: z.boolean(),
		inProgress: z.boolean().nullable(),
		createdAt: timestamp,
		lastBackupTime: timestamp,
	})
	.strict();
const agentView = z
	.object({
		id: idOutput,
		deviceId: idOutput,
		version: z.string().max(40),
		lastSeen: timestamp,
		revokedAt: timestamp,
	})
	.strict();
const backupView = z
	.object({
		id: idOutput,
		planId: idOutput.nullable(),
		createdAt: timestamp,
		started: timestamp,
		ended: timestamp,
		inProgress: z.boolean().nullable(),
		success: z.boolean().nullable(),
		snapshotId: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.nullable(),
		databaseArtifactCount: z.number().int().nonnegative().nullable(),
		hasError: z.boolean(),
	})
	.strict();
const recoveryView = z
	.object({
		id: idOutput,
		planId: idOutput,
		backupId: idOutput,
		status: z.enum(['queued', 'running', 'passed', 'failed', 'cancelled', 'passed_with_warning']),
		createdAt: timestamp,
		completedAt: timestamp,
		failureCode: safeCode,
		databaseValidation: z
			.array(
				z
					.object({
						artifactValidation: z.enum(['pending', 'passed', 'failed']),
						importValidation: z.enum(['pending', 'passed', 'failed', 'disabled', 'not_configured']),
					})
					.strict()
			)
			.max(50)
			.nullable(),
	})
	.strict();
const storageView = z
	.object({ id: idOutput, createdAt: timestamp, health: z.literal('not_measured') })
	.strict();
const sourceView = z
	.object({
		id: idOutput,
		receivedAt: timestamp,
		effectiveVersion: z.number().nullable(),
		hasAppliedRequest: z.boolean(),
		freshness: z.literal('not_evaluated'),
	})
	.strict();
const replicaView = z
	.object({
		id: idOutput,
		planId: idOutput,
		backupId: idOutput,
		status: z.enum(['pending', 'running', 'completed', 'failed', 'uncertain', 'cancelled']),
		attempts: z.number().int(),
		verifiedAt: z.number().nullable(),
		updatedAt: z.number(),
		lastErrorCode: safeCode,
	})
	.strict();
const list = pageInput;
const detail = z.object({ id: resourceId }).strict();
const planList = pageInput.extend({ planId: resourceId }).strict();
const page = (item: z.ZodType) =>
	z
		.object({
			items: z.array(item).max(50),
			limit: z.number(),
			offset: z.number(),
			hasMore: z.boolean(),
		})
		.strict();
const envelope = (data: z.ZodType) =>
	z
		.object({
			schemaVersion: z.literal('1'),
			observedAt: z.string().datetime(),
			evidence: z.literal('stored_records'),
			data,
		})
		.strict();

// Explicit catalog: never accepts routes, file paths, commands, SQL or provider URLs.
export const toolCatalog = [
	{
		name: 'pluton_list_plans',
		route: '/plans',
		scope: 'plans:read',
		entity: 'plans',
		many: true,
		input: list,
		view: planView,
		description:
			'List explicitly authorized plan records. Configuration does not prove completion.',
	},
	{
		name: 'pluton_get_plan',
		route: '/plans/:id',
		scope: 'plans:read',
		entity: 'plans',
		many: false,
		input: detail,
		view: planView,
		description: 'Read plan activity and last recorded backup time.',
	},
	{
		name: 'pluton_list_agents',
		route: '/agents',
		scope: 'agents:read',
		entity: 'agents',
		many: true,
		input: list,
		view: agentView,
		description:
			'List authorized Agent identities. Last seen does not prove Source Access applied.',
	},
	{
		name: 'pluton_get_agent_status',
		route: '/agents/:id',
		scope: 'agents:read',
		entity: 'agents',
		many: false,
		input: detail,
		view: agentView,
		description: 'Read Agent version, revocation and last authenticated heartbeat timestamp.',
	},
	{
		name: 'pluton_get_source_access_status',
		route: '/agents/:id/source-access',
		scope: 'agents:read',
		entity: 'source',
		many: false,
		input: detail,
		view: sourceView,
		description:
			'Read stored Source Access report version and application evidence without paths. Report freshness is not evaluated.',
	},
	{
		name: 'pluton_list_backups',
		route: '/plans/:planId/backups',
		scope: 'backups:read',
		entity: 'backups',
		many: true,
		input: planList,
		view: backupView,
		description:
			'List authorized plan backup receipts. Snapshot IDs are historical records, not live repository inventory. Artifact count does not prove recoverability.',
	},
	{
		name: 'pluton_get_backup_status',
		route: '/backups/:id',
		scope: 'backups:read',
		entity: 'backups',
		many: false,
		input: detail,
		view: backupView,
		description:
			'Read stored primary backup outcome and artifact count. Success does not prove redundancy or recovery.',
	},
	{
		name: 'pluton_list_storages',
		route: '/storages',
		scope: 'storages:read',
		entity: 'storages',
		many: true,
		input: list,
		view: storageView,
		description:
			'List authorized storage IDs. Health is not measured; credentials and endpoints are omitted.',
	},
	{
		name: 'pluton_list_replications',
		route: '/plans/:planId/replications',
		scope: 'replication:read',
		entity: 'replications',
		many: true,
		input: planList,
		view: replicaView,
		description:
			'List durable managed replication jobs for an authorized plan. Completion is distinct from primary backup success.',
	},
	{
		name: 'pluton_get_replication_status',
		route: '/replications/:id',
		scope: 'replication:read',
		entity: 'replications',
		many: false,
		input: detail,
		view: replicaView,
		description:
			'Read managed replica status and verification timestamp. This is not recovery-test evidence.',
	},
	{
		name: 'pluton_list_recovery_tests',
		route: '/plans/:planId/recovery-tests',
		scope: 'recovery:read',
		entity: 'recovery',
		many: true,
		input: planList,
		view: recoveryView,
		description:
			'List recorded recovery tests for an authorized plan. Inspect exact status; snapshot existence is not a passed recovery test.',
	},
	{
		name: 'pluton_get_recovery_status',
		route: '/recovery-tests/:id',
		scope: 'recovery:read',
		entity: 'recovery',
		many: false,
		input: detail,
		view: recoveryView,
		description:
			'Read exact recovery outcome and safe failure code. Does not claim current repository availability.',
	},
] as const;
export type Tool = (typeof toolCatalog)[number];
export function outputSchema(tool: Tool) {
	return envelope(tool.many ? page(tool.view) : tool.view);
}

/** Read projections over the same application database. No lifecycle managers or repository IO.
 * Existing detail services hydrate secrets and some reads probe storage; these bounded projections
 * are shared by REST and MCP instead of duplicating orchestration or calling internal HTTP routes. */
export class OperationalReadService {
	constructor(private readonly db: DatabaseType) {}
	read(
		tool: Tool,
		grant: Grant,
		args: { id?: string; planId?: string; limit?: number; offset?: number }
	) {
		const ids =
			tool.entity === 'agents' || tool.entity === 'source'
				? grant.agentIds
				: tool.entity === 'storages'
					? grant.storageIds
					: grant.planIds;
		if (args.planId && !ids.includes(args.planId)) throw new McpFault(404, 'not_found');
		const limit = args.limit ?? 20;
		const offset = args.offset ?? 0;
		const n = tool.many ? limit + 1 : 1;
		let rows: unknown[] = [];
		if (ids.length) {
			if (tool.entity === 'plans')
				rows = this.db
					.select({
						id: plans.id,
						active: plans.isActive,
						inProgress: plans.inProgress,
						createdAt: plans.createdAt,
						lastBackupTime: plans.lastBackupTime,
					})
					.from(plans)
					.where(and(inArray(plans.id, ids), args.id ? eq(plans.id, args.id) : undefined))
					.orderBy(desc(plans.id))
					.limit(n)
					.offset(offset)
					.all();
			if (tool.entity === 'agents')
				rows = this.db
					.select({
						id: agentIdentities.agentId,
						deviceId: agentIdentities.deviceId,
						version: agentIdentities.agentVersion,
						lastSeen: agentIdentities.lastSeen,
						revokedAt: agentIdentities.revokedAt,
					})
					.from(agentIdentities)
					.where(
						and(
							inArray(agentIdentities.agentId, ids),
							args.id ? eq(agentIdentities.agentId, args.id) : undefined
						)
					)
					.orderBy(desc(agentIdentities.agentId))
					.limit(n)
					.offset(offset)
					.all();
			if (tool.entity === 'source')
				rows = this.db
					.select({
						id: agentSourceAccessState.agentId,
						receivedAt: agentSourceAccessState.receivedAt,
						effectiveVersion: sql<
							number | null
						>`json_extract(${agentSourceAccessState.report}, '$.effectiveVersion')`,
						hasAppliedRequest:
							sql<boolean>`json_extract(${agentSourceAccessState.report}, '$.lastAppliedRequestId') IS NOT NULL`.mapWith(
								Boolean
							),
						freshness: sql`'not_evaluated'`,
					})
					.from(agentSourceAccessState)
					.where(
						and(
							inArray(agentSourceAccessState.agentId, ids),
							eq(agentSourceAccessState.agentId, args.id!)
						)
					)
					.limit(1)
					.all();
			if (tool.entity === 'storages')
				rows = this.db
					.select({ id: storages.id, createdAt: storages.createdAt, health: sql`'not_measured'` })
					.from(storages)
					.where(inArray(storages.id, ids))
					.orderBy(desc(storages.id))
					.limit(n)
					.offset(offset)
					.all();
			if (tool.entity === 'backups')
				rows = this.db
					.select({
						id: backups.id,
						planId: backups.planId,
						createdAt: backups.createdAt,
						started: backups.started,
						ended: backups.ended,
						inProgress: backups.inProgress,
						success: backups.success,
						snapshotId: sql<
							string | null
						>`CASE WHEN json_valid(${backups.completionStats}) THEN json_extract(${backups.completionStats}, '$.snapshot_id') END`,
						databaseArtifactCount: sql<
							number | null
						>`CASE WHEN json_valid(${backups.completionStats}) THEN CASE WHEN json_type(${backups.completionStats}, '$.lifecycle.databases')='array' THEN json_array_length(${backups.completionStats}, '$.lifecycle.databases') WHEN json_type(${backups.completionStats}, '$.lifecycle.database')='object' THEN 1 END END`,
						hasError:
							sql<boolean>`${backups.errorMsg} IS NOT NULL AND ${backups.errorMsg} != ''`.mapWith(
								Boolean
							),
					})
					.from(backups)
					.where(
						and(
							inArray(backups.planId, ids),
							args.planId ? eq(backups.planId, args.planId) : undefined,
							args.id ? eq(backups.id, args.id) : undefined
						)
					)
					.orderBy(desc(backups.createdAt), desc(backups.id))
					.limit(n)
					.offset(offset)
					.all();
			if (tool.entity === 'recovery')
				rows = this.db
					.select({
						id: recoveryTests.id,
						planId: recoveryTests.planId,
						backupId: recoveryTests.backupId,
						status: recoveryTests.status,
						createdAt: recoveryTests.createdAt,
						completedAt: recoveryTests.completedAt,
						failureCode: recoveryTests.failureCode,
						databaseValidation: sql<
							string | null
						>`CASE WHEN json_valid(${recoveryTests.result}) THEN (SELECT json_group_array(json_object('artifactValidation',json_extract(value,'$.artifactValidation'),'importValidation',json_extract(value,'$.importValidation'))) FROM (SELECT value FROM json_each(${recoveryTests.result},'$.databases') LIMIT 51)) END`.mapWith(
							value => (value === null ? null : JSON.parse(value))
						),
					})
					.from(recoveryTests)
					.where(
						and(
							inArray(recoveryTests.planId, ids),
							args.planId ? eq(recoveryTests.planId, args.planId) : undefined,
							args.id ? eq(recoveryTests.id, args.id) : undefined
						)
					)
					.orderBy(desc(recoveryTests.createdAt), desc(recoveryTests.id))
					.limit(n)
					.offset(offset)
					.all();
			if (tool.entity === 'replications')
				rows = this.db.all(
					sql`SELECT id,plan_id AS planId,backup_id AS backupId,status,attempts,verified_at AS verifiedAt,updated_at AS updatedAt,last_error_code AS lastErrorCode FROM managed_replication_jobs WHERE plan_id IN (${sql.join(
						ids.map(id => sql`${id}`),
						sql`,`
					)}) ${args.planId ? sql`AND plan_id=${args.planId}` : sql``} ${args.id ? sql`AND id=${args.id}` : sql``} ORDER BY created_at DESC,id DESC LIMIT ${n} OFFSET ${offset}`
				);
		}
		if (!tool.many && !rows.length) throw new McpFault(404, 'not_found');
		const data = tool.many
			? { items: rows.slice(0, limit), limit, offset, hasMore: rows.length > limit }
			: rows[0];
		// JSON conversion normalizes Drizzle dates. Output validation fails closed on corrupt records.
		const result = outputSchema(tool).safeParse(
			JSON.parse(
				JSON.stringify({
					schemaVersion: '1',
					observedAt: new Date().toISOString(),
					evidence: 'stored_records',
					data,
				})
			)
		);
		if (!result.success) throw new McpFault(500, 'invalid_stored_evidence');
		return result.data;
	}
}

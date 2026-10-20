import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { agentCommands, agentIdentities } from './agents';
import type {
	SourceAccessReport,
	SourceAccessRequestStatus,
	SourceAccessValidation,
} from '../../types/agentSourceAccess';

/** Host reports and the last confirmed selection are deliberately separate. A heartbeat cannot grant a new root. */
export const agentSourceAccessState = sqliteTable('agent_source_access_state', {
	agentId: text('agent_id')
		.primaryKey()
		.notNull()
		.references(() => agentIdentities.agentId),
	report: text('report', { mode: 'json' }).$type<SourceAccessReport>().notNull(),
	selectedRoots: text('selected_roots', { mode: 'json' }).$type<string[]>().notNull(),
	latestReportTimestamp: integer('latest_report_timestamp').notNull(),
	receivedAt: integer('received_at', { mode: 'timestamp_ms' }).notNull(),
});

/** Immutable request inputs and safe terminal outcomes form the durable audit trail. */
export const agentSourceAccessRequests = sqliteTable(
	'agent_source_access_requests',
	{
		id: text('id').primaryKey().notNull(),
		agentId: text('agent_id')
			.notNull()
			.references(() => agentIdentities.agentId),
		commandId: text('command_id')
			.notNull()
			.references(() => agentCommands.id),
		kind: text('kind').$type<'validate' | 'apply' | 'mode-setup'>().notNull(),
		requestedMode: text('requested_mode').$type<'host-approved' | 'server-managed'>(),
		setupExpiresAt: integer('setup_expires_at', { mode: 'timestamp_ms' }),
		status: text('status').$type<SourceAccessRequestStatus>().notNull(),
		expectedVersion: integer('expected_version').notNull(),
		expectedHostPolicyRevision: text('expected_host_policy_revision').notNull(),
		roots: text('roots', { mode: 'json' }).$type<string[]>().notNull(),
		confirmedAffectedPlanIds: text('confirmed_affected_plan_ids', { mode: 'json' })
			.$type<string[]>()
			.notNull(),
		requestedBy: text('requested_by').notNull().default('administrator-session'),
		validation: text('validation', { mode: 'json' }).$type<SourceAccessValidation[]>(),
		resultCode: text('result_code'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
	},
	table => [
		uniqueIndex('agent_source_access_requests_command_idx').on(table.commandId),
		index('agent_source_access_requests_agent_created_idx').on(table.agentId, table.createdAt),
	]
);

export type AgentSourceAccessState = typeof agentSourceAccessState.$inferSelect;
export type AgentSourceAccessRequest = typeof agentSourceAccessRequests.$inferSelect;

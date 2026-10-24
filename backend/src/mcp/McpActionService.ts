import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PlanService } from '../services/PlanService';
import type { BackupService } from '../services/BackupServices';
import type { RecoveryTestService } from '../services/RecoveryTestService';
import type { NewPlan } from '../db/schema/plans';
import type { NewPlanReq, PlanBackupSettings, PlanSource } from '../types/plans';
import { planInsertSchema, planUpdateSchema } from '../db/schema/plans';
import { preparePlanInterval, previewPlanSchedule } from '../utils/planSchedule';
import { parseBackupExclusions } from '../utils/backupExclusions';
import { recoveryPolicySchema, defaultRecoveryPolicy } from '../utils/recoveryTestPolicy';
import { McpFault, parse, type Principal } from './contracts';
import { actionSchemas, type ActionName, type ActionArgs } from './v2Contracts';
import type { McpStore } from './McpStore';

const canonical = (value: unknown): string =>
	Array.isArray(value)
		? `[${value.map(canonical).join(',')}]`
		: value && typeof value === 'object'
			? `{${Object.entries(value)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
					.join(',')}}`
			: JSON.stringify(value);
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
type Row = {
	id: string;
	token_id: string;
	token_revision: number;
	action: ActionName;
	plan_id: string;
	arguments: string;
	arguments_hash: string;
	state_hash: string;
	idempotency_key: string;
	created_at: number;
	expires_at: number;
	status: string;
	decided_by: string | null;
	decided_at: number | null;
	completed_at: number | null;
	outcome_code: string | null;
	result_id: string | null;
	preview: string;
	execution_state: string | null;
	execution_completed_at: number | null;
};
type PlanRow = {
	id: string;
	title: string;
	method: string;
	source_type: string;
	source_id: string;
	source_config: string;
	storage_id: string;
	storage_path: string;
	settings: string;
	active: number;
	in_progress: number | null;
	[key: string]: unknown;
};
type Services = {
	plans: Pick<
		PlanService,
		'performBackup' | 'pauseBackup' | 'resumeBackup' | 'updatePlan' | 'createPlan'
	>;
	backups: Pick<BackupService, 'cancelBackup'>;
	recovery: Pick<RecoveryTestService, 'enqueue'>;
};
function publicAction(row: Row) {
	return {
		id: row.id,
		action: row.action,
		planId: row.plan_id,
		status: row.status,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		decidedAt: row.decided_at,
		completedAt: row.completed_at,
		outcomeCode: row.outcome_code,
		resultId: row.result_id,
		risk: 'operational',
		approvalRequired: true,
	};
}
/** Durable at-most-once dispatch. A crash in executing remains uncertain, never automatically retried.
 * Existing domain services still own resource admission, scheduling/capacity and actual execution. */
export class McpActionService {
	constructor(
		private readonly db: Database.Database,
		private readonly store: McpStore,
		private readonly services: Services
	) {}
	private get(id: string) {
		return this.db.prepare('SELECT * FROM mcp_actions WHERE id=?').get(id) as Row | undefined;
	}
	pendingCount() {
		this.expire();
		return (
			this.db
				.prepare("SELECT count(*) n FROM mcp_actions WHERE status='pending_approval'")
				.get() as { n: number }
		).n;
	}
	private expire() {
		this.db.transaction(() => {
			const expired = this.db
				.prepare(
					"SELECT id,token_id FROM mcp_actions WHERE status='pending_approval' AND expires_at<=?"
				)
				.all(Date.now()) as { id: string; token_id: string }[];
			for (const row of expired) {
				this.db
					.prepare(
						"UPDATE mcp_actions SET status='expired',completed_at=?,outcome_code='approval_expired' WHERE id=?"
					)
					.run(Date.now(), row.id);
				this.store.audit('server', `native-${row.token_id}`, 'action.expire', row.id, 'expired');
			}
		})();
	}
	private present(row: Row) {
		let execution: { state: string; terminal: boolean; success: boolean | null } | null = null;
		if (row.result_id && ['backup_now', 'cancel_backup'].includes(row.action)) {
			const job = this.db
				.prepare('SELECT in_progress,success FROM backups WHERE id=? AND plan_id=?')
				.get(row.result_id, row.plan_id) as
				| { in_progress: number | null; success: number | null }
				| undefined;
			if (job)
				execution = {
					state: job.in_progress
						? 'in_progress'
						: job.success === null
							? 'not_confirmed'
							: 'finished',
					terminal: !job.in_progress && job.success !== null,
					success: job.in_progress || job.success === null ? null : !!job.success,
				};
		}
		if (row.result_id && row.action === 'recovery_test') {
			const job = this.db
				.prepare('SELECT status FROM recovery_tests WHERE id=? AND plan_id=?')
				.get(row.result_id, row.plan_id) as { status: string } | undefined;
			if (
				job &&
				['queued', 'running', 'passed', 'passed_with_warning', 'failed', 'cancelled'].includes(
					job.status
				)
			)
				execution = {
					state: job.status,
					terminal: !['queued', 'running'].includes(job.status),
					success: ['queued', 'running'].includes(job.status)
						? null
						: ['passed', 'passed_with_warning'].includes(job.status),
				};
		}
		if (execution?.terminal && row.execution_completed_at === null) {
			const state = execution.state;
			this.db.transaction(() => {
				const updated = this.db
					.prepare(
						'UPDATE mcp_actions SET execution_state=?,execution_completed_at=? WHERE id=? AND execution_completed_at IS NULL'
					)
					.run(state, Date.now(), row.id);
				if (updated.changes)
					this.store.audit(
						'server',
						`native-${row.token_id}`,
						'action.job_completion_observed',
						row.id,
						state
					);
			})();
		}
		return { ...publicAction(row), execution };
	}
	recoverInterrupted() {
		this.db.transaction(() => {
			this.expire();
			this.db
				.prepare(
					"UPDATE mcp_actions SET status='uncertain',outcome_code='restart_requires_reconciliation' WHERE status='executing'"
				)
				.run();
			this.store.audit('server', null, 'actions.recover', null, 'success');
		})();
	}
	private admit(
		principal: Principal,
		action: ActionName,
		args: ActionArgs,
		expectedRevision?: number
	) {
		if (!principal.nativeTokenId) throw new McpFault(403, 'native_write_authorization_required');
		const token = this.store.nativeTokens.active(principal.nativeTokenId);
		if (
			!this.store.policy().enabled ||
			this.store.policy().disabledTools.includes(`pluton_request_${action}`) ||
			!this.store.nativeTokens.can(token.id, `pluton_request_${action}`, args.planId)
		)
			throw new McpFault(403, 'insufficient_scope');
		if (expectedRevision !== undefined && token.revision !== expectedRevision)
			throw new McpFault(409, 'authorization_changed');
		return token;
	}
	private snapshot(action: ActionName, args: ActionArgs, tokenId: string, actionId: string) {
		const plan = this.db.prepare('SELECT * FROM plans WHERE id=?').get(args.planId) as
			| PlanRow
			| undefined;
		if (!plan || plan.method !== 'backup' || plan.source_type !== 'device')
			throw new McpFault(404, 'eligible_plan_not_found');
		const settings = JSON.parse(plan.settings) as PlanBackupSettings;
		const source = JSON.parse(plan.source_config) as PlanSource;
		const backup = args.backupId
			? (this.db
					.prepare(
						'SELECT id,plan_id,status,success,in_progress,completion_stats,storage_id,storage_path,source_id FROM backups WHERE id=? AND plan_id=?'
					)
					.get(args.backupId, plan.id) as Record<string, unknown> | undefined)
			: undefined;
		if (args.backupId && !backup) throw new McpFault(404, 'not_found');
		const running = this.db
			.prepare('SELECT id,status FROM backups WHERE plan_id=? AND in_progress=1 ORDER BY id')
			.all(plan.id);
		const restoring = this.db
			.prepare('SELECT id,status FROM restores WHERE plan_id=? AND in_progress=1 ORDER BY id')
			.all(plan.id);
		if (
			action === 'backup_now' &&
			(!plan.active || plan.in_progress || running.length || restoring.length)
		)
			throw new McpFault(409, 'plan_paused_or_busy');
		if (action === 'cancel_backup' && !backup?.in_progress)
			throw new McpFault(409, 'backup_not_running');
		if (
			['create_plan', 'update_plan', 'update_schedule', 'update_exclusions'].includes(action) &&
			(plan.in_progress || running.length || restoring.length)
		)
			throw new McpFault(409, 'plan_busy');
		if ((action === 'pause_plan' && !plan.active) || (action === 'resume_plan' && plan.active))
			throw new McpFault(409, 'plan_state_conflict');
		let after: unknown = { operation: action };
		let before: unknown = { active: !!plan.active };
		if (action === 'pause_plan' || action === 'resume_plan')
			after = { active: action === 'resume_plan' };
		if (action === 'cancel_backup') {
			before = { backupId: args.backupId, inProgress: true };
			after = { backupId: args.backupId, cancellationRequested: true };
		}
		if (action === 'update_plan') {
			parse(planUpdateSchema, { title: args.title });
			before = { title: plan.title };
			after = { title: args.title };
		}
		if (action === 'update_schedule') {
			let interval;
			try {
				interval = preparePlanInterval(args.interval!, settings.interval);
			} catch {
				throw new McpFault(400, 'invalid_schedule');
			}
			after = { interval, preview: previewPlanSchedule(interval) };
			before = { interval: settings.interval };
		}
		if (action === 'update_exclusions') {
			if (plan.source_id === 'main') throw new McpFault(409, 'managed_agent_required');
			let exclusions: string[];
			try {
				exclusions = parseBackupExclusions(args.exclusions);
			} catch {
				throw new McpFault(400, 'invalid_exclusions');
			}
			if (exclusions.some(value => ['*', '**', '**/*', '*/*'].includes(value)))
				throw new McpFault(400, 'unsafe_exclusions');
			after = { exclusions };
			before = { exclusions: source.excludes || [] };
		}
		const agent = this.db
			.prepare(
				'SELECT agent_id,device_id,agent_version,capabilities,revoked_at FROM agent_identities WHERE device_id=?'
			)
			.get(plan.source_id) as Record<string, unknown> | undefined;
		if (agent?.revoked_at) throw new McpFault(409, 'agent_unavailable');
		const storage = this.db.prepare('SELECT * FROM storages WHERE id=?').get(plan.storage_id);
		if (!storage) throw new McpFault(404, 'storage_not_found');
		const token = this.store.nativeTokens.active(tokenId);
		const replicaIds = settings.replication?.enabled
			? settings.replication.storages.map(item => item.storageId)
			: [];
		if (replicaIds.length > 50 || replicaIds.some(id => !token.storageIds.includes(id)))
			throw new McpFault(403, 'replication_resource_not_granted');
		const replicaStorages = [...new Set(replicaIds)]
			.sort()
			.map(id => this.db.prepare('SELECT * FROM storages WHERE id=?').get(id));
		if (
			!token.storageIds.includes(plan.storage_id) ||
			(plan.source_id !== 'main' && (!agent || !token.agentIds.includes(String(agent.agent_id))))
		)
			throw new McpFault(403, 'resource_not_granted');
		const sourceAccess = agent
			? this.db
					.prepare('SELECT report,selected_roots FROM agent_source_access_state WHERE agent_id=?')
					.get(String(agent.agent_id))
			: undefined;
		const recoveryPolicy = this.db
			.prepare('SELECT policy FROM recovery_test_policies WHERE plan_id=?')
			.get(plan.id) as { policy: string } | undefined;
		const recoveryTargets = this.db
			.prepare('SELECT * FROM recovery_targets WHERE plan_id=? ORDER BY id')
			.all(plan.id);
		const repository = this.db
			.prepare('SELECT * FROM remote_managed_repositories WHERE plan_id=?')
			.get(plan.id);
		const databaseCredential = this.db
			.prepare('SELECT * FROM remote_plan_database_credentials WHERE plan_id=?')
			.get(plan.id);
		const databaseEntryCredentials = this.db
			.prepare(
				'SELECT * FROM remote_plan_database_entry_credentials WHERE plan_id=? ORDER BY database_id'
			)
			.all(plan.id);
		if (action === 'create_plan') {
			const token = this.store.nativeTokens.active(tokenId);
			if (
				!agent ||
				!token.agentIds.includes(String(agent.agent_id)) ||
				!token.storageIds.includes(plan.storage_id) ||
				settings.remoteLifecycle ||
				settings.replication?.enabled ||
				Object.values(settings.scripts || {}).some(items => items?.some(item => item.enabled))
			)
				throw new McpFault(409, 'template_not_eligible');
			const candidate: NewPlan = {
				id: actionId,
				title: args.title!,
				method: 'backup',
				sourceType: 'device',
				sourceId: plan.source_id,
				sourceConfig: source,
				storageId: plan.storage_id,
				storagePath: `${plan.storage_path}-mcp-${actionId}`,
				settings: { ...settings, interval: preparePlanInterval(settings.interval) },
			};
			parse(planInsertSchema, candidate);
			before = { templatePlanId: plan.id };
			after = {
				title: args.title,
				sourceDeviceId: plan.source_id,
				storageId: plan.storage_id,
				destination: candidate.storagePath,
				runNow: false,
			};
		}
		if (action === 'recovery_test' && (!backup?.success || backup.in_progress || !agent))
			throw new McpFault(409, 'recovery_candidate_not_eligible');
		if (action === 'recovery_test') {
			const policy = parse(
				recoveryPolicySchema.extend({ enabledAt: z.number().int().nonnegative().optional() }),
				recoveryPolicy ? JSON.parse(recoveryPolicy.policy) : defaultRecoveryPolicy
			);
			before = { backupId: args.backupId };
			after = {
				backupId: args.backupId,
				databaseImport: policy.databaseImport,
				targetModes: policy.targetModes || {},
				targetIds: recoveryTargets.map(row => (row as { id: string }).id),
				workspace: 'server-managed-isolated',
			};
		}
		const stablePlan = {
			...plan,
			last_backup_time: undefined,
			stats: undefined,
			verified: undefined,
		};
		return {
			plan,
			settings,
			source,
			stateHash: hash({
				plan: stablePlan,
				backup,
				running,
				restoring,
				agent,
				sourceAccess,
				storage,
				replicaStorages,
				recoveryPolicy,
				recoveryTargets,
				repository,
				databaseCredential,
				databaseEntryCredentials,
			}),
			preview: {
				before,
				after,
				warnings:
					action === 'update_exclusions'
						? ['Excluded data will not be backed up. Review every pattern.']
						: action === 'recovery_test'
							? [
									'Uses existing approved recovery policy and isolated targets; never a production restore.',
								]
							: ['This operational action requires human approval.'],
			},
		};
	}
	submit(principal: Principal, action: ActionName, input: unknown) {
		const args = parse(
			actionSchemas[action] as unknown as import('zod').z.ZodType<ActionArgs>,
			input
		);
		const token = this.admit(principal, action, args);
		return this.db.transaction(() => {
			this.expire();
			const old = this.db
				.prepare('SELECT * FROM mcp_actions WHERE token_id=? AND idempotency_key=?')
				.get(token.id, args.idempotencyKey) as Row | undefined;
			const argumentsHash = hash({ action, args });
			if (old) {
				if (old.arguments_hash !== argumentsHash) throw new McpFault(409, 'idempotency_conflict');
				return publicAction(old);
			}
			if (
				(
					this.db
						.prepare(
							"SELECT count(*) n FROM mcp_actions WHERE token_id=? AND status IN ('pending_approval','executing','uncertain')"
						)
						.get(token.id) as { n: number }
				).n >= 10 ||
				(
					this.db
						.prepare(
							"SELECT count(*) n FROM mcp_actions WHERE status IN ('pending_approval','executing','uncertain')"
						)
						.get() as { n: number }
				).n >= 100
			)
				throw new McpFault(429, 'pending_action_limit');
			if (
				this.db
					.prepare(
						"SELECT id FROM mcp_actions WHERE plan_id=? AND status IN ('pending_approval','executing','uncertain')"
					)
					.get(args.planId)
			)
				throw new McpFault(409, 'plan_action_conflict');
			const id = randomUUID();
			const snapshot = this.snapshot(action, args, token.id, id);
			const expiry = Math.min(Date.now() + 900000, token.expiresAt);
			this.db
				.prepare(
					"INSERT INTO mcp_actions(id,token_id,token_revision,action,plan_id,arguments,arguments_hash,state_hash,idempotency_key,created_at,expires_at,status,preview) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending_approval',?)"
				)
				.run(
					id,
					token.id,
					token.revision,
					action,
					args.planId,
					canonical(args),
					argumentsHash,
					snapshot.stateHash,
					args.idempotencyKey,
					Date.now(),
					expiry,
					JSON.stringify(snapshot.preview)
				);
			this.store.audit(
				`mcp-token:${token.id}`,
				`native-${token.id}`,
				'action.request',
				id,
				'pending_approval'
			);
			return publicAction(this.get(id)!);
		})();
	}
	status(principal: Principal, id: string) {
		this.store.assertActive(principal);
		if (
			!principal.nativeTokenId ||
			this.store.nativeTokens.active(principal.nativeTokenId).mode === 'read'
		)
			throw new McpFault(403, 'insufficient_scope');
		this.expire();
		const row = this.get(id);
		if (!row || row.token_id !== principal.nativeTokenId) throw new McpFault(404, 'not_found');
		return this.present(row);
	}
	list(limit: number, offset: number, pending = false) {
		this.expire();
		const rows = this.db
			.prepare(
				`SELECT * FROM mcp_actions ${pending ? "WHERE status='pending_approval'" : ''} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`
			)
			.all(limit + 1, offset) as Row[];
		return {
			items: rows.slice(0, limit).map(row => ({
				...this.present(row),
				tokenId: row.token_id,
				arguments: JSON.parse(row.arguments),
				argumentsHash: row.arguments_hash,
				preview: JSON.parse(row.preview),
				decidedBy: row.decided_by,
			})),
			hasMore: rows.length > limit,
			limit,
			offset,
		};
	}
	reject(id: string, actor: string) {
		return this.db.transaction(() => {
			this.expire();
			const row = this.get(id);
			if (!row || row.status !== 'pending_approval') throw new McpFault(409, 'action_not_pending');
			this.db
				.prepare(
					"UPDATE mcp_actions SET status='rejected',decided_by=?,decided_at=?,completed_at=? WHERE id=?"
				)
				.run(actor, Date.now(), Date.now(), id);
			this.store.audit(actor, `native-${row.token_id}`, 'action.reject', id, 'rejected');
			return publicAction(this.get(id)!);
		})();
	}
	async approve(id: string, actor: string, confirmationHash: string) {
		this.expire();
		const claimed = this.db.transaction(() => {
			this.expire();
			const row = this.get(id);
			if (!row || row.status !== 'pending_approval') throw new McpFault(409, 'action_not_pending');
			if (actor.startsWith('mcp-token:') || confirmationHash !== row.arguments_hash)
				throw new McpFault(403, 'human_confirmation_required');
			const args = parse(
				actionSchemas[row.action] as unknown as import('zod').z.ZodType<ActionArgs>,
				JSON.parse(row.arguments)
			);
			if (hash({ action: row.action, args }) !== row.arguments_hash)
				throw new McpFault(409, 'action_binding_invalid');
			const token = this.store.nativeTokens.active(row.token_id);
			this.admit(
				{
					nativeTokenId: token.id,
					grant: this.store.nativeTokens.grant(token),
					tokenScopes: [],
					expiresAt: token.expiresAt,
				},
				row.action,
				args,
				row.token_revision
			);
			const snapshot = this.snapshot(row.action, args, token.id, row.id);
			if (snapshot.stateHash !== row.state_hash)
				throw new McpFault(409, 'resource_changed_request_again');
			if (row.expires_at <= Date.now()) throw new McpFault(409, 'approval_expired');
			this.admit(
				{
					nativeTokenId: token.id,
					grant: this.store.nativeTokens.grant(token),
					tokenScopes: [],
					expiresAt: token.expiresAt,
				},
				row.action,
				args,
				row.token_revision
			);
			this.db
				.prepare(
					"UPDATE mcp_actions SET status='executing',decided_by=?,decided_at=? WHERE id=? AND status='pending_approval'"
				)
				.run(actor, Date.now(), id);
			this.store.audit(actor, `native-${row.token_id}`, 'action.approve', id, 'executing');
			const backupBoundary =
				row.action === 'backup_now'
					? (
							this.db.prepare('SELECT coalesce(max(rowid),0) boundary FROM backups').get() as {
								boundary: number;
							}
						).boundary
					: 0;
			return { row, args, snapshot, backupBoundary };
		})();
		const { row, args, snapshot } = claimed;
		// No await between the persisted claim, final admission and domain-service entry.
		try {
			let resultId: string | null = row.action === 'cancel_backup' ? args.backupId! : null;
			if (row.action === 'backup_now') {
				await this.services.plans.performBackup(args.planId);
				const jobs = this.db
					.prepare('SELECT id FROM backups WHERE plan_id=? AND rowid>? ORDER BY rowid LIMIT 2')
					.all(args.planId, claimed.backupBoundary) as { id: string }[];
				// Only claim correlation when one new durable job is unambiguous.
				if (jobs.length === 1) resultId = jobs[0].id;
			}
			if (row.action === 'pause_plan') await this.services.plans.pauseBackup(args.planId);
			if (row.action === 'resume_plan') await this.services.plans.resumeBackup(args.planId);
			if (row.action === 'cancel_backup')
				await this.services.backups.cancelBackup(args.planId, args.backupId!);
			if (row.action === 'update_plan')
				await this.services.plans.updatePlan(args.planId, { title: args.title });
			if (row.action === 'update_schedule')
				await this.services.plans.updatePlan(args.planId, {
					settings: {
						interval: preparePlanInterval(args.interval!, snapshot.settings.interval),
					} as PlanBackupSettings,
				});
			if (row.action === 'update_exclusions')
				await this.services.plans.updatePlan(args.planId, {
					sourceConfig: { ...snapshot.source, excludes: parseBackupExclusions(args.exclusions) },
				});
			if (row.action === 'create_plan') {
				const plan = await this.services.plans.createPlan(
					{
						title: args.title!,
						method: 'backup',
						sourceType: 'device',
						sourceId: snapshot.plan.source_id,
						sourceConfig: snapshot.source,
						storage: { id: snapshot.plan.storage_id, name: '' },
						storagePath: `${snapshot.plan.storage_path}-mcp-${row.id}`,
						tags: [],
						settings: snapshot.settings,
					} as NewPlanReq,
					{ runNow: false }
				);
				resultId = plan.id;
			}
			if (row.action === 'recovery_test') {
				const result = await this.services.recovery.enqueue(args.planId, args.backupId!);
				resultId = result?.id || null;
			}
			this.complete(row, actor, 'dispatched', 'domain_service_accepted', resultId);
		} catch {
			// Existing services can fail after side effects. Never mark these retryable or execute again.
			this.complete(row, actor, 'uncertain', 'domain_failure_requires_reconciliation', null);
		}
		return publicAction(this.get(id)!);
	}
	private complete(row: Row, actor: string, status: string, code: string, resultId: string | null) {
		this.db.transaction(() => {
			this.db
				.prepare(
					'UPDATE mcp_actions SET status=?,completed_at=?,outcome_code=?,result_id=? WHERE id=?'
				)
				.run(status, Date.now(), code, resultId, row.id);
			this.store.audit(actor, `native-${row.token_id}`, 'action.dispatch', row.id, status);
		})();
	}
	reconcile(id: string, actor: string) {
		return this.db.transaction(() => {
			const row = this.get(id);
			if (!row || row.status !== 'uncertain') throw new McpFault(409, 'action_not_uncertain');
			this.db
				.prepare(
					"UPDATE mcp_actions SET status='failed',outcome_code='operator_reconciled_no_replay',completed_at=? WHERE id=?"
				)
				.run(Date.now(), id);
			this.store.audit(actor, `native-${row.token_id}`, 'action.reconcile', id, 'failed');
			return publicAction(this.get(id)!);
		})();
	}
}

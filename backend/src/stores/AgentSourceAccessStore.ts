import { and, count, desc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import type { parseSourceHistoryQuery } from '../utils/sourceAccessHistory';
import type { DatabaseType } from '../db';
import { agentCommands, agentIdentities } from '../db/schema/agents';
import {
	agentSourceAccessRequests,
	agentSourceAccessState,
	type AgentSourceAccessRequest,
	type AgentSourceAccessState,
} from '../db/schema/agentSourceAccess';
import { plans } from '../db/schema/plans';
import { backups } from '../db/schema/backups';
import { AppError } from '../utils/AppError';
import { AGENT_REQUEST_SKEW_MS } from '../types/agents';
import { sameSourceRoots, sourcePathWithin, sourceReportHealthy } from '../utils/agentSourceAccess';
import type {
	SourceAccessCommandResult,
	SourceAccessPlan,
	SourceAccessReport,
	SourceAccessRequestStatus,
} from '../types/agentSourceAccess';

type SourceDatabase = Pick<DatabaseType, 'select' | 'insert' | 'update'>;
const liveCommandStates = ['leased', 'acknowledged', 'running'] as const;
const openRequestStates = ['queued', 'validating'] as const;

/** All selection changes, request outcomes and command acknowledgements are durable SQLite transactions. */
export class AgentSourceAccessStore {
	constructor(private readonly db: DatabaseType) {}

	async getState(agentId: string): Promise<AgentSourceAccessState | null> {
		return (
			this.db
				.select()
				.from(agentSourceAccessState)
				.where(eq(agentSourceAccessState.agentId, agentId))
				.get() || null
		);
	}

	async listRequests(agentId: string): Promise<AgentSourceAccessRequest[]> {
		return this.db
			.select()
			.from(agentSourceAccessRequests)
			.where(eq(agentSourceAccessRequests.agentId, agentId))
			.orderBy(desc(agentSourceAccessRequests.createdAt), desc(agentSourceAccessRequests.id))
			.limit(20)
			.all();
	}

	/** Read-only keyset pages. The rowid high-water mark excludes later insertions,
	 * including requests with equal/backdated timestamps. No audit rows are truncated. */
	async requestHistory(agentId: string, options: ReturnType<typeof parseSourceHistoryQuery>) {
		return this.db.transaction(tx => {
			const rowid = sql<number>`${agentSourceAccessRequests}.rowid`;
			const ceiling =
				options.cursor?.ceiling ??
				tx
					.select({ value: sql<number>`coalesce(max(${rowid}), 0)` })
					.from(agentSourceAccessRequests)
					.where(eq(agentSourceAccessRequests.agentId, agentId))
					.get()!.value;
			const scope = and(
				eq(agentSourceAccessRequests.agentId, agentId),
				lte(rowid, ceiling),
				options.status ? eq(agentSourceAccessRequests.status, options.status) : undefined,
				options.kind ? eq(agentSourceAccessRequests.kind, options.kind) : undefined
			);
			const before = options.cursor?.before;
			const position = before
				? or(
						lt(agentSourceAccessRequests.createdAt, new Date(before.time)),
						and(
							eq(agentSourceAccessRequests.createdAt, new Date(before.time)),
							lt(agentSourceAccessRequests.id, before.id)
						)
					)
				: undefined;
			const requests = tx
				.select()
				.from(agentSourceAccessRequests)
				.where(and(scope, position))
				.orderBy(desc(agentSourceAccessRequests.createdAt), desc(agentSourceAccessRequests.id))
				.limit(options.limit + 1)
				.all();
			const total = tx
				.select({ value: count() })
				.from(agentSourceAccessRequests)
				.where(scope)
				.get()!.value;
			return {
				requests: requests.slice(0, options.limit),
				hasMore: requests.length > options.limit,
				total,
				ceiling,
			};
		});
	}

	async getOpenApply(agentId: string): Promise<AgentSourceAccessRequest | null> {
		return (
			this.db
				.select()
				.from(agentSourceAccessRequests)
				.where(
					and(
						eq(agentSourceAccessRequests.agentId, agentId),
						eq(agentSourceAccessRequests.kind, 'apply'),
						inArray(agentSourceAccessRequests.status, [...openRequestStates])
					)
				)
				.get() || null
		);
	}

	private modeFrozen(
		db: SourceDatabase,
		agentId: string,
		now: Date
	): AgentSourceAccessRequest | undefined {
		return db
			.select()
			.from(agentSourceAccessRequests)
			.where(
				and(
					eq(agentSourceAccessRequests.agentId, agentId),
					eq(agentSourceAccessRequests.kind, 'mode-setup')
				)
			)
			.all()
			.find(
				request =>
					request.setupExpiresAt &&
					request.setupExpiresAt.getTime() + AGENT_REQUEST_SKEW_MS > now.getTime() &&
					!['applied', 'cancelled'].includes(request.status)
			);
	}

	async getOpenModeSetup(agentId: string, now: Date): Promise<AgentSourceAccessRequest | null> {
		return this.modeFrozen(this.db, agentId, now) || null;
	}

	private activeOperations(
		db: SourceDatabase,
		agentId: string,
		deviceId: string,
		excludeCommandId?: string
	): number {
		const jobs = db
			.select({ id: backups.id })
			.from(backups)
			.where(
				and(
					eq(backups.sourceId, deviceId),
					or(
						eq(backups.inProgress, true),
						inArray(backups.status, ['queued', 'running', 'started', 'in_progress'])
					)
				)
			)
			.all();
		const commands = db
			.select({ id: agentCommands.id })
			.from(agentCommands)
			.where(
				and(
					eq(agentCommands.agentId, agentId),
					inArray(agentCommands.type, [
						'BACKUP_FILESYSTEM',
						'SOURCE_ACCESS_APPLY',
						'SOURCE_ACCESS_VALIDATE',
						'SOURCE_ACCESS_MODE_SETUP',
					]),
					inArray(agentCommands.state, ['queued', 'leased', 'acknowledged', 'running'])
				)
			)
			.all();
		return jobs.length + commands.filter(command => command.id !== excludeCommandId).length;
	}

	async getModeChangeState(
		agentId: string,
		deviceId: string,
		now: Date
	): Promise<{ plans: SourceAccessPlan[]; activeOperationCount: number; blocked: boolean }> {
		const plans = this.readPlans(this.db, deviceId);
		const activeOperationCount = this.activeOperations(this.db, agentId, deviceId);
		return {
			plans,
			activeOperationCount,
			blocked:
				plans.some(plan => plan.isActive) ||
				activeOperationCount > 0 ||
				!!this.modeFrozen(this.db, agentId, now),
		};
	}

	async getRequestForCommand(
		agentId: string,
		commandId: string
	): Promise<AgentSourceAccessRequest | null> {
		return (
			this.db
				.select()
				.from(agentSourceAccessRequests)
				.where(
					and(
						eq(agentSourceAccessRequests.agentId, agentId),
						eq(agentSourceAccessRequests.commandId, commandId)
					)
				)
				.get() || null
		);
	}

	/** Repair only terminal bookkeeping. This never queues work or changes a selection. */
	async reconcileTerminalRequests(
		agentId: string,
		now: Date
	): Promise<{ id: string; status: SourceAccessRequestStatus; code: string }[]> {
		return this.db.transaction(tx => {
			const rows = tx
				.select({ request: agentSourceAccessRequests, commandState: agentCommands.state })
				.from(agentSourceAccessRequests)
				.innerJoin(agentCommands, eq(agentCommands.id, agentSourceAccessRequests.commandId))
				.where(
					and(
						eq(agentSourceAccessRequests.agentId, agentId),
						inArray(agentSourceAccessRequests.status, [...openRequestStates, 'pending-host-setup'])
					)
				)
				.all();
			const state = tx
				.select()
				.from(agentSourceAccessState)
				.where(eq(agentSourceAccessState.agentId, agentId))
				.get();
			const changed: { id: string; status: SourceAccessRequestStatus; code: string }[] = [];
			for (const { request, commandState } of rows) {
				let status: SourceAccessRequestStatus;
				let code: string;
				if (request.kind === 'mode-setup') {
					if (
						!request.setupExpiresAt ||
						request.setupExpiresAt.getTime() + AGENT_REQUEST_SKEW_MS > now.getTime()
					)
						continue;
					tx.update(agentSourceAccessRequests)
						.set({ status: 'rejected', resultCode: 'source-mode-setup-expired', completedAt: now })
						.where(eq(agentSourceAccessRequests.id, request.id))
						.run();
					tx.update(agentCommands)
						.set({ state: 'expired', completedAt: now, lastError: 'source-mode-setup-expired' })
						.where(eq(agentCommands.id, request.commandId))
						.run();
					changed.push({ id: request.id, status: 'rejected', code: 'source-mode-setup-expired' });
					continue;
				}
				if (commandState === 'cancelled') {
					status = 'cancelled';
					code = 'source-command-cancelled';
				} else if (commandState === 'failed' || commandState === 'expired') {
					status = 'rejected';
					code = commandState === 'expired' ? 'source-command-expired' : 'source-command-failed';
				} else if (commandState === 'completed') {
					if (state && this.matchesAppliedReport(request, state.report)) {
						status = 'applied';
						code = 'source-selection-applied';
					} else {
						status = 'validating';
						code = 'source-outcome-unconfirmed';
					}
				} else continue;
				if (request.status === status && request.resultCode === code) continue;
				tx.update(agentSourceAccessRequests)
					.set({ status, resultCode: code, completedAt: status === 'validating' ? null : now })
					.where(eq(agentSourceAccessRequests.id, request.id))
					.run();
				changed.push({ id: request.id, status, code });
			}
			return changed;
		});
	}

	async getPlans(deviceId: string): Promise<SourceAccessPlan[]> {
		return this.readPlans(this.db, deviceId);
	}

	private readPlans(db: SourceDatabase, deviceId: string): SourceAccessPlan[] {
		return db
			.select({
				id: plans.id,
				title: plans.title,
				isActive: plans.isActive,
				sourceConfig: plans.sourceConfig,
			})
			.from(plans)
			.where(and(eq(plans.sourceId, deviceId), eq(plans.sourceType, 'device')))
			.all()
			.map(plan => ({
				id: plan.id,
				title: plan.title,
				isActive: Boolean(plan.isActive),
				sourcePath: plan.sourceConfig.includes?.[0] || '',
			}));
	}

	/** A signed, newer host heartbeat can refresh health, but cannot authorize a different selection. */
	async recordHeartbeat(
		agentId: string,
		report: SourceAccessReport,
		signedTimestamp: number,
		now: Date
	): Promise<void> {
		this.db.transaction(tx => this.writeReport(tx, agentId, report, signedTimestamp, now));
	}

	private writeReport(
		db: SourceDatabase,
		agentId: string,
		report: SourceAccessReport,
		signedTimestamp: number,
		now: Date,
		allowConfirmedSelection = true
	): void {
		const state = db
			.select()
			.from(agentSourceAccessState)
			.where(eq(agentSourceAccessState.agentId, agentId))
			.get();
		if (
			state &&
			(signedTimestamp <= state.latestReportTimestamp ||
				(report.effectiveVersion < state.report.effectiveVersion && !report.policyError))
		)
			return;
		// An unavailable host-policy file/active local writer proves failed health,
		// not a mode transition. Preserve the last confirmed authority metadata.
		if (state && report.policyError)
			report = {
				...report,
				authorizationMode: state.report.authorizationMode,
				delegatedRoots: state.report.delegatedRoots,
				lastModeSetupRequestId: state.report.lastModeSetupRequestId,
				effectiveRoots: [],
			};
		let selectedRoots = state?.selectedRoots || report.rootStatuses.map(root => root.path);
		let accepted = report;
		let modeUnconfirmed = false;
		const previousMode = state?.report.authorizationMode || 'host-approved';
		const nextMode = report.authorizationMode || 'host-approved';
		if (
			previousMode !== nextMode ||
			!sameSourceRoots(state?.report.delegatedRoots || [], report.delegatedRoots || []) ||
			(state && state.report.lastModeSetupRequestId !== report.lastModeSetupRequestId) ||
			state?.report.policyError === 'source-mode-unconfirmed'
		) {
			const setup = report.lastModeSetupRequestId
				? db
						.select()
						.from(agentSourceAccessRequests)
						.where(
							and(
								eq(agentSourceAccessRequests.id, report.lastModeSetupRequestId),
								eq(agentSourceAccessRequests.agentId, agentId)
							)
						)
						.get()
				: undefined;
			if (
				setup &&
				setup.kind === 'mode-setup' &&
				['queued', 'validating', 'pending-host-setup', 'applied'].includes(setup.status) &&
				setup.requestedMode === nextMode &&
				sameSourceRoots(setup.roots, report.delegatedRoots || []) &&
				report.effectiveVersion === setup.expectedVersion &&
				report.effectiveRoots.every(root =>
					selectedRoots.some(selected => sourcePathWithin(selected, root))
				)
			) {
				db.update(agentSourceAccessRequests)
					.set({ status: 'applied', completedAt: now, resultCode: 'source-mode-setup-applied' })
					.where(eq(agentSourceAccessRequests.id, setup.id))
					.run();
			} else modeUnconfirmed = true;
		}
		if (state && !modeUnconfirmed) {
			if (report.effectiveVersion < state.report.effectiveVersion) {
				// A newer signed missing/corrupt local-state report immediately revokes health,
				// while preserving the last confirmed selection generation for operator recovery.
				accepted = {
					...report,
					effectiveVersion: state.report.effectiveVersion,
					effectiveRoots: [],
				};
			} else if (report.effectiveVersion > state.report.effectiveVersion) {
				const request = report.lastAppliedRequestId
					? db
							.select()
							.from(agentSourceAccessRequests)
							.where(
								and(
									eq(agentSourceAccessRequests.id, report.lastAppliedRequestId),
									eq(agentSourceAccessRequests.agentId, agentId)
								)
							)
							.get()
					: undefined;
				if (
					allowConfirmedSelection &&
					request &&
					this.matchesAppliedReport(request, report) &&
					['queued', 'validating', 'applied'].includes(request.status)
				) {
					selectedRoots = request.roots;
					db.update(agentSourceAccessRequests)
						.set({ status: 'applied', completedAt: now, resultCode: 'source-selection-applied' })
						.where(eq(agentSourceAccessRequests.id, request.id))
						.run();
				} else {
					accepted = {
						...report,
						effectiveVersion: state.report.effectiveVersion,
						effectiveRoots: [],
						policyError: 'source-policy-unconfirmed-selection',
					};
				}
			} else if (
				!report.effectiveRoots.every(root =>
					selectedRoots.some(selected => sourcePathWithin(selected, root))
				)
			) {
				accepted = {
					...report,
					effectiveRoots: [],
					policyError: 'source-policy-unconfirmed-selection',
				};
			}
		}
		if (modeUnconfirmed)
			accepted = {
				...report,
				effectiveVersion: state?.report.effectiveVersion || 0,
				effectiveRoots: [],
				policyError: 'source-mode-unconfirmed',
			};
		db.insert(agentSourceAccessState)
			.values({
				agentId,
				report: accepted,
				selectedRoots,
				latestReportTimestamp: signedTimestamp,
				receivedAt: now,
			})
			.onConflictDoUpdate({
				target: agentSourceAccessState.agentId,
				set: {
					report: accepted,
					selectedRoots,
					latestReportTimestamp: signedTimestamp,
					receivedAt: now,
				},
			})
			.run();
	}

	async createRequest(input: {
		id: string;
		commandId: string;
		agentId: string;
		deviceId: string;
		kind: 'validate' | 'apply' | 'mode-setup';
		requestedMode?: 'host-approved' | 'server-managed';
		setupExpiresAt?: Date;
		expectedVersion: number;
		expectedHostPolicyRevision: string;
		roots: string[];
		confirmedAffectedPlanIds: string[];
		now: Date;
		freshSince: Date;
	}): Promise<AgentSourceAccessRequest> {
		return this.db.transaction(tx => {
			const identity = tx
				.select({
					revokedAt: agentIdentities.revokedAt,
					lastSeen: agentIdentities.lastSeen,
					capabilities: agentIdentities.capabilities,
				})
				.from(agentIdentities)
				.where(
					and(
						eq(agentIdentities.agentId, input.agentId),
						eq(agentIdentities.deviceId, input.deviceId)
					)
				)
				.get();
			if (
				!identity ||
				identity.revokedAt ||
				!identity.lastSeen ||
				identity.lastSeen < input.freshSince ||
				identity.lastSeen > input.now ||
				identity.capabilities.sourceAccessVersion !== 1
			)
				throw new AppError(409, 'The remote agent must be online and support Source Access.');
			const state = tx
				.select()
				.from(agentSourceAccessState)
				.where(eq(agentSourceAccessState.agentId, input.agentId))
				.get();
			if (!state || state.receivedAt < input.freshSince || state.receivedAt > input.now)
				throw new AppError(409, 'Refresh Source Access before submitting a request.');
			if (
				state.report.effectiveVersion !== input.expectedVersion ||
				state.report.hostPolicyRevision !== input.expectedHostPolicyRevision
			)
				throw new AppError(
					409,
					'Source Access changed. Refresh it and review the selection again.'
				);
			if (input.kind === 'apply' && !sourceReportHealthy(state.report))
				throw new AppError(
					409,
					'Resolve the host source policy error before applying a selection.'
				);
			const open = tx
				.select({ id: agentSourceAccessRequests.id })
				.from(agentSourceAccessRequests)
				.where(
					and(
						eq(agentSourceAccessRequests.agentId, input.agentId),
						inArray(agentSourceAccessRequests.status, [...openRequestStates])
					)
				)
				.get();
			if (open) throw new AppError(409, 'Another Source Access request is still running.');
			if (this.modeFrozen(tx, input.agentId, input.now))
				throw new AppError(
					409,
					'A host authorization mode setup is pending. Wait for host confirmation or its expiry.'
				);
			if (input.kind === 'mode-setup') {
				const allPlans = this.readPlans(tx, input.deviceId);
				if (new Set([...state.report.approvedRoots, ...input.roots]).size > 32)
					throw new AppError(
						400,
						'The combined strict and delegated host scope supports at most 32 roots.'
					);
				if (
					identity.capabilities.sourceAccessModesVersion !== 1 ||
					!input.requestedMode ||
					!input.setupExpiresAt ||
					!sourceReportHealthy(state.report)
				)
					throw new AppError(409, 'Update this agent and refresh its healthy mode report first.');
				if (
					!sameSourceRoots(
						allPlans.map(plan => plan.id),
						input.confirmedAffectedPlanIds
					)
				)
					throw new AppError(
						409,
						'Confirm every backup plan on this agent before changing authorization mode.'
					);
				if (allPlans.some(plan => plan.isActive))
					throw new AppError(
						409,
						'Pause every backup plan on this agent before changing authorization mode.'
					);
				if (this.activeOperations(tx, input.agentId, input.deviceId))
					throw new AppError(
						409,
						'Wait for every queued or running agent operation before changing authorization mode.'
					);
			}
			if (input.kind === 'apply') {
				const affected = this.readPlans(tx, input.deviceId).filter(
					plan =>
						state.selectedRoots.some(root => sourcePathWithin(root, plan.sourcePath)) &&
						!input.roots.some(root => sourcePathWithin(root, plan.sourcePath))
				);
				if (
					!sameSourceRoots(
						affected.map(plan => plan.id),
						input.confirmedAffectedPlanIds
					)
				)
					throw new AppError(
						409,
						'Confirm the exact affected backup plans before removing source access.'
					);
				if (affected.some(plan => plan.isActive))
					throw new AppError(409, 'Pause affected backup plans before removing source access.');
				if (affected.length) {
					const activeBackup = tx
						.select({ id: backups.id })
						.from(backups)
						.where(
							and(
								inArray(
									backups.planId,
									affected.map(plan => plan.id)
								),
								or(
									eq(backups.inProgress, true),
									inArray(backups.status, ['queued', 'running', 'started', 'in_progress'])
								)
							)
						)
						.get();
					if (activeBackup)
						throw new AppError(
							409,
							'Wait for affected queued or running backups to finish before removing source access.'
						);
				}
			}
			const payload = {
				version: 1,
				requestId: input.id,
				expectedVersion: input.expectedVersion,
				expectedHostPolicyRevision: input.expectedHostPolicyRevision,
				roots: input.roots,
				...(input.kind === 'mode-setup'
					? { authorizationMode: input.requestedMode, expiresAt: input.setupExpiresAt!.getTime() }
					: {}),
			};
			tx.insert(agentCommands)
				.values({
					id: input.commandId,
					agentId: input.agentId,
					type:
						input.kind === 'apply'
							? 'SOURCE_ACCESS_APPLY'
							: input.kind === 'mode-setup'
								? 'SOURCE_ACCESS_MODE_SETUP'
								: 'SOURCE_ACCESS_VALIDATE',
					payload,
					idempotencyKey: `source-access:${input.id}`,
				})
				.run();
			return tx
				.insert(agentSourceAccessRequests)
				.values({
					id: input.id,
					commandId: input.commandId,
					agentId: input.agentId,
					kind: input.kind,
					requestedMode: input.requestedMode,
					setupExpiresAt: input.setupExpiresAt,
					status: 'queued',
					expectedVersion: input.expectedVersion,
					expectedHostPolicyRevision: input.expectedHostPolicyRevision,
					roots: input.roots,
					confirmedAffectedPlanIds: input.confirmedAffectedPlanIds,
					createdAt: input.now,
				})
				.returning()
				.get();
		});
	}

	async markDelivered(
		agentId: string,
		commandId: string,
		now: Date,
		freshSince: Date
	): Promise<boolean> {
		return this.db.transaction(tx => {
			const request = tx
				.select()
				.from(agentSourceAccessRequests)
				.where(
					and(
						eq(agentSourceAccessRequests.agentId, agentId),
						eq(agentSourceAccessRequests.commandId, commandId)
					)
				)
				.get();
			const state = tx
				.select()
				.from(agentSourceAccessState)
				.where(eq(agentSourceAccessState.agentId, agentId))
				.get();
			if (!request) return false;
			if (request.kind === 'mode-setup' && request.status === 'applied') {
				tx.update(agentCommands)
					.set({ state: 'completed', completedAt: now })
					.where(eq(agentCommands.id, commandId))
					.run();
				return false;
			}
			if (request.status === 'applied' && state && this.matchesAppliedReport(request, state.report))
				return true;
			let rejection: string | undefined;
			if (
				!state ||
				state.receivedAt < freshSince ||
				state.receivedAt > now ||
				state.report.effectiveVersion !== request.expectedVersion ||
				state.report.hostPolicyRevision !== request.expectedHostPolicyRevision
			)
				rejection = 'source-policy-stale';
			if (!rejection && request.kind === 'mode-setup') {
				const identity = tx
					.select({ deviceId: agentIdentities.deviceId })
					.from(agentIdentities)
					.where(eq(agentIdentities.agentId, agentId))
					.get();
				const allPlans = identity ? this.readPlans(tx, identity.deviceId) : [];
				if (
					!identity ||
					!request.setupExpiresAt ||
					request.setupExpiresAt <= now ||
					allPlans.some(plan => plan.isActive) ||
					!sameSourceRoots(
						allPlans.map(plan => plan.id),
						request.confirmedAffectedPlanIds
					) ||
					this.activeOperations(tx, agentId, identity.deviceId, commandId)
				)
					rejection = 'source-mode-drain-required';
			}
			if (!rejection && request.kind === 'apply' && state) {
				const identity = tx
					.select({ deviceId: agentIdentities.deviceId })
					.from(agentIdentities)
					.where(eq(agentIdentities.agentId, agentId))
					.get();
				const affected = identity
					? this.readPlans(tx, identity.deviceId).filter(
							plan =>
								state.selectedRoots.some(root => sourcePathWithin(root, plan.sourcePath)) &&
								!request.roots.some(root => sourcePathWithin(root, plan.sourcePath))
						)
					: [];
				if (
					!sourceReportHealthy(state.report) ||
					!sameSourceRoots(
						affected.map(plan => plan.id),
						request.confirmedAffectedPlanIds
					) ||
					affected.some(plan => plan.isActive)
				)
					rejection = 'source-removal-conflict';
				if (
					affected.length &&
					tx
						.select({ id: backups.id })
						.from(backups)
						.where(
							and(
								inArray(
									backups.planId,
									affected.map(plan => plan.id)
								),
								or(
									eq(backups.inProgress, true),
									inArray(backups.status, ['queued', 'running', 'started', 'in_progress'])
								)
							)
						)
						.get()
				)
					rejection = 'source-removal-conflict';
			}
			if (rejection) {
				tx.update(agentSourceAccessRequests)
					.set({ status: 'rejected', completedAt: now, resultCode: rejection })
					.where(eq(agentSourceAccessRequests.id, request.id))
					.run();
				tx.update(agentCommands)
					.set({ state: 'failed', completedAt: now, lastError: rejection })
					.where(eq(agentCommands.id, commandId))
					.run();
				return false;
			}
			tx.update(agentSourceAccessRequests)
				.set({ status: 'validating' })
				.where(
					and(
						eq(agentSourceAccessRequests.id, request.id),
						eq(agentSourceAccessRequests.status, 'queued')
					)
				)
				.run();
			return true;
		});
	}

	/** The lease, command type, request inputs, outcome and report are checked and committed together. */
	async complete(input: {
		agentId: string;
		commandId: string;
		leaseToken: string;
		sequence: number;
		success: boolean;
		result?: SourceAccessCommandResult;
		signedTimestamp: number;
		now: Date;
	}): Promise<boolean> {
		return this.db.transaction(tx => {
			const command = tx
				.select()
				.from(agentCommands)
				.where(and(eq(agentCommands.id, input.commandId), eq(agentCommands.agentId, input.agentId)))
				.get();
			const request = tx
				.select()
				.from(agentSourceAccessRequests)
				.where(
					and(
						eq(agentSourceAccessRequests.commandId, input.commandId),
						eq(agentSourceAccessRequests.agentId, input.agentId)
					)
				)
				.get();
			if (
				!command ||
				!request ||
				command.leaseOwner !== input.leaseToken ||
				command.type !==
					(request.kind === 'apply'
						? 'SOURCE_ACCESS_APPLY'
						: request.kind === 'mode-setup'
							? 'SOURCE_ACCESS_MODE_SETUP'
							: 'SOURCE_ACCESS_VALIDATE')
			)
				return false;
			// A retry can acknowledge an existing terminal outcome, never replace its report or validation.
			if (['completed', 'failed', 'cancelled'].includes(command.state)) return true;
			if (request.kind === 'mode-setup' && request.status === 'applied') {
				tx.update(agentCommands)
					.set({ state: 'completed', completedAt: input.now })
					.where(eq(agentCommands.id, command.id))
					.run();
				return true;
			}
			if (
				!liveCommandStates.includes(command.state as (typeof liveCommandStates)[number]) ||
				!command.leaseExpiresAt ||
				command.leaseExpiresAt <= input.now ||
				input.sequence <= command.lastEventSequence
			)
				return false;
			const payload = command.payload;
			if (
				payload.requestId !== request.id ||
				payload.expectedVersion !== request.expectedVersion ||
				payload.expectedHostPolicyRevision !== request.expectedHostPolicyRevision ||
				!Array.isArray(payload.roots) ||
				!sameSourceRoots(payload.roots as string[], request.roots)
			)
				return false;
			const validation = input.result?.validation;
			if (
				validation &&
				(new Set(validation.map(item => item.requestedPath)).size !== validation.length ||
					validation.some(item => !request.roots.includes(item.requestedPath)))
			)
				return false;
			if (
				request.kind === 'validate' &&
				input.success &&
				(!validation || validation.length !== request.roots.length)
			)
				return false;
			let status: SourceAccessRequestStatus = 'rejected';
			let resultCode = 'source-access-rejected';
			const report = input.result?.sourceAccess;
			if (request.kind === 'mode-setup' && input.success && input.result?.modeSetup && report) {
				const setup = input.result.modeSetup;
				if (
					setup.requestId === request.id &&
					setup.authorizationMode === request.requestedMode &&
					setup.expiresAt === request.setupExpiresAt?.getTime() &&
					sameSourceRoots(setup.delegatedRoots, request.roots) &&
					report.hostPolicyRevision === request.expectedHostPolicyRevision &&
					report.effectiveVersion === request.expectedVersion &&
					setup.expiresAt > input.now.getTime()
				) {
					status = 'pending-host-setup';
					resultCode = 'source-mode-host-setup-required';
				}
			} else if (
				request.kind === 'apply' &&
				input.success &&
				report &&
				this.matchesAppliedReport(request, report)
			) {
				status = 'applied';
				resultCode = 'source-selection-applied';
			} else if (validation?.some(item => item.status === 'pending-host-approval')) {
				status = 'pending-host-approval';
				resultCode = 'source-host-approval-required';
			} else if (
				request.kind === 'validate' &&
				input.success &&
				report &&
				report.effectiveVersion === request.expectedVersion &&
				report.hostPolicyRevision === request.expectedHostPolicyRevision &&
				!report.policyError &&
				!validation?.some(item => item.status === 'rejected')
			) {
				status = 'validated';
				resultCode = 'source-validation-complete';
			}
			// Correlated APPLY is the only network callback permitted to change the confirmed selection.
			if (report)
				this.writeReport(
					tx,
					input.agentId,
					report,
					input.signedTimestamp,
					input.now,
					request.kind === 'apply' && input.success
				);
			tx.update(agentSourceAccessRequests)
				.set({ status, validation: validation || null, resultCode, completedAt: input.now })
				.where(eq(agentSourceAccessRequests.id, request.id))
				.run();
			const succeeded =
				status === 'applied' || status === 'validated' || status === 'pending-host-setup';
			tx.update(agentCommands)
				.set({
					state: succeeded ? 'completed' : 'failed',
					completedAt: input.now,
					lastEventSequence: input.sequence,
					lastError: succeeded ? null : resultCode,
				})
				.where(eq(agentCommands.id, command.id))
				.run();
			return true;
		});
	}

	private matchesAppliedReport(
		request: AgentSourceAccessRequest,
		report: SourceAccessReport
	): boolean {
		return (
			request.kind === 'apply' &&
			report.lastAppliedRequestId === request.id &&
			report.effectiveVersion === request.expectedVersion + 1 &&
			report.hostPolicyRevision === request.expectedHostPolicyRevision &&
			sameSourceRoots(request.roots, report.effectiveRoots) &&
			sameSourceRoots(
				request.roots,
				report.rootStatuses.map(root => root.path)
			) &&
			sourceReportHealthy(report)
		);
	}

	async cancel(agentId: string, requestId: string, now: Date): Promise<boolean> {
		return this.db.transaction(tx => {
			const request = tx
				.select()
				.from(agentSourceAccessRequests)
				.where(
					and(
						eq(agentSourceAccessRequests.id, requestId),
						eq(agentSourceAccessRequests.agentId, agentId)
					)
				)
				.get();
			if (!request || !['queued', 'pending-host-approval'].includes(request.status)) return false;
			const command = tx
				.select()
				.from(agentCommands)
				.where(eq(agentCommands.id, request.commandId))
				.get();
			if (!command || !['queued', 'failed'].includes(command.state)) return false;
			tx.update(agentCommands)
				.set({ state: 'cancelled', completedAt: now, lastError: 'source-request-cancelled' })
				.where(eq(agentCommands.id, request.commandId))
				.run();
			tx.update(agentSourceAccessRequests)
				.set({ status: 'cancelled', completedAt: now, resultCode: 'source-request-cancelled' })
				.where(eq(agentSourceAccessRequests.id, requestId))
				.run();
			return true;
		});
	}
}

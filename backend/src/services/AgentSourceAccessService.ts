import crypto from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { AgentIdentity } from '../db/schema/agents';
import type { AgentSourceAccessState } from '../db/schema/agentSourceAccess';
import { AgentStore } from '../stores/AgentStore';
import { AgentSourceAccessStore } from '../stores/AgentSourceAccessStore';
import type { SourceAccessReport, SourceAccessView } from '../types/agentSourceAccess';
import { AppError, NotFoundError } from '../utils/AppError';
import {
	hasOverlappingSourceRoots,
	isCanonicalSourcePath,
	isNewSourceRootAllowed,
	sourceAccessRequestSchema,
	sourceAccessResultSchema,
	sourceAccessModeSetupSchema,
	sourcePathWithin,
	sourceReportHealthy,
	sourcePathContainsPrivateDirectory,
} from '../utils/agentSourceAccess';
import { configService } from './ConfigService';
import { serverLogger } from '../utils/logger';
import { sameSourceRoots } from '../utils/agentSourceAccess';
import {
	parseSourceHistoryQuery,
	publicSourceAccessRequest,
	sourceHistoryCursor,
} from '../utils/sourceAccessHistory';

const completionSchema = z
	.object({
		leaseToken: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
		sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		success: z.boolean(),
		error: z.string().min(1).max(500).optional(),
		result: sourceAccessResultSchema.optional(),
		cancelled: z.boolean().optional(),
	})
	.strict();

/** Administrative selection within a host-controlled maximum, never a host permission or shell transport. */
export class AgentSourceAccessService {
	constructor(
		private readonly store: AgentSourceAccessStore,
		private readonly agentStore: AgentStore,
		private readonly now: () => Date = () => new Date()
	) {}

	private freshnessMs(): number {
		return (configService.config.AGENT_OFFLINE_TIMEOUT_SECONDS || 90) * 1000;
	}
	private online(agent: AgentIdentity): boolean {
		const age = agent.lastSeen ? this.now().getTime() - agent.lastSeen.getTime() : -1;
		return !agent.revokedAt && age >= 0 && age <= this.freshnessMs();
	}

	private async identity(deviceId: string): Promise<AgentIdentity> {
		const agent = deviceId === 'main' ? null : await this.agentStore.getAgentByDeviceId(deviceId);
		if (!agent) throw new NotFoundError('Remote machine was not found.');
		return agent;
	}

	async getRequestHistory(deviceId: string, input: unknown) {
		const agent = await this.identity(deviceId);
		const options = parseSourceHistoryQuery(input);
		const page = await this.store.requestHistory(agent.agentId, options);
		const last = page.requests[page.requests.length - 1];
		return {
			requests: page.requests.map(publicSourceAccessRequest),
			total: page.total,
			pageSize: options.limit,
			cursor: sourceHistoryCursor({
				version: 1,
				ceiling: page.ceiling,
				...(options.cursor?.before ? { before: options.cursor.before } : {}),
			}),
			...(page.hasMore && last
				? {
						nextCursor: sourceHistoryCursor({
							version: 1,
							ceiling: page.ceiling,
							before: { time: last.createdAt.getTime(), id: last.id },
						}),
					}
				: {}),
		};
	}

	async getView(deviceId: string): Promise<SourceAccessView> {
		const agent = await this.identity(deviceId);
		const supported = agent.capabilities.sourceAccessVersion === 1;
		const online = this.online(agent);
		if (!supported)
			return { supported, online, reportFresh: false, requests: [], affectedPlans: [] };
		await this.reconcile(agent.agentId);
		const [state, requests, plans, modeState] = await Promise.all([
			this.store.getState(agent.agentId),
			this.store.listRequests(agent.agentId),
			this.store.getPlans(deviceId),
			this.store.getModeChangeState(agent.agentId, deviceId, this.now()),
		]);
		return {
			supported,
			modeSetupSupported: agent.capabilities.sourceAccessModesVersion === 1,
			modeChangePlans: modeState.plans,
			modeChangeBlocked: modeState.blocked,
			activeOperationCount: modeState.activeOperationCount,
			online,
			reportFresh:
				online &&
				!!state &&
				state.receivedAt <= this.now() &&
				this.now().getTime() - state.receivedAt.getTime() <= this.freshnessMs(),
			...(state ? { report: { ...state.report, receivedAt: state.receivedAt } } : {}),
			requests: requests.map(publicSourceAccessRequest),
			affectedPlans: state
				? plans.filter(plan =>
						state.selectedRoots.some(root => sourcePathWithin(root, plan.sourcePath))
					)
				: [],
		};
	}

	async request(
		deviceId: string,
		kind: 'validate' | 'apply',
		input: unknown
	): Promise<{ requestId: string; status: 'queued' }> {
		const agent = await this.identity(deviceId);
		this.assertAvailable(agent);
		await this.reconcile(agent.agentId);
		const parsed = sourceAccessRequestSchema.safeParse(input);
		if (!parsed.success || (kind === 'validate' && !parsed.data.roots.length))
			throw new AppError(
				400,
				'Source Access requires at most 32 safe absolute Linux paths of up to 1024 characters, without duplicates or traversal.'
			);
		const state = await this.store.getState(agent.agentId);
		for (const root of parsed.data.roots) {
			const canonical = path.posix.normalize(root).replace(/\/+$/, '') || '/';
			if (
				!isNewSourceRootAllowed(canonical) &&
				!state?.report.approvedRoots.includes(root) &&
				!state?.selectedRoots.includes(root)
			)
				throw new AppError(
					400,
					'A new source root must be a specific application directory outside protected agent and system locations.'
				);
		}
		if (
			kind === 'apply' &&
			(parsed.data.roots.some(root => !isCanonicalSourcePath(root)) ||
				hasOverlappingSourceRoots(parsed.data.roots))
		)
			throw new AppError(
				400,
				'Apply only canonical source paths without duplicate or overlapping roots. Validate the paths first.'
			);
		const requestId = `source-${crypto.randomUUID()}`;
		await this.store.createRequest({
			...parsed.data,
			id: requestId,
			commandId: `source-command-${crypto.randomUUID()}`,
			agentId: agent.agentId,
			deviceId,
			kind,
			confirmedAffectedPlanIds: parsed.data.confirmedAffectedPlanIds || [],
			now: this.now(),
			freshSince: new Date(this.now().getTime() - this.freshnessMs()),
		});
		this.audit('source_access_request_queued', {
			requestId,
			kind,
			rootCount: parsed.data.roots.length,
		});
		return { requestId, status: 'queued' };
	}

	async refresh(deviceId: string): Promise<{ requestId: string; status: 'queued' }> {
		const agent = await this.identity(deviceId);
		this.assertAvailable(agent);
		const commandId = `source-refresh-${crypto.randomUUID()}`;
		await this.agentStore.enqueueCommand({
			id: commandId,
			agentId: agent.agentId,
			type: 'INVENTORY_REFRESH',
			payload: {},
			idempotencyKey: commandId,
		});
		this.audit('source_access_refresh_queued', { commandId });
		return { requestId: commandId, status: 'queued' };
	}

	async setupMode(
		deviceId: string,
		input: unknown
	): Promise<{ requestId: string; status: 'queued' }> {
		const agent = await this.identity(deviceId);
		this.assertAvailable(agent);
		await this.reconcile(agent.agentId);
		const parsed = sourceAccessModeSetupSchema.safeParse(input);
		if (
			!parsed.success ||
			parsed.data.roots.some(
				root =>
					!isNewSourceRootAllowed(root) ||
					root.split('/').some(part => ['.ssh', '.aws', '.gnupg', '.kube'].includes(part))
			) ||
			hasOverlappingSourceRoots(parsed.data.roots)
		)
			throw new AppError(
				400,
				'Choose specific, canonical delegated application directories outside private credential and system locations.'
			);
		const requestId = `source-mode-${crypto.randomUUID()}`;
		await this.store.createRequest({
			...parsed.data,
			id: requestId,
			commandId: `source-mode-command-${crypto.randomUUID()}`,
			agentId: agent.agentId,
			deviceId,
			kind: 'mode-setup',
			requestedMode: parsed.data.authorizationMode,
			setupExpiresAt: new Date(this.now().getTime() + 15 * 60_000),
			now: this.now(),
			freshSince: new Date(this.now().getTime() - this.freshnessMs()),
		});
		this.audit('source_access_mode_setup_queued', {
			requestId,
			mode: parsed.data.authorizationMode,
			delegatedCount: parsed.data.roots.length,
		});
		return { requestId, status: 'queued' };
	}

	async cancel(deviceId: string, requestId: string): Promise<void> {
		const agent = await this.identity(deviceId);
		if (!(await this.store.cancel(agent.agentId, requestId, this.now())))
			throw new AppError(409, 'Only queued or pending host approval requests can be cancelled.');
		this.audit('source_access_request_cancelled', { requestId });
	}

	private assertAvailable(agent: AgentIdentity): void {
		if (agent.capabilities.sourceAccessVersion !== 1)
			throw new AppError(
				409,
				'Update this agent to manage Source Access. Existing host configuration remains in use.'
			);
		if (!this.online(agent))
			throw new AppError(409, 'The remote agent must be online to manage Source Access.');
	}

	async recordHeartbeat(
		agentId: string,
		report: SourceAccessReport,
		signedTimestamp: number
	): Promise<void> {
		if (!Number.isSafeInteger(signedTimestamp))
			throw new AppError(400, 'Source Access report timestamp is invalid.');
		const previous = await this.store.getState(agentId);
		await this.store.recordHeartbeat(agentId, report, signedTimestamp, this.now());
		const current = await this.store.getState(agentId);
		this.auditHostMaximum(previous, current, signedTimestamp);
	}

	private auditHostMaximum(
		previous: AgentSourceAccessState | null,
		current: AgentSourceAccessState | null,
		signedTimestamp: number
	): void {
		if (
			current?.latestReportTimestamp === signedTimestamp &&
			((previous?.report.authorizationMode || 'host-approved') !==
				(current.report.authorizationMode || 'host-approved') ||
				!sameSourceRoots(
					previous?.report.delegatedRoots || [],
					current.report.delegatedRoots || []
				))
		) {
			this.audit('source_access_host_authorization_changed', {
				mode: current.report.authorizationMode || 'host-approved',
				delegatedCount: current.report.delegatedRoots?.length || 0,
				delegatedSetHash: crypto
					.createHash('sha256')
					.update(JSON.stringify([...(current.report.delegatedRoots || [])].sort()))
					.digest('hex'),
			});
		}
		if (
			current?.latestReportTimestamp === signedTimestamp &&
			(!previous ||
				previous.report.hostPolicyRevision !== current.report.hostPolicyRevision ||
				!sameSourceRoots(previous.report.approvedRoots, current.report.approvedRoots))
		) {
			const oldRoots = previous?.report.approvedRoots || [];
			this.audit('source_access_host_maximum_changed', {
				hostPolicyRevision: current.report.hostPolicyRevision,
				approvedSetHash: crypto
					.createHash('sha256')
					.update(JSON.stringify([...current.report.approvedRoots].sort()))
					.digest('hex'),
				approvedCount: current.report.approvedRoots.length,
				addedCount: current.report.approvedRoots.filter(root => !oldRoots.includes(root)).length,
				removedCount: oldRoots.filter(root => !current.report.approvedRoots.includes(root)).length,
			});
		}
	}

	async markDelivered(agentId: string, commandId: string): Promise<boolean> {
		const delivered = await this.store.markDelivered(
			agentId,
			commandId,
			this.now(),
			new Date(this.now().getTime() - this.freshnessMs())
		);
		if (!delivered) {
			const request = await this.store.getRequestForCommand(agentId, commandId);
			if (request?.status === 'rejected')
				this.audit('source_access_request_rejected', { requestId: request.id });
		}
		return delivered;
	}

	async complete(
		agentId: string,
		commandId: string,
		input: unknown,
		signedTimestamp: number
	): Promise<void> {
		const parsed = completionSchema.safeParse(input);
		if (
			!parsed.success ||
			(parsed.data.success && !parsed.data.result) ||
			!Number.isSafeInteger(signedTimestamp)
		)
			throw new AppError(400, 'Source Access command completion is invalid.');
		const previous = await this.store.getRequestForCommand(agentId, commandId);
		const previousState = await this.store.getState(agentId);
		const completed = await this.store.complete({
			...parsed.data,
			agentId,
			commandId,
			signedTimestamp,
			now: this.now(),
		});
		if (!completed)
			throw new NotFoundError('Source Access command not found or its lease is no longer valid.');
		const current = await this.store.getRequestForCommand(agentId, commandId);
		this.auditHostMaximum(previousState, await this.store.getState(agentId), signedTimestamp);
		if (current && current.status !== previous?.status)
			this.audit(`source_access_request_${current.status.replace(/-/g, '_')}`, {
				requestId: current.id,
			});
	}

	/** Used at plan creation, changes, queueing and credential materialization. Old agents preserve their existing policy. */
	async assertPlanSource(agent: AgentIdentity, source: string): Promise<void> {
		if (await this.store.getOpenModeSetup(agent.agentId, this.now()))
			throw new AppError(
				409,
				'Host authorization mode setup is pending. Backup work stays paused until host confirmation or receipt expiry.'
			);
		if (agent.capabilities.sourceAccessVersion !== 1) return;
		const state = await this.store.getState(agent.agentId);
		if (
			state?.report.authorizationMode === 'server-managed' &&
			sourcePathContainsPrivateDirectory(source)
		)
			throw new AppError(
				400,
				'Private credential directories cannot be backup sources in Server-Managed mode.'
			);
		if (
			!this.online(agent) ||
			!state ||
			state.receivedAt > this.now() ||
			this.now().getTime() - state.receivedAt.getTime() > this.freshnessMs() ||
			!sourceReportHealthy(state.report)
		)
			throw new AppError(409, 'Source Access needs a fresh healthy report from the remote agent.');
		if (
			!isCanonicalSourcePath(source) ||
			!state.report.effectiveRoots.some(root => sourcePathWithin(root, source))
		)
			throw new AppError(
				400,
				'The backup source must be a canonical path within an enabled, effective source root. Validate and enable the source in Source Access first.'
			);
		const pending = await this.store.getOpenApply(agent.agentId);
		if (pending && !pending.roots.some(root => sourcePathWithin(root, source)))
			throw new AppError(
				409,
				'A Source Access request is removing this source. Wait for it to finish or cancel the queued request.'
			);
	}

	async assertModeChangeIdle(agentId: string): Promise<void> {
		if (await this.store.getOpenModeSetup(agentId, this.now()))
			throw new AppError(
				409,
				'Keep this agent backup plans paused until host authorization mode setup is confirmed or expires.'
			);
	}

	private async reconcile(agentId: string): Promise<void> {
		const changes = await this.store.reconcileTerminalRequests(agentId, this.now());
		for (const change of changes)
			this.audit(
				change.code === 'source-outcome-unconfirmed'
					? 'source_access_outcome_unconfirmed'
					: `source_access_request_${change.status}`,
				{ requestId: change.id }
			);
	}

	private audit(event: string, fields: Record<string, string | number>): void {
		// The durable request table holds inputs; ordinary server-log retention
		// applies to this supplementary audit of host maximum changes.
		if (serverLogger)
			serverLogger.info({ agentEvent: event, ...fields }, 'Agent Source Access event');
	}
}

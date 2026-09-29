import crypto from 'crypto';
import Cryptr from 'cryptr';
import { z } from 'zod';
import { type AgentCommand, type AgentIdentity } from '../db/schema/agents';
import { AgentStore } from '../stores/AgentStore';
import {
	AGENT_COMMAND_LEASE_MS,
	AGENT_COMMAND_TYPES,
	AGENT_REQUEST_SKEW_MS,
	type AgentInventory,
	type AuthenticatedAgent,
} from '../types/agents';
import { AppError, NotFoundError } from '../utils/AppError';
import { generateUID } from '../utils/helpers';
import { signAgentCommand, signAgentRequest, verifyAgentSignature } from '../utils/agentProtocol';
import { configService } from './ConfigService';
import { serverLogger } from '../utils/logger';

const inventorySchema = z
	.object({
		hostname: z.string().trim().min(1).max(255),
		os: z.string().trim().min(1).max(255),
		architecture: z.string().trim().min(1).max(128),
		agentVersion: z.string().trim().min(1).max(128),
		resticVersion: z.string().trim().min(1).max(128).optional(),
		rcloneVersion: z.string().trim().min(1).max(128).optional(),
		uptimeSeconds: z.number().int().nonnegative().max(365 * 24 * 60 * 60).optional(),
		capabilities: z
			.object({
				filesystemRootsConfigured: z.boolean(),
				commandTypes: z.array(z.enum(['PING', 'INVENTORY_REFRESH'])).min(1).max(2),
			})
			.strict(),
	})
	.strict();

const enrollmentSchema = z
	.object({
		token: z.string().min(32).max(512),
		inventory: inventorySchema,
	})
	.strict();

const enrollmentNameSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();

export type AgentPublic = {
	agentId: string;
	deviceId: string;
	status: 'online' | 'offline' | 'revoked';
	hostname: string;
	os: string;
	architecture: string;
	agentVersion: string;
	resticVersion: string | null;
	rcloneVersion: string | null;
	capabilities: Record<string, unknown>;
	lastSeen: Date | null;
	createdAt: Date;
};

/**
 * Service for the deliberately small, outbound-only Phase 4 agent control
 * plane. It does not run Restic, Rclone, shell commands, restores, or scripts.
 */
export class AgentService {
	constructor(
		private readonly agentStore: AgentStore,
		private readonly encryptionSecret = configService.config.SECRET,
		private readonly now: () => Date = () => new Date()
	) {}

	async createEnrollment(input: unknown): Promise<{
		id: string;
		token: string;
		expiresAt: Date;
		deviceName: string;
	}> {
		const parsed = enrollmentNameSchema.safeParse(input);
		if (!parsed.success) throw new AppError(400, 'A remote machine name is required.');

		const token = crypto.randomBytes(32).toString('base64url');
		const expiresAt = new Date(this.now().getTime() + 15 * 60 * 1000);
		const created = await this.agentStore.createEnrollment({
			id: generateUID(24),
			tokenHash: this.hashToken(token),
			deviceName: parsed.data.name,
			expiresAt,
		});
		if (!created) throw new AppError(500, 'Could not create an enrollment token.');
		this.audit('enrollment_token_created');
		return { id: created.id, token, expiresAt, deviceName: created.deviceName };
	}

	async revokeEnrollment(id: string): Promise<void> {
		const revoked = await this.agentStore.revokeEnrollment(id);
		if (!revoked) throw new NotFoundError('Enrollment token was not found or is already used.');
		this.audit('enrollment_token_revoked');
	}

	async enroll(input: unknown): Promise<{
		deviceId: string;
		agentId: string;
		secret: string;
		pollIntervalSeconds: number;
	}> {
		const parsed = enrollmentSchema.safeParse(input);
		if (!parsed.success) throw new AppError(400, 'Enrollment request is invalid.');

		const deviceId = `remote-${generateUID(20)}`;
		const agentId = `agent-${crypto.randomBytes(18).toString('base64url')}`;
		const secret = crypto.randomBytes(32).toString('base64url');
		const encryptedSecret = new Cryptr(this.encryptionSecret).encrypt(secret);

		let enrollment;
		try {
			enrollment = await this.agentStore.enrollAgent({
				tokenHash: this.hashToken(parsed.data.token),
				now: this.now(),
				device: {
					id: deviceId,
					agentId,
					inventory: parsed.data.inventory,
				},
				identity: {
					agentId,
					deviceId,
					encryptedSecret,
					inventory: parsed.data.inventory,
				},
				command: {
					id: generateUID(24),
					agentId,
					type: 'INVENTORY_REFRESH',
					payload: {},
					idempotencyKey: crypto.randomUUID(),
				},
			});
		} catch {
			// The transaction rolls back its token claim, identity, and device together.
			this.audit('enrollment_failed');
			throw new AppError(500, 'Enrollment could not be completed. Create a new enrollment token.');
		}
		if (!enrollment) {
			this.audit('enrollment_rejected');
			throw new AppError(401, 'Enrollment token is invalid, expired, revoked, or already used.');
		}

		this.audit('agent_enrolled');
		return { deviceId, agentId, secret, pollIntervalSeconds: 15 };
	}

	async authenticate(input: {
		agentId?: string;
		timestamp?: string;
		nonce?: string;
		signature?: string;
		method: string;
		path: string;
		body: string;
	}): Promise<AuthenticatedAgent> {
		if (!input.agentId || !input.timestamp || !input.nonce || !input.signature) {
			return this.authenticationFailure();
		}
		if (!/^[A-Za-z0-9_-]{22,128}$/.test(input.nonce)) {
			return this.authenticationFailure();
		}
		const timestamp = Number(input.timestamp);
		if (!Number.isSafeInteger(timestamp) || Math.abs(this.now().getTime() - timestamp) > AGENT_REQUEST_SKEW_MS) {
			return this.authenticationFailure();
		}

		const identity = await this.agentStore.getAgentById(input.agentId);
		if (!identity || identity.revokedAt) {
			return this.authenticationFailure();
		}
		let secret: string;
		try {
			secret = new Cryptr(this.encryptionSecret).decrypt(identity.encryptedSecret);
		} catch {
			return this.authenticationFailure();
		}
		const expected = signAgentRequest(secret, input.timestamp, input.nonce, input.method, input.path, input.body);
		if (!verifyAgentSignature(expected, input.signature)) {
			return this.authenticationFailure();
		}
		const nonceHash = crypto.createHash('sha256').update(input.nonce).digest('base64url');
		const reserved = await this.agentStore.reserveNonce(
			identity.agentId,
			nonceHash,
			new Date(timestamp + AGENT_REQUEST_SKEW_MS)
		);
		if (!reserved) {
			this.audit('replay_rejected');
			return this.authenticationFailure(false);
		}
		return { agentId: identity.agentId, deviceId: identity.deviceId, secret };
	}

	assertTransportIsAllowed(isSecure: boolean): void {
		if (!isSecure && configService.config.ALLOW_INSECURE_AGENT_HTTP !== true) {
			throw new AppError(403, 'Agent HTTPS is required by this server.');
		}
	}

	async heartbeat(agentId: string, input: unknown): Promise<AgentPublic> {
		const inventory = this.parseInventory(input);
		const updated = await this.agentStore.updateHeartbeat(agentId, inventory);
		if (!updated) throw new AppError(401, 'Agent authentication failed.');
		return this.toPublic(updated);
	}

	async poll(agent: AuthenticatedAgent): Promise<{
		command: (Pick<AgentCommand, 'id' | 'type' | 'payload' | 'idempotencyKey' | 'leaseExpiresAt'> & {
			leaseToken: string;
			signature: string;
			signatureTimestamp: string;
		}) | null;
	}> {
		const leaseToken = crypto.randomBytes(24).toString('base64url');
		const command = await this.agentStore.leaseNext(agent.agentId, leaseToken, AGENT_COMMAND_LEASE_MS, this.now());
		if (!command) return { command: null };
		const signatureTimestamp = this.now().getTime().toString();
		this.audit('command_leased');
		return {
			command: {
				id: command.id,
				type: command.type,
				payload: command.payload,
				idempotencyKey: command.idempotencyKey,
				leaseExpiresAt: command.leaseExpiresAt,
				leaseToken,
				signatureTimestamp,
				signature: signAgentCommand(agent.secret, signatureTimestamp, command, leaseToken),
			},
		};
	}

	async acknowledge(agentId: string, commandId: string, input: unknown): Promise<void> {
		const parsed = this.parseLeaseToken(input);
		const command = await this.agentStore.acknowledgeCommand(agentId, commandId, parsed.leaseToken, this.now());
		if (!command) throw new NotFoundError('Command not found.');
	}

	async recordEvent(agentId: string, commandId: string, input: unknown): Promise<void> {
		const parsed = z
			.object({
				sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
				leaseToken: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
			})
			.strict()
			.safeParse(input);
		if (!parsed.success) throw new AppError(400, 'Command event is invalid.');
		const command = await this.agentStore.recordCommandEvent(
			agentId,
			commandId,
			parsed.data.leaseToken,
			parsed.data.sequence,
			this.now()
		);
		if (!command) throw new NotFoundError('Command not found.');
	}

	async complete(agentId: string, commandId: string, input: unknown): Promise<void> {
		const parsed = z
			.object({
				sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
				leaseToken: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
				success: z.boolean(),
				error: z.string().trim().min(1).max(500).optional(),
			})
			.strict()
			.safeParse(input);
		if (!parsed.success || (!parsed.data.success && !parsed.data.error)) {
			throw new AppError(400, 'Command completion is invalid.');
		}
		const command = await this.agentStore.completeCommand(
			agentId,
			commandId,
			parsed.data.leaseToken,
			parsed.data.sequence,
			parsed.data.success,
			parsed.data.error,
			this.now()
		);
		if (!command) throw new NotFoundError('Command not found.');
		this.audit(command.state === 'completed' ? 'command_completed' : 'command_failed');
	}

	async revokeDevice(deviceId: string): Promise<void> {
		const revoked = await this.agentStore.revokeAgentByDeviceId(deviceId);
		if (!revoked) throw new NotFoundError('Remote machine was not found or is already revoked.');
		this.audit('agent_revoked');
	}

	async getPublicAgent(deviceId: string): Promise<AgentPublic | null> {
		const identity = await this.agentStore.getAgentByDeviceId(deviceId);
		return identity ? this.toPublic(identity) : null;
	}

	private parseInventory(input: unknown): AgentInventory {
		const parsed = inventorySchema.safeParse(input);
		if (!parsed.success) throw new AppError(400, 'Agent inventory is invalid.');
		return parsed.data;
	}

	private toPublic(identity: AgentIdentity): AgentPublic {
		const timeout = (configService.config.AGENT_OFFLINE_TIMEOUT_SECONDS || 90) * 1000;
		const status = identity.revokedAt
			? 'revoked'
			: identity.lastSeen && this.now().getTime() - identity.lastSeen.getTime() <= timeout
				? 'online'
				: 'offline';
		return {
			agentId: identity.agentId,
			deviceId: identity.deviceId,
			status,
			hostname: identity.hostname,
			os: identity.os,
			architecture: identity.architecture,
			agentVersion: identity.agentVersion,
			resticVersion: identity.resticVersion,
			rcloneVersion: identity.rcloneVersion,
			capabilities: identity.capabilities,
			lastSeen: identity.lastSeen,
			createdAt: identity.createdAt,
		};
	}

	private hashToken(token: string): string {
		return crypto.createHash('sha256').update(token).digest('base64url');
	}

	private parseLeaseToken(input: unknown): { leaseToken: string } {
		const parsed = z.object({ leaseToken: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/) }).strict().safeParse(input);
		if (!parsed.success) throw new AppError(400, 'Command acknowledgement is invalid.');
		return parsed.data;
	}

	private authenticationFailure(audit = true): never {
		if (audit) this.audit('authentication_rejected');
		throw new AppError(401, 'Agent authentication failed.');
	}

	private audit(event: string): void {
		// Logger initialization is part of createApp; unit tests deliberately use
		// the service without process-wide logging.
		if (serverLogger) {
			serverLogger.info({ agentEvent: event }, 'Agent control-plane event');
		}
	}
}

export { inventorySchema, AGENT_COMMAND_TYPES };

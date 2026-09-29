import crypto from 'node:crypto';
import { AgentTransport } from './transport.js';
import { signRequest, verifyCommand } from './protocol.js';
import type { AgentCommandEnvelope, AgentConfig, AgentInventory, StoredAgentIdentity } from './types.js';

type ApiResponse<T> = { success: boolean; result: T; error?: string };

export class AgentClient {
	private readonly transport: AgentTransport;

	constructor(
		private readonly config: AgentConfig,
		private readonly identity?: StoredAgentIdentity
	) {
		this.transport = new AgentTransport(config);
	}

	async enroll(token: string, inventory: AgentInventory): Promise<{
		deviceId: string;
		agentId: string;
		secret: string;
		pollIntervalSeconds: number;
	}> {
		return this.postUnsigned('/api/agent/enroll', { token, inventory });
	}

	async heartbeat(inventory: AgentInventory): Promise<void> {
		await this.postSigned('/api/agent/heartbeat', inventory);
	}

	async poll(): Promise<AgentCommandEnvelope | null> {
		const result = await this.postSigned<{ command: AgentCommandEnvelope | null }>('/api/agent/poll', {});
		if (!result.command) return null;
		if (!this.identity || !verifyCommand(this.identity.secret, result.command)) {
			throw new Error('Server command signature is invalid.');
		}
		return result.command;
	}

	async acknowledge(commandId: string, leaseToken: string): Promise<void> {
		await this.postSigned(`/api/agent/commands/${encodeURIComponent(commandId)}/ack`, { leaseToken });
	}

	async event(commandId: string, leaseToken: string, sequence: number): Promise<void> {
		await this.postSigned(`/api/agent/commands/${encodeURIComponent(commandId)}/events`, { leaseToken, sequence });
	}

	async complete(
		commandId: string,
		leaseToken: string,
		completion: { sequence: number; success: boolean; error?: string }
	): Promise<void> {
		await this.postSigned(`/api/agent/commands/${encodeURIComponent(commandId)}/complete`, { leaseToken, ...completion });
	}

	private async postUnsigned<T>(pathname: string, body: Record<string, unknown>): Promise<T> {
		const raw = JSON.stringify(body);
		const response = await this.transport.post<ApiResponse<T>>(pathname, raw);
		if (!response.success) throw new Error(response.error || 'Server rejected the agent request.');
		return response.result;
	}

	private async postSigned<T>(pathname: string, body: Record<string, unknown>): Promise<T> {
		if (!this.identity) throw new Error('Agent identity is required. Enroll this agent first.');
		const raw = JSON.stringify(body);
		const timestamp = Date.now().toString();
		const nonce = crypto.randomBytes(24).toString('base64url');
		const signature = signRequest(this.identity.secret, timestamp, nonce, 'POST', pathname, raw);
		const response = await this.transport.post<ApiResponse<T>>(pathname, raw, {
			'x-pluton-agent-id': this.identity.agentId,
			'x-pluton-agent-timestamp': timestamp,
			'x-pluton-agent-nonce': nonce,
			'x-pluton-agent-signature': signature,
		});
		if (!response.success) throw new Error(response.error || 'Server rejected the agent request.');
		return response.result;
	}
}

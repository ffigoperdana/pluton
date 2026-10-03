import crypto from 'crypto';
import Cryptr from 'cryptr';
import { AgentService } from '../../src/services/AgentService';
import { AgentStore } from '../../src/stores/AgentStore';
import { signAgentRequest } from '../../src/utils/agentProtocol';
import { configService } from '../../src/services/ConfigService';

jest.mock('../../src/services/ConfigService', () => ({
	configService: {
		config: {
			SECRET: 'agent-service-test-secret-that-is-long-enough',
			APP_URL: 'https://pluton.example.internal',
			ALLOW_INSECURE_AGENT_HTTP: false,
			AGENT_OFFLINE_TIMEOUT_SECONDS: 90,
		},
	},
}));

const secret = 'agent-per-device-test-secret';
const agent = {
	agentId: 'agent-test',
	deviceId: 'remote-test',
	encryptedSecret: new Cryptr('agent-service-test-secret-that-is-long-enough').encrypt(secret),
	hostname: 'app-01',
	os: 'Example Linux',
	architecture: 'x64',
	agentVersion: '0.1.0',
	resticVersion: null,
	rcloneVersion: null,
	capabilities: { filesystemRootsConfigured: true, commandTypes: ['PING'] },
	createdAt: new Date('2026-01-01T00:00:00.000Z'),
	lastSeen: new Date('2026-01-01T00:00:00.000Z'),
	revokedAt: null,
};

const inventory = {
	hostname: 'app-01',
	os: 'Example Linux',
	architecture: 'x64',
	agentVersion: '0.1.0',
	capabilities: { filesystemRootsConfigured: true, commandTypes: ['PING'] as const },
};

describe('AgentService', () => {
	let store: jest.Mocked<AgentStore>;
	let service: AgentService;
	let now: Date;

	beforeEach(() => {
		now = new Date('2026-01-01T00:00:00.000Z');
		store = {
			createEnrollment: jest.fn().mockImplementation(async value => value),
			enrollAgent: jest.fn().mockResolvedValue({ id: 'enroll-1', deviceName: 'app-01' }),
			getAgentById: jest.fn().mockResolvedValue(agent),
			reserveNonce: jest.fn().mockResolvedValue(true),
			updateHeartbeat: jest.fn().mockResolvedValue(agent),
			leaseNext: jest.fn(),
			acknowledgeCommand: jest.fn(),
			recordCommandEvent: jest.fn(),
			completeCommand: jest.fn(),
			revokeAgentByDeviceId: jest.fn(),
			getAgentByDeviceId: jest.fn().mockResolvedValue(agent),
			revokeEnrollment: jest.fn(),
		} as unknown as jest.Mocked<AgentStore>;
		service = new AgentService(store, 'agent-service-test-secret-that-is-long-enough', () => now);
	});

	it('creates a random enrollment token while persisting only its hash', async () => {
		const result = await service.createEnrollment({ name: 'app-01' });
		expect(result.token).toHaveLength(43);
		expect(result.serverUrl).toBe('https://pluton.example.internal');
		expect(result.insecureHttpAllowed).toBe(false);
		expect(store.createEnrollment).toHaveBeenCalledWith(
			expect.objectContaining({
				deviceName: 'app-01',
				tokenHash: expect.not.stringContaining(result.token),
			})
		);
		expect((store.createEnrollment.mock.calls[0][0] as { tokenHash: string }).tokenHash).toBe(
			crypto.createHash('sha256').update(result.token).digest('base64url')
		);
	});

	it('reports the explicit server-side HTTP exception with an enrollment response', async () => {
		(configService.config as any).ALLOW_INSECURE_AGENT_HTTP = true;
		try {
			const result = await service.createEnrollment({ name: 'app-01' });
			expect(result.insecureHttpAllowed).toBe(true);
		} finally {
			(configService.config as any).ALLOW_INSECURE_AGENT_HTTP = false;
		}
	});

	it.each(['expired', 'reused', 'revoked'])('rejects a %s enrollment token', async () => {
		store.enrollAgent.mockResolvedValue(null);
		await expect(service.enroll({ token: 'a'.repeat(43), inventory })).rejects.toThrow(
			'Enrollment token is invalid'
		);
	});

	it('enrolls with a per-agent secret and queues only the safe inventory command', async () => {
		store.enrollAgent.mockResolvedValue({ id: 'enroll-1', deviceName: 'app-01' } as any);
		const result = await service.enroll({ token: 'a'.repeat(43), inventory });
		expect(result.secret).toHaveLength(43);
		expect(store.enrollAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				device: expect.objectContaining({ agentId: expect.any(String) }),
				identity: expect.objectContaining({ encryptedSecret: expect.any(String) }),
				command: expect.objectContaining({ type: 'INVENTORY_REFRESH', payload: {} }),
			})
		);
	});

	it('issues a unique signed lease token with each command delivery', async () => {
		store.leaseNext.mockImplementation(
			async (_agentId, leaseToken) =>
				({
					id: 'command-1',
					type: 'PING',
					payload: {},
					idempotencyKey: 'idem-1',
					leaseOwner: leaseToken,
					leaseExpiresAt: new Date(now.getTime() + 60_000),
				}) as any
		);
		const result = await service.poll({ agentId: agent.agentId, deviceId: agent.deviceId, secret });
		expect(result.command?.leaseToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(store.leaseNext).toHaveBeenCalledWith(
			agent.agentId,
			result.command?.leaseToken,
			60_000,
			now
		);
	});

	it('materializes BACKUP_FILESYSTEM credentials only for the signed leased response', async () => {
		const remoteBackupService = {
			materializeCommand: jest.fn().mockResolvedValue({
				version: 1,
				backupId: 'backup-01',
				planId: 'plan-01',
				sourcePath: '/srv/example-app',
				excludes: [],
				repository: { remoteName: 'pluton', path: 'managed/plan-01', initialize: true },
				rclone: {
					type: 'sftp',
					options: {
						host: 'sftp.example.internal',
						user: 'backup-user',
						pass: 'test-only-sftp-secret',
					},
				},
				repositoryPassword: 'test-only-repository-secret',
			}),
			completeCommand: jest.fn(),
		};
		service = new AgentService(
			store,
			'agent-service-test-secret-that-is-long-enough',
			() => now,
			remoteBackupService as any
		);
		const persistedPayload = { backupId: 'backup-01', planId: 'plan-01', repositoryId: 'repo-01' };
		store.leaseNext.mockImplementation(
			async (_agentId, leaseToken) =>
				({
					id: 'command-backup-01',
					type: 'BACKUP_FILESYSTEM',
					payload: persistedPayload,
					idempotencyKey: 'idem-backup-01',
					leaseOwner: leaseToken,
					leaseExpiresAt: new Date(now.getTime() + 60_000),
					lastEventSequence: 0,
				}) as any
		);

		const result = await service.poll({ agentId: agent.agentId, deviceId: agent.deviceId, secret });
		expect(remoteBackupService.materializeCommand).toHaveBeenCalledWith(
			agent.agentId,
			expect.objectContaining({ id: 'command-backup-01', payload: persistedPayload })
		);
		expect(result.command?.payload).toMatchObject({
			repositoryPassword: 'test-only-repository-secret',
		});
		expect(JSON.stringify(persistedPayload)).not.toContain('test-only-sftp-secret');
		expect(JSON.stringify(persistedPayload)).not.toContain('test-only-repository-secret');
	});

	it('fails closed rather than sending a durable BACKUP_FILESYSTEM reference without a materializer', async () => {
		store.leaseNext.mockImplementation(
			async (_agentId, leaseToken) =>
				({
					id: 'command-backup-unavailable',
					type: 'BACKUP_FILESYSTEM',
					payload: { backupId: 'backup-01', planId: 'plan-01', repositoryId: 'repo-01' },
					idempotencyKey: 'idem-backup-unavailable',
					leaseOwner: leaseToken,
					leaseExpiresAt: new Date(now.getTime() + 60_000),
					lastEventSequence: 0,
				}) as any
		);
		store.completeCommand.mockResolvedValue(null);
		await expect(
			service.poll({ agentId: agent.agentId, deviceId: agent.deviceId, secret })
		).resolves.toEqual({
			command: null,
		});
		expect(store.completeCommand).toHaveBeenCalledWith(
			agent.agentId,
			'command-backup-unavailable',
			expect.any(String),
			1,
			false,
			'Remote backup command could not be prepared.',
			now
		);
	});

	it('accepts a valid signed request and reserves its nonce', async () => {
		const timestamp = now.getTime().toString();
		const nonce = crypto.randomBytes(24).toString('base64url');
		const body = JSON.stringify({ hello: 'world' });
		const signature = signAgentRequest(secret, timestamp, nonce, 'POST', '/api/agent/poll', body);
		const result = await service.authenticate({
			agentId: agent.agentId,
			timestamp,
			nonce,
			signature,
			method: 'POST',
			path: '/api/agent/poll',
			body,
		});
		expect(result).toEqual({ agentId: agent.agentId, deviceId: agent.deviceId, secret });
		expect(store.reserveNonce).toHaveBeenCalledWith(
			agent.agentId,
			expect.any(String),
			expect.any(Date)
		);
	});

	it.each(['modified body', 'wrong secret', 'stale timestamp'])(
		'rejects a %s signed request',
		async scenario => {
			const timestamp = now.getTime().toString();
			const nonce = crypto.randomBytes(24).toString('base64url');
			const body = JSON.stringify({ hello: 'world' });
			const signature = signAgentRequest(secret, timestamp, nonce, 'POST', '/api/agent/poll', body);
			const override =
				scenario === 'modified body'
					? { body: JSON.stringify({ hello: 'tampered' }) }
					: scenario === 'wrong secret'
						? { signature: 'not-a-valid-signature' }
						: { timestamp: (now.getTime() - 6 * 60 * 1000).toString() };
			await expect(
				service.authenticate({
					agentId: agent.agentId,
					timestamp,
					nonce,
					signature,
					method: 'POST',
					path: '/api/agent/poll',
					body,
					...override,
				})
			).rejects.toThrow('Agent authentication failed');
		}
	);

	it('rejects a replayed nonce', async () => {
		store.reserveNonce.mockResolvedValue(false);
		const timestamp = now.getTime().toString();
		const nonce = crypto.randomBytes(24).toString('base64url');
		const body = '{}';
		const signature = signAgentRequest(secret, timestamp, nonce, 'POST', '/api/agent/poll', body);
		await expect(
			service.authenticate({
				agentId: agent.agentId,
				timestamp,
				nonce,
				signature,
				method: 'POST',
				path: '/api/agent/poll',
				body,
			})
		).rejects.toThrow('Agent authentication failed');
	});

	it('rejects a revoked agent before accepting a signature', async () => {
		store.getAgentById.mockResolvedValue({ ...agent, revokedAt: now } as any);
		await expect(
			service.authenticate({
				agentId: agent.agentId,
				timestamp: now.getTime().toString(),
				nonce: crypto.randomBytes(24).toString('base64url'),
				signature: 'x',
				method: 'POST',
				path: '/api/agent/poll',
				body: '{}',
			})
		).rejects.toThrow('Agent authentication failed');
	});

	it('derives offline status from last seen instead of a stored flag', async () => {
		now = new Date('2026-01-01T00:02:00.000Z');
		const result = await service.getPublicAgent(agent.deviceId);
		expect(result?.status).toBe('offline');
	});

	it('updates heartbeat inventory and derives the resulting online status', async () => {
		const updated = { ...agent, lastSeen: now, resticVersion: '0.17.3' };
		store.updateHeartbeat.mockResolvedValue(updated as any);
		const result = await service.heartbeat(agent.agentId, {
			...inventory,
			resticVersion: '0.17.3',
		});
		expect(store.updateHeartbeat).toHaveBeenCalledWith(agent.agentId, {
			...inventory,
			resticVersion: '0.17.3',
		});
		expect(result).toMatchObject({ status: 'online', resticVersion: '0.17.3' });
	});

	it('revokes the agent identity instead of only hiding its device', async () => {
		store.revokeAgentByDeviceId.mockResolvedValue({ ...agent, revokedAt: now } as any);
		await service.revokeDevice(agent.deviceId);
		expect(store.revokeAgentByDeviceId).toHaveBeenCalledWith(agent.deviceId);
	});

	it('requires the server-side insecure HTTP exception', () => {
		expect(() => service.assertTransportIsAllowed(false)).toThrow('Agent HTTPS is required');
		(configService.config as any).ALLOW_INSECURE_AGENT_HTTP = true;
		expect(() => service.assertTransportIsAllowed(false)).not.toThrow();
		(configService.config as any).ALLOW_INSECURE_AGENT_HTTP = false;
	});
});

import crypto from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import Cryptr from 'cryptr';
import {
	agentCommands,
	agentEnrollmentTokens,
	agentIdentities,
	agentRequestNonces,
} from '../src/db/schema/agents';
import {
	agentSourceAccessRequests,
	agentSourceAccessState,
} from '../src/db/schema/agentSourceAccess';
import { devices } from '../src/db/schema/devices';
import { plans } from '../src/db/schema/plans';
import { backups } from '../src/db/schema/backups';
import { AgentStore } from '../src/stores/AgentStore';
import { AgentSourceAccessStore } from '../src/stores/AgentSourceAccessStore';
import { AgentSourceAccessService } from '../src/services/AgentSourceAccessService';
import { AgentService, inventorySchema } from '../src/services/AgentService';
import { AgentController } from '../src/controllers/AgentController';
import { AgentAdminController } from '../src/controllers/AgentAdminController';
import { createAgentRouter } from '../src/routes/agents';
import { createAgentAdminRouter } from '../src/routes/agentAdmin';
import { signAgentRequest } from '../src/utils/agentProtocol';
import { sourceAccessReportSchema } from '../src/utils/agentSourceAccess';
import type { SourceAccessReport } from '../src/types/agentSourceAccess';
import type { AgentRequest } from '../src/types/agents';
import { serverLogger } from '../src/utils/logger';
import { verifyCommand } from '../../agent/src/protocol';

jest.mock('../src/services/ConfigService', () => ({
	configService: {
		config: {
			SECRET: 'source-access-disposable-test-encryption-key',
			APP_URL: 'https://pluton.example.internal',
			APIKEY: 'synthetic-read-only-api-key',
			ALLOW_INSECURE_AGENT_HTTP: true,
			AGENT_OFFLINE_TIMEOUT_SECONDS: 90,
		},
	},
}));

const encryptionKey = 'source-access-disposable-test-encryption-key';
const agentSecret = 'synthetic-agent-hmac-key';
const revision = 'a'.repeat(64);
const agentId = 'agent-example-01';
const deviceId = 'remote-example-01';
const root = '/srv/example-app';

function report(override: Partial<SourceAccessReport> = {}): SourceAccessReport {
	return {
		version: 1,
		hostPolicyRevision: revision,
		effectiveVersion: 0,
		approvedRoots: [root],
		effectiveRoots: [root],
		rootStatuses: [{ path: root, status: 'readable' }],
		...override,
	};
}

describe('Agent Source Access durable administration and policy', () => {
	let sqlite: Database.Database;
	let agentStore: AgentStore;
	let store: AgentSourceAccessStore;
	let service: AgentSourceAccessService;
	let now: Date;

	beforeEach(async () => {
		jest.spyOn(serverLogger, 'info').mockImplementation(() => undefined);
		now = new Date();
		sqlite = new Database(':memory:');
		sqlite.pragma('foreign_keys = ON');
		migrate(drizzle(sqlite), { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
		const db = drizzle(sqlite, {
			schema: {
				devices,
				agentCommands,
				agentEnrollmentTokens,
				agentIdentities,
				agentRequestNonces,
				agentSourceAccessState,
				agentSourceAccessRequests,
				plans,
				backups,
			},
		});
		agentStore = new AgentStore(db as any);
		store = new AgentSourceAccessStore(db as any);
		service = new AgentSourceAccessService(store, agentStore, () => now);
		sqlite
			.prepare('INSERT INTO devices(id,name,type,agent_id) VALUES(?,?,?,?)')
			.run(deviceId, 'app-01', 'remote-agent', agentId);
		sqlite
			.prepare(
				'INSERT INTO agent_identities(agent_id,device_id,encrypted_secret,hostname,os,architecture,agent_version,capabilities,last_seen) VALUES(?,?,?,?,?,?,?,?,?)'
			)
			.run(
				agentId,
				deviceId,
				new Cryptr(encryptionKey).encrypt(agentSecret),
				'app-01',
				'Example Linux',
				'x64',
				'0.5.0',
				JSON.stringify({
					sourceAccessVersion: 1,
					sourceAccessModesVersion: 1,
					filesystemRootsConfigured: true,
					commandTypes: [
						'PING',
						'INVENTORY_REFRESH',
						'SOURCE_ACCESS_VALIDATE',
						'SOURCE_ACCESS_APPLY',
					],
				}),
				Math.floor(now.getTime() / 1000)
			);
		await service.recordHeartbeat(agentId, report(), now.getTime() - 1000);
	});

	afterEach(() => {
		sqlite.close();
		jest.restoreAllMocks();
	});

	const body = (roots: string[] = [root]) => ({
		expectedVersion: 0,
		expectedHostPolicyRevision: revision,
		roots,
	});
	async function queue(kind: 'validate' | 'apply', roots: string[] = [root]) {
		const result = await service.request(deviceId, kind, body(roots));
		const record = (await store.listRequests(agentId)).find(item => item.id === result.requestId)!;
		const command = await agentStore.leaseNext(agentId, 'l'.repeat(32), 60000, now);
		await service.markDelivered(agentId, record.commandId);
		return { result, record, command: command! };
	}
	async function complete(
		commandId: string,
		result: unknown,
		success = true,
		extra: Record<string, unknown> = {}
	) {
		return service.complete(
			agentId,
			commandId,
			{ leaseToken: 'l'.repeat(32), sequence: 2, success, result, ...extra },
			now.getTime()
		);
	}

	it('keeps root metadata out of generic agent capabilities and rejects unsupported inventory fields', () => {
		const inventory = {
			hostname: 'app-01',
			os: 'Example Linux',
			architecture: 'x64',
			agentVersion: '0.5.0',
			capabilities: {
				filesystemRootsConfigured: true,
				commandTypes: ['SOURCE_ACCESS_VALIDATE', 'SOURCE_ACCESS_APPLY'],
				sourceAccessVersion: 1,
			},
			sourceAccess: report(),
		};
		expect(inventorySchema.safeParse(inventory).success).toBe(true);
		expect(inventorySchema.safeParse({ ...inventory, arbitraryFiles: ['secret'] }).success).toBe(
			false
		);
		expect(
			sourceAccessReportSchema.safeParse({ ...report(), effectiveRoots: ['/srv/other-app'] })
				.success
		).toBe(false);
		expect(sourceAccessReportSchema.safeParse({ ...report(), rootStatuses: [] }).success).toBe(
			false
		);
	});

	it('queues an immutable signed-protocol request and persists it across service reconstruction', async () => {
		const { record, command } = await queue('validate');
		expect(command.type).toBe('SOURCE_ACCESS_VALIDATE');
		expect(command.payload).toEqual({
			version: 1,
			requestId: record.id,
			expectedVersion: 0,
			expectedHostPolicyRevision: revision,
			roots: [root],
		});
		const recreated = new AgentSourceAccessService(store, agentStore, () => now);
		expect((await recreated.getView(deviceId)).requests[0]).toMatchObject({
			requestId: record.id,
			status: 'validating',
		});
		expect(command.payload).not.toHaveProperty('secret');
	});

	it('validates canonical outcomes without changing the effective selection', async () => {
		const { record } = await queue('validate', [`${root}/uploads`]);
		await complete(record.commandId, {
			sourceAccess: report(),
			validation: [
				{ requestedPath: `${root}/uploads`, canonicalPath: `${root}/uploads`, status: 'approved' },
			],
		});
		expect((await store.listRequests(agentId))[0].status).toBe('validated');
		expect((await store.getState(agentId))?.selectedRoots).toEqual([root]);
	});

	it('applies only an exact correlated durable selection and ignores terminal completion replays', async () => {
		const child = `${root}/uploads`;
		const { record } = await queue('apply', [child]);
		const applied = report({
			effectiveVersion: 1,
			effectiveRoots: [child],
			rootStatuses: [{ path: child, status: 'readable' }],
			lastAppliedRequestId: record.id,
		});
		await complete(record.commandId, { sourceAccess: applied });
		expect((await store.getState(agentId))?.selectedRoots).toEqual([child]);
		expect((await store.listRequests(agentId))[0].status).toBe('applied');
		await complete(record.commandId, {
			sourceAccess: report({
				approvedRoots: [root, '/srv/other-app'],
				effectiveRoots: ['/srv/other-app'],
				rootStatuses: [{ path: '/srv/other-app', status: 'readable' }],
			}),
		});
		expect((await store.getState(agentId))?.selectedRoots).toEqual([child]);
	});

	it('leaves requested expansions pending host approval without enabling them', async () => {
		const requested = '/srv/other-app';
		const { record } = await queue('apply', [root, requested]);
		await complete(
			record.commandId,
			{
				sourceAccess: report(),
				validation: [
					{
						requestedPath: requested,
						canonicalPath: requested,
						status: 'pending-host-approval',
						code: 'source-host-approval-required',
					},
				],
			},
			false,
			{ error: 'Source Access was not applied.' }
		);
		expect((await store.listRequests(agentId))[0].status).toBe('pending-host-approval');
		expect((await store.getState(agentId))?.selectedRoots).toEqual([root]);
		await expect(
			service.assertPlanSource((await agentStore.getAgentById(agentId))!, requested)
		).rejects.toThrow('enabled, effective');
		await expect(
			service.assertPlanSource((await agentStore.getAgentById(agentId))!, root)
		).resolves.toBeUndefined();
	});

	it('records safe failure without requiring a backup result or exposing raw agent errors', async () => {
		const { record } = await queue('apply');
		await service.complete(
			agentId,
			record.commandId,
			{
				leaseToken: 'l'.repeat(32),
				sequence: 2,
				success: false,
				error: 'synthetic-private-provider-text',
			},
			now.getTime()
		);
		const stored = (await store.listRequests(agentId))[0];
		expect(stored.status).toBe('rejected');
		expect(JSON.stringify(stored)).not.toContain('synthetic-private-provider-text');
		expect((await agentStore.getCommandForAgent(agentId, record.commandId))?.lastError).toBe(
			'source-access-rejected'
		);
	});

	it.each(['version', 'revision'])('rejects a stale %s before enqueueing', async field => {
		const input = body();
		if (field === 'version') input.expectedVersion = 7;
		else input.expectedHostPolicyRevision = 'b'.repeat(64);
		await expect(service.request(deviceId, 'apply', input)).rejects.toThrow(
			'Source Access changed'
		);
		expect(await store.listRequests(agentId)).toEqual([]);
	});

	it('serializes competing source changes and rejects wrong ownership, sequence and expired leases', async () => {
		const { record } = await queue('validate');
		await expect(service.request(deviceId, 'apply', body())).rejects.toThrow('still running');
		await expect(
			service.complete(
				'agent-other',
				record.commandId,
				{ leaseToken: 'l'.repeat(32), sequence: 2, success: false },
				now.getTime()
			)
		).rejects.toThrow('not found');
		await expect(
			complete(record.commandId, undefined, false, { leaseToken: 'wrong'.repeat(8) })
		).rejects.toThrow('not found');
		await agentStore.recordCommandEvent(agentId, record.commandId, 'l'.repeat(32), 2, now);
		await expect(complete(record.commandId, undefined, false)).rejects.toThrow('not found');
		now = new Date(now.getTime() + 61000);
		await expect(complete(record.commandId, undefined, false, { sequence: 3 })).rejects.toThrow(
			'not found'
		);
		expect((await store.listRequests(agentId))[0].status).toBe('validating');
	});

	it('never overwrites a newer host revision with a delayed completion or heartbeat', async () => {
		const { record } = await queue('validate');
		const changed = report({ hostPolicyRevision: 'b'.repeat(64) });
		await service.recordHeartbeat(agentId, changed, now.getTime() + 10);
		await complete(record.commandId, {
			sourceAccess: report(),
			validation: [{ requestedPath: root, canonicalPath: root, status: 'approved' }],
		});
		await service.recordHeartbeat(agentId, report(), now.getTime() - 10);
		expect((await store.getState(agentId))?.report.hostPolicyRevision).toBe(
			changed.hostPolicyRevision
		);
	});

	it('fails health immediately on a newer signed missing-state report while retaining the confirmed generation', async () => {
		const { record } = await queue('apply');
		await complete(record.commandId, {
			sourceAccess: report({ effectiveVersion: 1, lastAppliedRequestId: record.id }),
		});
		await service.recordHeartbeat(
			agentId,
			report({ effectiveRoots: [], rootStatuses: [], policyError: 'source-policy-state-missing' }),
			now.getTime() + 1
		);
		const state = (await store.getState(agentId))!;
		expect(state.report.effectiveVersion).toBe(1);
		expect(state.selectedRoots).toEqual([root]);
		expect(state.report.effectiveRoots).toEqual([]);
		await expect(
			service.assertPlanSource((await agentStore.getAgentById(agentId))!, root)
		).rejects.toThrow('fresh healthy');
	});

	it('audits host maximum changes and request outcomes with counts and hashes, never raw paths', async () => {
		await service.recordHeartbeat(
			agentId,
			report({ approvedRoots: [root, '/srv/other-app'], hostPolicyRevision: 'b'.repeat(64) }),
			now.getTime()
		);
		const events = (serverLogger.info as jest.Mock).mock.calls.map(call => call[0]);
		expect(events).toContainEqual(
			expect.objectContaining({
				agentEvent: 'source_access_host_maximum_changed',
				approvedCount: 2,
				addedCount: 1,
				removedCount: 0,
				approvedSetHash: expect.stringMatching(/^[a-f0-9]{64}$/),
			})
		);
		expect(JSON.stringify(events)).not.toContain('/srv/');
	});

	it('allows health recovery for the confirmed selection but refuses grants from a host maximum refresh', async () => {
		await service.recordHeartbeat(
			agentId,
			report({
				effectiveRoots: [],
				rootStatuses: [{ path: root, status: 'unreadable', code: 'source-root-not-readable' }],
			}),
			now.getTime()
		);
		await service.recordHeartbeat(agentId, report(), now.getTime() + 1);
		expect((await store.getState(agentId))?.report.effectiveRoots).toEqual([root]);
		await service.recordHeartbeat(
			agentId,
			report({
				approvedRoots: [root, '/srv/other-app'],
				effectiveRoots: [root, '/srv/other-app'],
				rootStatuses: [
					{ path: root, status: 'readable' },
					{ path: '/srv/other-app', status: 'readable' },
				],
			}),
			now.getTime() + 2
		);
		expect((await store.getState(agentId))?.report.effectiveRoots).toEqual([]);
		expect((await store.getState(agentId))?.report.policyError).toBe(
			'source-policy-unconfirmed-selection'
		);
	});

	it('blocks stale, offline, revoked and unhealthy reports and preserves old-agent compatibility', async () => {
		const identity = (await agentStore.getAgentById(agentId))!;
		await expect(service.assertPlanSource(identity, `${root}/uploads`)).resolves.toBeUndefined();
		await expect(service.assertPlanSource(identity, `${root}-sibling`)).rejects.toThrow(
			'enabled, effective'
		);
		await expect(service.assertPlanSource(identity, `${root}/./uploads`)).rejects.toThrow(
			'canonical'
		);
		await expect(
			service.assertPlanSource({ ...identity, capabilities: {} }, '/historical/source')
		).resolves.toBeUndefined();
		await service.recordHeartbeat(
			agentId,
			report({ policyError: 'source-policy-invalid', effectiveRoots: [] }),
			now.getTime()
		);
		await expect(service.assertPlanSource(identity, root)).rejects.toThrow('fresh healthy');
		now = new Date(now.getTime() + 91000);
		expect((await service.getView(deviceId)).reportFresh).toBe(false);
		await expect(service.request(deviceId, 'apply', body())).rejects.toThrow('online');
		await agentStore.revokeAgentByDeviceId(deviceId);
		await expect(service.refresh(deviceId)).rejects.toThrow('online');
	});

	it('fails freshness safely when the server clock moves behind a received source report', async () => {
		now = new Date(now.getTime() - 5000);
		expect((await service.getView(deviceId)).reportFresh).toBe(false);
		await expect(
			service.assertPlanSource((await agentStore.getAgentById(agentId))!, root)
		).rejects.toThrow('fresh healthy');
	});

	it.each([
		'/',
		'/srv',
		'/var/www',
		'/etc/example',
		'/proc/example',
		'/var/lib/pluton-agent/cache',
		'relative',
		'/srv/../example',
		'/srv/./example',
		'/srv/example\u0000',
		'/srv/example\\escape',
	])('rejects a new unsafe or overly broad source %s', async value => {
		await expect(service.request(deviceId, 'validate', body([value]))).rejects.toThrow();
		expect(await store.listRequests(agentId)).toEqual([]);
	});

	it('rejects oversized, duplicate, overlapping and noncanonical complete selections', async () => {
		for (const roots of [
			[root, root],
			[root, `${root}/uploads`],
			[`${root}//uploads`],
			['/srv/' + 'a'.repeat(1024)],
			Array.from({ length: 33 }, (_, i) => `/srv/app-${i}`),
		]) {
			await expect(service.request(deviceId, 'apply', body(roots))).rejects.toThrow();
		}
	});

	it('requires exact affected plans, pauses, and no queued or running backup before removal', async () => {
		sqlite
			.prepare(
				'INSERT INTO plans(id,title,source_id,source_type,source_config,settings,active) VALUES(?,?,?,?,?,?,?)'
			)
			.run(
				'plan-example',
				'Example backup',
				deviceId,
				'device',
				JSON.stringify({ includes: [`${root}/uploads`], excludes: [] }),
				'{}',
				1
			);
		expect((await service.getView(deviceId)).affectedPlans.map(plan => plan.id)).toEqual([
			'plan-example',
		]);
		await expect(service.request(deviceId, 'apply', body([]))).rejects.toThrow('exact affected');
		const confirmed = { ...body([]), confirmedAffectedPlanIds: ['plan-example'] };
		await expect(service.request(deviceId, 'apply', confirmed)).rejects.toThrow('Pause affected');
		sqlite.prepare('UPDATE plans SET active=0 WHERE id=?').run('plan-example');
		sqlite
			.prepare(
				'INSERT INTO backups(id,source_id,source_type,method,plan_id,in_progress,status) VALUES(?,?,?,?,?,?,?)'
			)
			.run('backup-example', deviceId, 'device', 'backup', 'plan-example', 1, 'queued');
		await expect(service.request(deviceId, 'apply', confirmed)).rejects.toThrow(
			'queued or running'
		);
		sqlite
			.prepare('UPDATE backups SET in_progress=0,status=? WHERE id=?')
			.run('completed', 'backup-example');
		await expect(service.request(deviceId, 'apply', confirmed)).resolves.toMatchObject({
			status: 'queued',
		});
		await expect(
			service.assertPlanSource((await agentStore.getAgentById(agentId))!, `${root}/uploads`)
		).rejects.toThrow('removing this source');
	});

	it('rechecks removal conflicts at delivery and never delivers a now-unsafe apply', async () => {
		const queued = await service.request(deviceId, 'apply', body([]));
		const record = (await store.listRequests(agentId))[0];
		sqlite
			.prepare(
				'INSERT INTO plans(id,title,source_id,source_type,source_config,settings,active) VALUES(?,?,?,?,?,?,?)'
			)
			.run(
				'plan-added-later',
				'Example backup',
				deviceId,
				'device',
				JSON.stringify({ includes: [root], excludes: [] }),
				'{}',
				0
			);
		await agentStore.leaseNext(agentId, 'l'.repeat(32), 60000, now);
		expect(await service.markDelivered(agentId, record.commandId)).toBe(false);
		expect((await store.listRequests(agentId))[0]).toMatchObject({
			id: queued.requestId,
			status: 'rejected',
			resultCode: 'source-removal-conflict',
		});
		expect((await store.getState(agentId))?.selectedRoots).toEqual([root]);
	});

	it('keeps unreadable confirmed roots in plan-removal impact and permits existing exact static broad roots', async () => {
		const otherAgent = 'agent-static-01',
			otherDevice = 'remote-static-01';
		sqlite
			.prepare('INSERT INTO devices(id,name,type,agent_id) VALUES(?,?,?,?)')
			.run(otherDevice, 'app-02', 'remote-agent', otherAgent);
		sqlite
			.prepare(
				'INSERT INTO agent_identities(agent_id,device_id,encrypted_secret,hostname,os,architecture,agent_version,capabilities,last_seen) VALUES(?,?,?,?,?,?,?,?,?)'
			)
			.run(
				otherAgent,
				otherDevice,
				'synthetic-encrypted-secret',
				'app-02',
				'Example Linux',
				'x64',
				'0.5.0',
				JSON.stringify({ sourceAccessVersion: 1 }),
				Math.floor(now.getTime() / 1000)
			);
		await service.recordHeartbeat(
			otherAgent,
			report({
				approvedRoots: ['/srv'],
				effectiveRoots: [],
				rootStatuses: [{ path: '/srv', status: 'unreadable' }],
			}),
			now.getTime()
		);
		sqlite
			.prepare(
				'INSERT INTO plans(id,title,source_id,source_type,source_config,settings,active) VALUES(?,?,?,?,?,?,?)'
			)
			.run(
				'plan-unreadable',
				'Example paused backup',
				otherDevice,
				'device',
				JSON.stringify({ includes: ['/srv/example-app'], excludes: [] }),
				'{}',
				0
			);
		expect((await service.getView(otherDevice)).affectedPlans.map(plan => plan.id)).toEqual([
			'plan-unreadable',
		]);
		await expect(
			service.request(otherDevice, 'apply', { ...body(['/srv']) })
		).resolves.toMatchObject({ status: 'queued' });
	});

	it('cancels only the owning queued request, preserving its audit and selection', async () => {
		const queued = await service.request(deviceId, 'apply', body());
		await service.cancel(deviceId, queued.requestId);
		expect((await store.listRequests(agentId))[0].status).toBe('cancelled');
		expect((await store.getState(agentId))?.selectedRoots).toEqual([root]);
		await expect(service.cancel(deviceId, queued.requestId)).rejects.toThrow('Only queued');
	});

	it('returns bounded request history with stable millisecond ordering and leaves the full audit in SQLite', async () => {
		let latest = '';
		for (let index = 0; index < 22; index += 1) {
			now = new Date(now.getTime() + 1);
			const queued = await service.request(deviceId, 'validate', body());
			latest = queued.requestId;
			await service.cancel(deviceId, latest);
		}
		const view = await service.getView(deviceId);
		expect(view.requests).toHaveLength(20);
		expect(view.requests[0].id).toBe(latest);
		expect(
			sqlite.prepare('SELECT count(*) AS count FROM agent_source_access_requests').get()
		).toEqual({ count: 22 });
	});

	it('protects all administrative source routes with the existing admin session model', async () => {
		const control = new AgentService(agentStore, encryptionKey, () => now, undefined, service);
		const app = express();
		app.use(express.json());
		app.use('/api/agent-admin', createAgentAdminRouter(new AgentAdminController(control, service)));
		const base = `/api/agent-admin/devices/${deviceId}/source-access`;
		for (const suffix of [
			'',
			'/validate',
			'/requests',
			'/refresh',
			'/requests/source-example/cancel',
		]) {
			const response = suffix
				? await request(app)
						.post(base + suffix)
						.send(body())
				: await request(app).get(base);
			expect(response.status).toBe(401);
		}
		expect(
			(await request(app).get(base).set('Authorization', 'Bearer synthetic-read-only-api-key'))
				.status
		).toBe(401);
		const cookie = `token=${jwt.sign({ user: 'administrator-session', webOrigin: 'https://pluton.example.internal' }, encryptionKey)}`;
		const response = await request(app)
			.get(base)
			.set('Host', 'pluton.example.internal')
			.set('X-Forwarded-Proto', 'https')
			.set('Cookie', cookie);
		// Approved authority maps to the configured browser origin even with local TLS termination.
		const unbound = `token=${jwt.sign({ user: 'administrator-session' }, encryptionKey)}`;
		const authorized = await request(app).get(base).set('Cookie', unbound);
		expect(response.status).toBe(200);
		const otherOrigin = `token=${jwt.sign({ user: 'administrator-session', webOrigin: 'https://other.example.internal' }, encryptionKey)}`;
		expect(
			(
				await request(app)
					.get(base)
					.set('Host', 'pluton.example.internal')
					.set('Cookie', otherOrigin)
			).status
		).toBe(401);
		expect(authorized.status).toBe(200);
		expect(authorized.headers['cache-control']).toBe('no-store');
		expect(JSON.stringify(authorized.body)).not.toContain(agentSecret);
	});

	describe('read-only paged Source Access history', () => {
		function seedHistory(count: number, offset = 0, timestamp = now.getTime()) {
			for (let index = offset; index < offset + count; index++) {
				const id = `source-history-${String(index).padStart(5, '0')}`;
				const kind = index % 3 === 0 ? 'mode-setup' : index % 3 === 1 ? 'validate' : 'apply';
				const status = [
					'applied',
					'validated',
					'rejected',
					'queued',
					'pending-host-approval',
					'pending-host-setup',
				][index % 6];
				sqlite
					.prepare(
						'INSERT INTO agent_commands(id,agent_id,type,payload,state,idempotency_key) VALUES(?,?,?,?,?,?)'
					)
					.run(
						`command-${id}`,
						agentId,
						'SOURCE_ACCESS_VALIDATE',
						JSON.stringify({ privateMarker: 'synthetic-command-private-marker' }),
						'completed',
						id
					);
				sqlite
					.prepare(
						`INSERT INTO agent_source_access_requests
					(id,agent_id,command_id,kind,status,expected_version,expected_host_policy_revision,roots,confirmed_affected_plan_ids,created_at,validation,result_code,requested_mode,setup_expires_at,completed_at)
					VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
					)
					.run(
						id,
						agentId,
						`command-${id}`,
						kind,
						status,
						3,
						revision,
						JSON.stringify([root]),
						'[]',
						timestamp,
						JSON.stringify([
							{
								requestedPath: root,
								canonicalPath: root,
								status: 'approved',
								code: 'source-readable',
							},
						]),
						'source-readable',
						kind === 'mode-setup' ? 'server-managed' : null,
						timestamp + 60000,
						timestamp + 1000
					);
			}
		}

		it.each([0, 1, 5, 6, 125])(
			'returns a bounded default page for %i historical requests without altering audit rows',
			async count => {
				seedHistory(count);
				const before = sqlite.serialize();
				sqlite.pragma('query_only=ON');
				const page = await service.getRequestHistory(deviceId, {});
				expect(page.requests).toHaveLength(Math.min(10, count));
				expect(page.total).toBe(count);
				expect(page.pageSize).toBe(10);
				expect(!!page.nextCursor).toBe(count > 10);
				expect(sqlite.serialize()).toEqual(before);
			}
		);

		it('uses exact newest-first keysets across ties, retains page boundaries during new inserts and includes new records on refresh', async () => {
			seedHistory(23);
			const first = await service.getRequestHistory(deviceId, {});
			seedHistory(1, 23, now.getTime() + 1000);
			seedHistory(1, 24); // Same timestamp and an ID below the first-page cursor is still a later insertion.
			sqlite
				.prepare('UPDATE agent_source_access_requests SET id=? WHERE id=?')
				.run('source-history-00000-extra', 'source-history-00024');
			seedHistory(1, 25, now.getTime() - 1000);
			const sameFirst = await service.getRequestHistory(deviceId, { cursor: first.cursor });
			expect(sameFirst).toEqual(first);
			const second = await service.getRequestHistory(deviceId, { cursor: first.nextCursor });
			const third = await service.getRequestHistory(deviceId, { cursor: second.nextCursor });
			expect([first.requests.length, second.requests.length, third.requests.length]).toEqual([
				10, 10, 3,
			]);
			expect(third.nextCursor).toBeUndefined();
			const ids = [...first.requests, ...second.requests, ...third.requests].map(row => row.id);
			expect(ids).toEqual(
				Array.from({ length: 23 }, (_, i) => `source-history-${String(22 - i).padStart(5, '0')}`)
			);
			expect(second.total).toBe(23);
			const refreshed = await service.getRequestHistory(deviceId, {});
			expect(refreshed.total).toBe(26);
			expect(refreshed.requests[0].id).toBe('source-history-00023');
			const empty = await service.getRequestHistory(deviceId, {
				cursor: Buffer.from(
					JSON.stringify({ version: 1, ceiling: 26, before: { time: 0, id: 'source-zero' } })
				).toString('base64url'),
			});
			expect(empty.requests).toEqual([]);
			expect(empty.nextCursor).toBeUndefined();
		});

		it('preserves safe full details, filters all statuses/types and keeps command/identity material private', async () => {
			seedHistory(36);
			sqlite.pragma('query_only=ON');
			for (const status of [
				'applied',
				'validated',
				'rejected',
				'queued',
				'pending-host-approval',
				'pending-host-setup',
			]) {
				const page = await service.getRequestHistory(deviceId, { status });
				expect(page.total).toBe(6);
				expect(page.requests.every(item => item.status === status)).toBe(true);
			}
			for (const kind of ['validate', 'apply', 'mode-setup']) {
				const page = await service.getRequestHistory(deviceId, { kind, limit: '2' });
				expect(page.requests).toHaveLength(2);
				expect(page.total).toBe(12);
				expect(page.requests.every(item => item.kind === kind)).toBe(true);
			}
			const page = await service.getRequestHistory(deviceId, {
				kind: 'mode-setup',
				status: 'applied',
			});
			expect(page.requests[0]).toMatchObject({
				requestId: 'source-history-00030',
				expectedVersion: 3,
				expectedHostPolicyRevision: revision,
				roots: [root],
				requestedMode: 'server-managed',
				resultCode: 'source-readable',
				validation: [
					{ requestedPath: root, canonicalPath: root, status: 'approved', code: 'source-readable' },
				],
				createdAt: now,
				completedAt: new Date(now.getTime() + 1000),
				setupExpiresAt: new Date(now.getTime() + 60000),
			});
			expect(JSON.stringify(page)).not.toMatch(
				/synthetic-command-private-marker|encryptedSecret|leaseToken|signature|commandId/
			);
			await expect(service.getRequestHistory('main', {})).rejects.toMatchObject({
				statusCode: 404,
			});
			await expect(service.getRequestHistory('other-device', {})).rejects.toMatchObject({
				statusCode: 404,
			});
		});

		it('keeps even a reused or modified cursor scoped to the selected Agent', async () => {
			seedHistory(12);
			const first = await service.getRequestHistory(deviceId, {});
			sqlite
				.prepare('INSERT INTO devices(id,name,type,agent_id) VALUES(?,?,?,?)')
				.run('other-device', 'app-02', 'remote-agent', 'other-agent');
			sqlite
				.prepare(
					`INSERT INTO agent_identities(agent_id,device_id,encrypted_secret,hostname,os,architecture,agent_version,capabilities)
				SELECT 'other-agent','other-device',encrypted_secret,'app-02',os,architecture,agent_version,capabilities FROM agent_identities WHERE agent_id=?`
				)
				.run(agentId);
			sqlite
				.prepare(
					`INSERT INTO agent_commands(id,agent_id,type,payload,state,idempotency_key)
				VALUES('other-command','other-agent','SOURCE_ACCESS_VALIDATE','{}','completed','other-command')`
				)
				.run();
			sqlite
				.prepare(
					`INSERT INTO agent_source_access_requests(id,agent_id,command_id,kind,status,expected_version,expected_host_policy_revision,roots,confirmed_affected_plan_ids,created_at)
				VALUES('other-request','other-agent','other-command','validate','validated',1,?,'["/srv/other-app"]','[]',?)`
				)
				.run(revision, now.getTime());
			sqlite.pragma('query_only=ON');
			const reused = await service.getRequestHistory('other-device', { cursor: first.cursor });
			expect(reused.requests).toEqual([]);
			const modified = await service.getRequestHistory('other-device', {
				cursor: Buffer.from(
					JSON.stringify({ version: 1, ceiling: Number.MAX_SAFE_INTEGER })
				).toString('base64url'),
			});
			expect(modified.requests.map(row => row.id)).toEqual(['other-request']);
			expect(JSON.stringify(modified)).not.toContain(root);
		});

		it.each([
			{ limit: '0' },
			{ limit: '51' },
			{ limit: '-1' },
			{ limit: ['10'] },
			{ cursor: 'a'.repeat(1025) },
			{ cursor: 'not-json' },
			{ cursor: Buffer.from('{"version":1,"ceiling":-1}').toString('base64url') },
			{ status: 'unknown' },
			{ kind: 'shell' },
			{ extra: 'ignored?' },
		])('refuses malformed pagination or filters %j', async input => {
			sqlite.pragma('query_only=ON');
			await expect(service.getRequestHistory(deviceId, input)).rejects.toMatchObject({
				statusCode: 400,
			});
		});

		it('requires the existing admin cookie, handles failure safely, sets no-store and scopes every query to the selected Agent', async () => {
			seedHistory(12);
			const control = new AgentService(agentStore, encryptionKey, () => now, undefined, service);
			const app = express();
			app.use(
				'/api/agent-admin',
				createAgentAdminRouter(new AgentAdminController(control, service))
			);
			const url = `/api/agent-admin/devices/${deviceId}/source-access/requests`;
			expect((await request(app).get(url)).status).toBe(401);
			expect(
				(await request(app).get(url).set('Authorization', 'Bearer synthetic-read-only-api-key'))
					.status
			).toBe(401);
			const cookie = `token=${jwt.sign({ user: 'administrator-session' }, encryptionKey)}`;
			const result = await request(app).get(url).set('Cookie', cookie);
			expect(result.status).toBe(200);
			expect(result.headers['cache-control']).toBe('no-store');
			expect(result.body.result.requests).toHaveLength(10);
			expect((await request(app).get(`${url}?limit=500`).set('Cookie', cookie)).status).toBe(400);
			const other = await request(app)
				.get(url.replace(deviceId, 'other-device'))
				.set('Cookie', cookie);
			expect(other.status).toBe(404);
			expect(JSON.stringify(other.body)).not.toContain(root);
			jest
				.spyOn(store, 'requestHistory')
				.mockRejectedValueOnce(new Error('synthetic-command-private-marker'));
			const failed = await request(app).get(url).set('Cookie', cookie);
			expect(failed.status).toBe(500);
			expect(JSON.stringify(failed.body)).not.toContain('synthetic-command-private-marker');
		});
	});

	it('authenticates source reports and rejects HMAC nonce replay before advancing report freshness', async () => {
		const control = new AgentService(agentStore, encryptionKey, () => now, undefined, service);
		const app = express();
		app.use(
			express.json({
				verify: (req, _res, buffer) => {
					(req as AgentRequest).rawBody = buffer.toString('utf8');
				},
			})
		);
		app.use('/api/agent', createAgentRouter(new AgentController(control), control));
		const pathname = '/api/agent/heartbeat';
		const timestamp = now.getTime().toString();
		const nonce = crypto.randomBytes(24).toString('base64url');
		const data = {
			hostname: 'app-01',
			os: 'Example Linux',
			architecture: 'x64',
			agentVersion: '0.5.0',
			capabilities: {
				filesystemRootsConfigured: true,
				commandTypes: ['PING'],
				sourceAccessVersion: 1,
			},
			sourceAccess: report(),
		};
		const raw = JSON.stringify(data);
		const headers = {
			'Content-Type': 'application/json',
			'x-pluton-agent-id': agentId,
			'x-pluton-agent-timestamp': timestamp,
			'x-pluton-agent-nonce': nonce,
			'x-pluton-agent-signature': signAgentRequest(
				agentSecret,
				timestamp,
				nonce,
				'POST',
				pathname,
				raw
			),
		};
		expect((await request(app).post(pathname).set(headers).send(raw)).status).toBe(200);
		expect((await request(app).post(pathname).set(headers).send(raw)).status).toBe(401);
		expect((await store.getState(agentId))?.latestReportTimestamp).toBe(Number(timestamp));
	});

	it.each(['expired', 'failed', 'cancelled'])(
		'reconciles a terminal %s command without requeueing or applying it, then accepts a new explicit request',
		async state => {
			const { record } = await queue('apply');
			sqlite.prepare('UPDATE agent_commands SET state=? WHERE id=?').run(state, record.commandId);
			const view = await service.getView(deviceId);
			expect(view.requests[0].status).toBe(state === 'cancelled' ? 'cancelled' : 'rejected');
			expect(view.requests[0].resultCode).toBe(`source-command-${state}`);
			expect((await store.getState(agentId))?.report.effectiveVersion).toBe(0);
			expect((await store.getState(agentId))?.selectedRoots).toEqual([root]);
			expect(sqlite.prepare('SELECT count(*) AS count FROM agent_commands').get()).toEqual({
				count: 1,
			});
			await expect(service.request(deviceId, 'apply', body())).resolves.toMatchObject({
				status: 'queued',
			});
			expect((await agentStore.getCommandForAgent(agentId, record.commandId))?.state).toBe(state);
		}
	);

	it('keeps an unknown completed outcome fail closed until an exact later durable heartbeat confirms it', async () => {
		const { record } = await queue('apply');
		sqlite.prepare("UPDATE agent_commands SET state='completed' WHERE id=?").run(record.commandId);
		let view = await service.getView(deviceId);
		expect(view.requests[0]).toMatchObject({
			status: 'validating',
			resultCode: 'source-outcome-unconfirmed',
		});
		await expect(service.request(deviceId, 'apply', body())).rejects.toThrow('still running');
		expect((await store.getState(agentId))?.report.effectiveVersion).toBe(0);
		await service.recordHeartbeat(
			agentId,
			report({ effectiveVersion: 1, lastAppliedRequestId: record.id }),
			now.getTime() + 1
		);
		view = await service.getView(deviceId);
		expect(view.requests[0].status).toBe('applied');
		expect((await store.getState(agentId))?.report.effectiveVersion).toBe(1);
		expect(sqlite.prepare('SELECT count(*) AS count FROM agent_commands').get()).toEqual({
			count: 1,
		});
	});

	it('keeps existing agents strict and refuses UI-only mode changes without capability and a guarded setup request', async () => {
		const input = {
			...body(['/srv/example-two']),
			authorizationMode: 'server-managed',
			confirmedAffectedPlanIds: [],
		};
		await expect(service.request(deviceId, 'apply', input)).rejects.toThrow('safe absolute');
		sqlite
			.prepare('UPDATE agent_identities SET capabilities=? WHERE agent_id=?')
			.run(JSON.stringify({ sourceAccessVersion: 1 }), agentId);
		expect((await service.getView(deviceId)).modeSetupSupported).toBe(false);
		await expect(service.setupMode(deviceId, input)).rejects.toThrow('Update this agent');
		expect((await store.getState(agentId))?.report.authorizationMode || 'host-approved').toBe(
			'host-approved'
		);
	});

	it('prepares a leased mode receipt only after all plans and operations are drained, then freezes work until a correlated host proof', async () => {
		sqlite
			.prepare(
				'INSERT INTO plans(id,title,source_id,source_type,source_config,settings,active) VALUES(?,?,?,?,?,?,?)'
			)
			.run(
				'mode-plan',
				'Example mode plan',
				deviceId,
				'device',
				JSON.stringify({ includes: [root], excludes: [] }),
				'{}',
				1
			);
		const input = {
			...body(['/srv/example-two', '/srv/example-three']),
			authorizationMode: 'server-managed',
			confirmedAffectedPlanIds: ['mode-plan'],
		};
		await expect(service.setupMode(deviceId, input)).rejects.toThrow('Pause every');
		sqlite.prepare('UPDATE plans SET active=0 WHERE id=?').run('mode-plan');
		const job = await agentStore.enqueueCommand({
			id: 'mode-active-job',
			agentId,
			type: 'BACKUP_FILESYSTEM',
			payload: {},
			idempotencyKey: 'mode-active-job',
		});
		await expect(service.setupMode(deviceId, input)).rejects.toThrow('every queued');
		await agentStore.cancelCommand(job!.id);
		const queued = await service.setupMode(deviceId, input);
		const setup = (await store.listRequests(agentId)).find(item => item.id === queued.requestId)!;
		const command = await agentStore.leaseNext(agentId, 'l'.repeat(32), 60000, now);
		expect(command!.type).toBe('SOURCE_ACCESS_MODE_SETUP');
		expect(await service.markDelivered(agentId, command!.id)).toBe(true);
		await complete(command!.id, {
			sourceAccess: report(),
			modeSetup: {
				requestId: setup.id,
				authorizationMode: 'server-managed',
				delegatedRoots: input.roots,
				expiresAt: setup.setupExpiresAt!.getTime(),
			},
		});
		expect((await store.listRequests(agentId))[0].status).toBe('pending-host-setup');
		await expect(service.assertModeChangeIdle(agentId)).rejects.toThrow('Keep this agent');
		await expect(
			service.assertPlanSource((await agentStore.getAgentById(agentId))!, root)
		).rejects.toThrow('mode setup is pending');
		await expect(service.cancel(deviceId, setup.id)).rejects.toThrow('Only queued');
		await service.recordHeartbeat(
			agentId,
			report({
				authorizationMode: 'server-managed',
				delegatedRoots: input.roots,
				lastModeSetupRequestId: setup.id,
				hostPolicyRevision: 'b'.repeat(64),
			}),
			now.getTime() + 1
		);
		expect((await store.listRequests(agentId))[0].status).toBe('applied');
		await expect(service.assertModeChangeIdle(agentId)).resolves.toBeUndefined();
		expect((await store.getState(agentId))?.report.effectiveRoots).toEqual([root]);
		await expect(
			service.assertPlanSource((await agentStore.getAgentById(agentId))!, `${root}/.ssh`)
		).rejects.toThrow('Private credential');
	});

	it('a transient host policy error cannot invent a mode transition or latch a healthy advanced selection out forever', async () => {
		const queued = await service.setupMode(deviceId, {
			...body(['/srv/example-two']),
			authorizationMode: 'server-managed',
			confirmedAffectedPlanIds: [],
		});
		const modeReport = report({
			authorizationMode: 'server-managed',
			delegatedRoots: ['/srv/example-two'],
			lastModeSetupRequestId: queued.requestId,
			hostPolicyRevision: 'b'.repeat(64),
		});
		await service.recordHeartbeat(agentId, modeReport, now.getTime() + 1);
		const selected = await service.request(deviceId, 'apply', {
			...body([`${root}/uploads`]),
			expectedHostPolicyRevision: modeReport.hostPolicyRevision,
		});
		const healthy = {
			...modeReport,
			effectiveVersion: 1,
			lastAppliedRequestId: selected.requestId,
			effectiveRoots: [`${root}/uploads`],
			rootStatuses: [{ path: `${root}/uploads`, status: 'readable' as const }],
		};
		await service.recordHeartbeat(agentId, healthy, now.getTime() + 2);
		await service.recordHeartbeat(
			agentId,
			report({ effectiveRoots: [], rootStatuses: [], policyError: 'source-host-policy-busy' }),
			now.getTime() + 3
		);
		let state = (await store.getState(agentId))!;
		expect(state.report.authorizationMode).toBe('server-managed');
		expect(state.report.effectiveRoots).toEqual([]);
		await service.recordHeartbeat(agentId, healthy, now.getTime() + 4);
		state = (await store.getState(agentId))!;
		expect(state.report.policyError).toBeUndefined();
		expect(state.report.effectiveVersion).toBe(1);
		expect(state.report.effectiveRoots).toEqual([`${root}/uploads`]);
	});

	it('a valid new Apply cannot override an unconfirmed mode or advance the confirmed selection version', async () => {
		const queued = await service.request(deviceId, 'apply', body([`${root}/uploads`]));
		const forged = report({
			authorizationMode: 'server-managed',
			delegatedRoots: ['/srv/example-two'],
			lastModeSetupRequestId: 'unbound-mode-request',
			effectiveVersion: 1,
			lastAppliedRequestId: queued.requestId,
			effectiveRoots: [`${root}/uploads`],
			rootStatuses: [{ path: `${root}/uploads`, status: 'readable' }],
		});
		await service.recordHeartbeat(agentId, forged, now.getTime() + 1);
		let state = (await store.getState(agentId))!;
		expect(state.report.policyError).toBe('source-mode-unconfirmed');
		expect(state.report.effectiveVersion).toBe(0);
		expect(state.selectedRoots).toEqual([root]);
		await service.recordHeartbeat(agentId, { ...forged, effectiveVersion: 0 }, now.getTime() + 2);
		state = (await store.getState(agentId))!;
		expect(state.report.policyError).toBe('source-mode-unconfirmed');
		expect(state.report.effectiveRoots).toEqual([]);
	});

	it('retains the mode freeze through receipt expiry and HMAC skew, then expires bookkeeping without a mode grant', async () => {
		const queued = await service.setupMode(deviceId, {
			...body(['/srv/example-two']),
			authorizationMode: 'server-managed',
			confirmedAffectedPlanIds: [],
		});
		const setup = (await store.listRequests(agentId))[0];
		await agentStore.leaseNext(agentId, 'l'.repeat(32), 60000, now);
		await complete(setup.commandId, {
			sourceAccess: report(),
			modeSetup: {
				requestId: queued.requestId,
				authorizationMode: 'server-managed',
				delegatedRoots: setup.roots,
				expiresAt: setup.setupExpiresAt!.getTime(),
			},
		});
		now = new Date(now.getTime() + 16 * 60000);
		await expect(service.assertModeChangeIdle(agentId)).rejects.toThrow('Keep this agent');
		now = new Date(now.getTime() + 5 * 60000);
		await service.getView(deviceId);
		expect((await store.listRequests(agentId))[0]).toMatchObject({
			status: 'rejected',
			resultCode: 'source-mode-setup-expired',
		});
		await expect(service.assertModeChangeIdle(agentId)).resolves.toBeUndefined();
		expect((await store.getState(agentId))?.report.authorizationMode || 'host-approved').toBe(
			'host-approved'
		);
	});

	it('exposes guarded mode setup only to the existing administrative session', async () => {
		const control = new AgentService(agentStore, encryptionKey, () => now, undefined, service);
		const app = express();
		app.use(express.json());
		app.use('/api/agent-admin', createAgentAdminRouter(new AgentAdminController(control, service)));
		const pathname = `/api/agent-admin/devices/${deviceId}/source-access/mode-setup`;
		const input = {
			...body(['/srv/example-two']),
			authorizationMode: 'server-managed',
			confirmedAffectedPlanIds: [],
		};
		expect((await request(app).post(pathname).send(input)).status).toBe(401);
		expect(
			(
				await request(app)
					.post(pathname)
					.set('Authorization', 'Bearer synthetic-read-only-api-key')
					.send(input)
			).status
		).toBe(401);
		const cookie = `token=${jwt.sign({ user: 'administrator-session' }, encryptionKey)}`;
		expect((await request(app).post(pathname).set('Cookie', cookie).send(input)).status).toBe(202);
	});

	it('signs the bounded apply envelope and routes authenticated source completion without the backup result parser', async () => {
		const child = `${root}/uploads`;
		const queued = await service.request(deviceId, 'apply', body([child]));
		const control = new AgentService(agentStore, encryptionKey, () => now, undefined, service);
		const delivery = await control.poll({ agentId, deviceId, secret: agentSecret });
		const wire = JSON.parse(JSON.stringify(delivery.command));
		expect(wire.type).toBe('SOURCE_ACCESS_APPLY');
		expect(verifyCommand(agentSecret, wire)).toBe(true);
		expect(
			verifyCommand(agentSecret, {
				...wire,
				payload: { ...wire.payload, roots: ['/srv/other-app'] },
			})
		).toBe(false);
		const app = express();
		app.use(
			express.json({
				verify: (req, _res, buffer) => {
					(req as AgentRequest).rawBody = buffer.toString('utf8');
				},
			})
		);
		app.use('/api/agent', createAgentRouter(new AgentController(control), control));
		const pathname = `/api/agent/commands/${wire.id}/complete`;
		const timestamp = now.getTime().toString(),
			nonce = crypto.randomBytes(24).toString('base64url');
		const raw = JSON.stringify({
			leaseToken: wire.leaseToken,
			sequence: 1,
			success: true,
			result: {
				sourceAccess: report({
					effectiveVersion: 1,
					effectiveRoots: [child],
					rootStatuses: [{ path: child, status: 'readable' }],
					lastAppliedRequestId: queued.requestId,
				}),
			},
		});
		const response = await request(app)
			.post(pathname)
			.set({
				'Content-Type': 'application/json',
				'x-pluton-agent-id': agentId,
				'x-pluton-agent-timestamp': timestamp,
				'x-pluton-agent-nonce': nonce,
				'x-pluton-agent-signature': signAgentRequest(
					agentSecret,
					timestamp,
					nonce,
					'POST',
					pathname,
					raw
				),
			})
			.send(raw);
		expect(response.status).toBe(200);
		expect((await store.getState(agentId))?.selectedRoots).toEqual([child]);
		expect((await store.listRequests(agentId))[0].status).toBe('applied');
	});
});

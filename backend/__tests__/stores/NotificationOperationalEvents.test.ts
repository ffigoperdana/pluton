import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { notificationFixture } from '../fixtures/notifications';
import { fixture as fullFixture } from '../integration/persistentRestore.fixture';
import { notificationEvents } from '../../src/types/notificationDelivery';
import { notificationText } from '../../src/notifications/terminalPayload';
import { BRAND_NAME } from '../../src/utils/brand';

/** docs/OPERATIONAL_NOTIFICATIONS.md: replica copy failures and Agent availability. */
const MINUTE = 60_000;
const watch = { timeoutMs: 90_000, graceMs: 10 * MINUTE };

describe('operational notifications', () => {
	let fixture: ReturnType<typeof notificationFixture>;
	beforeEach(() => {
		fixture = notificationFixture();
	});
	afterEach(() => fixture.sqlite.close());

	function subscribe(events: string[] = [...notificationEvents]) {
		const channel = fixture.store.saveChannel(fixture.channel('smtp'));
		fixture.store.saveSubscription('plan-01', { enabled: true, channelIds: [channel.id], events });
		return channel;
	}
	function job(id: string, status: string, extra: Record<string, unknown> = {}) {
		fixture.sqlite
			.prepare(
				'INSERT INTO managed_replication_jobs(id,backup_id,plan_id,replication_id,destination_storage_id,source_snapshot_id,status,attempts,last_error_code,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
			)
			.run(
				id,
				'backup-01',
				'plan-01',
				'replica-01',
				'storage-02',
				'a'.repeat(64),
				status,
				1,
				(extra.code as string) ?? null,
				fixture.now() - MINUTE,
				fixture.now()
			);
	}
	const setJob = (id: string, status: string, code: string | null = null) =>
		fixture.sqlite
			.prepare('UPDATE managed_replication_jobs SET status=?,last_error_code=? WHERE id=?')
			.run(status, code, id);
	function agent(lastSeenMs: number | null, extra: { revoked?: boolean } = {}) {
		fixture.sqlite
			.prepare(
				'INSERT OR REPLACE INTO agent_identities(agent_id,device_id,last_seen,revoked_at) VALUES (?,?,?,?)'
			)
			.run(
				'agent-01',
				'app-01',
				lastSeenMs === null ? null : Math.floor(lastSeenMs / 1000),
				extra.revoked ? 1 : null
			);
	}
	const heartbeat = () =>
		fixture.sqlite
			.prepare('UPDATE agent_identities SET last_seen=? WHERE agent_id=?')
			.run(Math.floor(fixture.now() / 1000), 'agent-01');
	const reconcileAgents = (watchingSince = 0) =>
		fixture.store.reconcileAgents({ ...watch, watchingSince });

	describe('replica copy', () => {
		it('notifies a failed copy once, with the replica and its failure category', () => {
			subscribe();
			job('job-01', 'running');
			fixture.store.reconcile();
			expect(fixture.store.deliveries()).toHaveLength(0);
			setJob('job-01', 'failed', 'destination-unavailable');
			fixture.store.reconcile();
			const [delivery] = fixture.store.deliveries();
			expect(delivery).toEqual(
				expect.objectContaining({
					eventType: 'replication.failed',
					planName: 'Example Application',
				})
			);
			const payload = fixture.store.payload(delivery.eventId);
			expect(payload.replication).toEqual({
				id: 'job-01',
				replication_id: 'replica-01',
				replica_name: 'Example replica',
				status: 'failed',
				attempts: 1,
			});
			expect(payload.error).toEqual({ category: 'destination-unavailable' });
			expect(notificationText(payload).subject).toBe(
				`[${BRAND_NAME}] Replica Copy Needs Attention — Example Application`
			);
			// A retry that fails again is the same outcome of the same copy: no second message.
			setJob('job-01', 'pending');
			setJob('job-01', 'failed', 'destination-unavailable');
			fixture.store.reconcile();
			expect(fixture.store.deliveries()).toHaveLength(1);
		});

		it('notifies an uncertain copy as needing review, and never a completed one', () => {
			subscribe();
			job('job-02', 'running');
			setJob('job-02', 'uncertain', 'execution-interrupted');
			job('job-03', 'completed');
			fixture.store.reconcile();
			const deliveries = fixture.store.deliveries();
			expect(deliveries).toHaveLength(1);
			const payload = fixture.store.payload(deliveries[0].eventId);
			expect(payload.replication?.status).toBe('uncertain');
			expect(notificationText(payload).text).toContain('does not retry it automatically');
		});

		it('respects the plan subscription and keeps unsafe categories out', () => {
			subscribe(['backup.failed']);
			job('job-04', 'failed', { code: 'Not A Category; rm' });
			fixture.store.reconcile();
			expect(fixture.store.deliveries()).toHaveLength(0);
			fixture.store.saveSubscription('plan-01', {
				enabled: true,
				channelIds: fixture.store.channels().map(channel => channel.id),
				events: ['replication.failed'],
			});
			job('job-05', 'failed', { code: 'Not A Category; rm' });
			fixture.store.reconcile();
			const [delivery] = fixture.store.deliveries();
			expect(fixture.store.payload(delivery.eventId).error).toEqual({
				category: 'replication-failed',
			});
		});
	});

	describe('Agent availability', () => {
		it('alerts after the grace period, once, and again when the Agent is back', () => {
			subscribe();
			agent(fixture.now());
			expect(reconcileAgents()).toBe(0);
			// Offline: last heartbeat 90 s + grace ago is required before any message.
			fixture.advance(5 * MINUTE);
			expect(reconcileAgents()).toBe(0);
			fixture.advance(4 * MINUTE);
			expect(reconcileAgents()).toBe(0);
			fixture.advance(3 * MINUTE);
			expect(reconcileAgents()).toBe(1);
			expect(reconcileAgents()).toBe(0);
			let deliveries = fixture.store.deliveries();
			expect(deliveries).toHaveLength(1);
			expect(deliveries[0]).toEqual(
				expect.objectContaining({
					eventType: 'agent.offline',
					planId: null,
					planName: 'Agent app-01',
				})
			);
			const offline = fixture.store.payload(deliveries[0].eventId);
			expect(offline.agent).toEqual(expect.objectContaining({ id: 'agent-01', name: 'app-01' }));
			expect(notificationText(offline).subject).toBe(`[${BRAND_NAME}] Agent Offline — app-01`);
			expect(notificationText(offline).text).toContain('wait in the queue');
			fixture.advance(MINUTE);
			heartbeat();
			expect(reconcileAgents()).toBe(1);
			deliveries = fixture.store.deliveries();
			expect(deliveries.map(row => row.eventType).sort()).toEqual([
				'agent.offline',
				'agent.online',
			]);
			expect(reconcileAgents()).toBe(0);
		});

		it('treats a busy Agent with a live command lease as online', () => {
			subscribe();
			agent(fixture.now());
			reconcileAgents();
			fixture.sqlite
				.prepare(
					"INSERT INTO agent_commands(id,agent_id,state,lease_expires_at) VALUES ('c-1','agent-01','running',?)"
				)
				.run(Math.floor(fixture.now() / 1000) + 3600);
			fixture.advance(30 * MINUTE);
			expect(reconcileAgents()).toBe(0);
			expect(reconcileAgents()).toBe(0);
			expect(fixture.store.deliveries()).toHaveLength(0);
		});

		it('never alerts for a short restart, an outage that predates watching, or server downtime', () => {
			subscribe();
			// A restart shorter than the grace period.
			agent(fixture.now());
			reconcileAgents();
			fixture.advance(5 * MINUTE);
			reconcileAgents();
			heartbeat();
			expect(reconcileAgents()).toBe(0);
			// The server itself was down for an hour: the grace starts when watching starts.
			fixture.advance(60 * MINUTE);
			const restartedAt = fixture.now();
			expect(reconcileAgents(restartedAt)).toBe(0);
			fixture.advance(MINUTE);
			heartbeat();
			expect(reconcileAgents(restartedAt)).toBe(0);
			expect(fixture.store.deliveries()).toHaveLength(0);
		});

		it('baselines an Agent that is already offline when first observed', () => {
			subscribe();
			agent(fixture.now() - 24 * 60 * MINUTE);
			expect(reconcileAgents()).toBe(0);
			fixture.advance(60 * MINUTE);
			expect(reconcileAgents()).toBe(0);
			// Its return is still reported, so the operator learns it is back.
			heartbeat();
			expect(reconcileAgents()).toBe(1);
			expect(fixture.store.deliveries()[0].eventType).toBe('agent.online');
		});

		it('only notifies channels a plan of that Agent subscribes, and skips revoked Agents', () => {
			const channel = fixture.store.saveChannel(fixture.channel('smtp'));
			fixture.store.saveSubscription('plan-01', {
				enabled: true,
				channelIds: [channel.id],
				events: ['backup.failed'],
			});
			agent(fixture.now());
			reconcileAgents();
			fixture.advance(20 * MINUTE);
			expect(reconcileAgents()).toBe(0);
			expect(fixture.store.deliveries()).toHaveLength(0);
			agent(fixture.now() - 20 * MINUTE, { revoked: true });
			expect(reconcileAgents()).toBe(0);
			expect(
				fixture.sqlite.prepare('SELECT count(*) AS n FROM notification_agent_states').get()
			).toEqual({ n: 0 });
		});
	});
});

describe('operational notification migration', () => {
	it('marks a real replication job ready when it fails (all migrations)', () => {
		const { sqlite } = fullFixture();
		sqlite
			.prepare(
				`INSERT INTO managed_replication_jobs(id,backup_id,plan_id,repository_id,agent_id,source_storage_id,source_storage_path,source_snapshot_id,source_repository_config_id,source_tree_id,source_binding_hash,replication_id,destination_storage_id,destination_storage_path,destination_fingerprint,status,attempts,created_at,updated_at) VALUES('job-01','backup-01','plan-01','repo-01','agent-01','storage-01','managed/fixture',?,?,?,?,'replica-01','storage-01','replicas/app-01',?,'running',1,1,1)`
			)
			.run('b'.repeat(64), 'e'.repeat(64), '1'.repeat(64), 'c'.repeat(64), 'd'.repeat(64));
		const source = () =>
			sqlite
				.prepare(
					"SELECT ready FROM notification_sources WHERE kind='replication' AND job_id='job-01'"
				)
				.get();
		expect(source()).toEqual({ ready: 0 });
		sqlite.prepare("UPDATE managed_replication_jobs SET status='failed' WHERE id='job-01'").run();
		expect(source()).toEqual({ ready: 1 });
		sqlite.prepare("DELETE FROM managed_replication_jobs WHERE id='job-01'").run();
		expect(source()).toBeUndefined();
		sqlite.close();
	});

	it('does not replay replica failures that existed before the upgrade', () => {
		const sqlite = new Database(':memory:');
		sqlite.exec(`
		 CREATE TABLE plans(id TEXT PRIMARY KEY,title TEXT,source_type TEXT,source_id TEXT);
		 CREATE TABLE backups(id TEXT PRIMARY KEY,plan_id TEXT,status TEXT,in_progress INTEGER);
		 CREATE TABLE recovery_tests(id TEXT PRIMARY KEY,plan_id TEXT,status TEXT);
		 CREATE TABLE managed_replication_jobs(id TEXT PRIMARY KEY,plan_id TEXT,status TEXT);
		 INSERT INTO managed_replication_jobs VALUES ('old-failed','plan-01','failed'),('old-done','plan-01','completed');
		`);
		sqlite.exec(readFileSync(path.resolve('drizzle/0010_phase7_notification_outbox.sql'), 'utf8'));
		sqlite.exec(readFileSync(path.resolve('drizzle/0026_operational_notifications.sql'), 'utf8'));
		expect(
			sqlite
				.prepare(
					"SELECT s.job_id,s.ready,o.terminal_status FROM notification_sources s LEFT JOIN notification_observed o ON o.source_id=s.id WHERE s.kind='replication' ORDER BY s.job_id"
				)
				.all()
		).toEqual([
			{ job_id: 'old-done', ready: 0, terminal_status: null },
			{ job_id: 'old-failed', ready: 0, terminal_status: 'failed' },
		]);
		sqlite.close();
	});
});

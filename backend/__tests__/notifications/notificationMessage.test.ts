import { readFileSync } from 'fs';
import path from 'path';
import { notificationMessage } from '../../src/notifications/notificationMessage';
import { explainProblem } from '../../src/notifications/problemExplanations';
import type { NotificationPayload } from '../../src/types/notificationDelivery';
import { BRAND_NAME } from '../../src/utils/brand';

const appUrl = 'https://backup.example.internal/';
const plan = { id: 'plan-01', name: 'Example Application' };
const failedBackup: NotificationPayload = {
	version: 1,
	event_id: 'event-01',
	event_type: 'backup.failed',
	timestamp: '2026-11-25T07:32:10.000Z',
	plan,
	backup: { id: 'backup-01', status: 'failed', snapshot_id: null },
	started_at: '2026-11-25T07:30:00.000Z',
	completed_at: '2026-11-25T07:32:10.000Z',
	duration_seconds: 130,
	summary: { files: 1834, bytes: 48_200_000 },
	error: { category: 'source-root-not-readable' },
};

describe('notification email message', () => {
	it('explains a failed backup: what happened, what to do, readable details and links', () => {
		const message = notificationMessage(failedBackup, { appUrl, timeZone: 'Asia/Jakarta' });

		expect(message.subject).toBe(`[${BRAND_NAME}] Backup Failed — Example Application`);
		expect(message.text).toContain('No new restore point was created by this run.');
		expect(message.text).toContain('What happened: The source folder cannot be read');
		expect(message.text).toMatch(/What to do:\n1\. Open the plan, then Source Access/);
		expect(message.text).toContain('Started: 25 Nov 2026, 14:30 GMT+7');
		expect(message.text).toContain('Duration: 2 min');
		expect(message.text).toContain('Files: 1,834');
		expect(message.text).toContain('Size: 45.97 MB');
		expect(message.text).toContain('Snapshot: Not created');
		expect(message.text).toContain('Failure code: source-root-not-readable');
		expect(message.text).toContain('Open plan: https://backup.example.internal/plan/plan-01');
		expect(message.text).toContain(
			'Troubleshooting guide: https://backup.example.internal/docs/troubleshooting/source#1-understand-the-error'
		);
		expect(message.html).toContain('Backup of Example Application failed');
		expect(message.html).toContain('The source folder cannot be read');
		expect(message.html).toContain('href="https://backup.example.internal/plan/plan-01"');
		expect(message.preHeader).toContain('The source folder cannot be read');
	});

	it('escapes every dynamic value in the HTML part', () => {
		const message = notificationMessage(
			{ ...failedBackup, plan: { id: 'plan"><x', name: '<img src=x onerror=alert(1)> & Co' } },
			{ appUrl }
		);

		expect(message.html).not.toContain('<img');
		expect(message.html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; Co');
		expect(message.html).toContain('href="https://backup.example.internal/plan/plan%22%3E%3Cx"');
	});

	it('omits links without a usable http(s) dashboard URL', () => {
		for (const value of [undefined, '', 'javascript:alert(1)', 'not a url']) {
			const message = notificationMessage(failedBackup, { appUrl: value });
			expect(message.html).not.toContain('<a ');
			expect(message.text).not.toContain('Open plan:');
		}
	});

	it('keeps the existing safety wording for replica copies, Agents and recovery tests', () => {
		const replica = notificationMessage({
			...failedBackup,
			event_type: 'replication.failed',
			backup: { id: 'backup-01', status: 'completed', snapshot_id: 'a'.repeat(64) },
			replication: {
				id: 'copy-01',
				replication_id: 'replica-a',
				replica_name: 'Offsite S3',
				status: 'uncertain',
				attempts: 3,
			},
			error: { category: 'timeout' },
		});
		expect(replica.subject).toBe(
			`[${BRAND_NAME}] Replica Copy Needs Attention — Example Application`
		);
		expect(replica.text).toContain('does not retry it automatically');
		expect(replica.text).toContain('What happened: The copy took too long');

		const agent = notificationMessage({
			version: 1,
			event_id: 'event-02',
			event_type: 'agent.offline',
			timestamp: '2026-11-25T09:00:00.000Z',
			agent: {
				id: 'agent-01',
				name: 'app-01',
				last_seen: '2026-11-25T08:41:00.000Z',
				offline_since: '2026-11-25T08:41:00.000Z',
			},
		});
		expect(agent.subject).toBe(`[${BRAND_NAME}] Agent Offline — app-01`);
		expect(agent.text).toContain('wait in the queue');
		expect(agent.text).toContain('systemctl status pluton-agent.service');
		expect(agent.html).toContain('<code');

		const recovery = notificationMessage({
			...failedBackup,
			event_type: 'recovery.passed_with_warning',
			error: undefined,
			backup: undefined,
			recovery: {
				id: 'recovery-01',
				backup_id: 'backup-01',
				status: 'passed_with_warning',
				snapshot_id: 'b'.repeat(64),
			},
			summary: {
				databases: [
					{ engine: 'mariadb', bytes: 500, artifact_integrity: 'passed', sql_import: 'not_tested' },
				],
			},
			warnings: [{ category: 'database-cleanup-failed' }],
		});
		expect(recovery.text).toContain('SQL import NOT TESTED');
		expect(recovery.text).toContain('not a guarantee of semantic application recovery');
		expect(recovery.text).toContain('Warning: Temporary files were not fully removed.');
	});

	it('has a specific explanation for every closed failure category', () => {
		const source = readFileSync(
			path.join(__dirname, '../../src/notifications/terminalPayload.ts'),
			'utf8'
		);
		const list = source.slice(source.indexOf('new Set(['), source.indexOf(']);'));
		const codes = [...list.matchAll(/'([a-z][a-z0-9-]*)'/g)].map(match => match[1]);
		const generic = explainProblem('no-such-category', 'job');

		expect(codes.length).toBeGreaterThan(90);
		for (const code of codes) {
			const explanation = explainProblem(code, 'job');
			expect(explanation).not.toBe(generic);
			expect(explanation.steps.length).toBeGreaterThan(0);
			expect(explanation.guide).toMatch(/^\/docs\//);
		}
	});
});

import type { NotificationPayload, NotificationEventType } from '../types/notificationDelivery';
import { notificationMessage } from './notificationMessage';
// Deliberately project closed, documented metadata. Never spread a job/config/error.
type Row = Record<string, any>;
const json = (value: unknown): Row => {
	try {
		return typeof value === 'string' ? JSON.parse(value) : value || {};
	} catch {
		return {};
	}
};
const count = (value: unknown) =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const snapshot = (value: unknown) =>
	typeof value === 'string' && /^[a-f0-9]{8,64}$/.test(value) ? value : null;
const identifier = (value: unknown) =>
	typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : undefined;
const time = (value: unknown) =>
	typeof value === 'number' && Number.isFinite(value)
		? new Date(value * 1000).toISOString()
		: undefined;
const safeCodes = new Set([
	'cancelled',
	'interrupted',
	'import-disabled',
	'unexpected',
	'source-parent-not-traversable',
	'source-root-not-readable',
	'source-entry-inaccessible',
	'source-missing',
	'source-symlink-escape',
	'source-unsupported-type',
	'source-policy-violation',
	'database-auth-failed',
	'database-privileges-failed',
	'database-authentication-failed',
	'database-insufficient-privileges',
	'database-connection-failed',
	'database-tls-failed',
	'database-dump-failed',
	'database-dump-timeout',
	'database-client-missing',
	'database-client-incompatible',
	'database-configuration-invalid',
	'database-invalid-configuration',
	'database-unavailable',
	'database-tls-verification-failed',
	'database-tool-unavailable',
	'database-dump-invalid',
	'database-output-empty',
	'database-dump-output-limit',
	'invalid-payload',
	'source-validation-failed',
	'state-overlap',
	'state-validation-failed',
	'tool-unavailable',
	'sftp-password-obscure-failed',
	'temporary-config-failed',
	'repository-check-failed',
	'repository-target-check-failed',
	'repository-target-not-empty',
	'target-check-access-failed',
	'target-check-auth-failed',
	'target-check-transport-failed',
	'repository-initialization-failed',
	'restic-backup-failed',
	'restic-summary-missing',
	'workspace-failed',
	'hook-invalid',
	'hook-output-limit',
	'snapshot-confirmation-failed',
	'lifecycle-invalid',
	'database-import-failed',
	'database-import-validation-failed',
	'database-import-timeout',
	'database-cleanup-failed',
	'workspace-cleanup-failed',
	'unsafe-workspace',
	'snapshot-not-found',
	'snapshot-binding-mismatch',
	'snapshot-metadata-invalid',
	'repository-auth-failed',
	'repository-access-failed',
	'restore-failed',
	'restore-timeout',
	'unsupported-snapshot-file',
	'workspace-size-limit',
	'insufficient-space',
	'database-target-unavailable',
	'database-already-exists',
	'database-output-limit',
	'database-role-missing',
	'restored-file-count-mismatch',
	'restored-file-size-mismatch',
	'source-tree-missing',
	'database-artifact-missing',
	'database-artifact-size-mismatch',
	'database-artifact-hash-mismatch',
	'database-metadata-incomplete',
	'recovery-target-not-configured',
	'recovery-target-unsafe',
	'hook-failed',
	'hook-timeout',
	'cleanup-failed',
	'internal-operator-unavailable',
	'internal-provisioning-timeout',
	'recovery-workload-busy',
	'internal-target-not-provisioned',
	'internal-target-unsafe',
	'internal-resources-insufficient',
	'internal-cleanup-required',
	'mysql-worker-not-configured',
	'mysql-worker-unavailable',
	'mysql-worker-busy',
	'mysql-worker-protocol-failed',
	'mysql-worker-resource-limit',
	'restored-file-hash-mismatch',
	'restored-link-target-mismatch',
	'database-out-of-memory',
	'database-storage-full',
]);
function category(value: unknown, fallback = 'job-failed'): string {
	return typeof value === 'string' && safeCodes.has(value) ? value : fallback;
}
export function terminalPayload(
	kind: 'backup' | 'recovery',
	row: Row,
	eventId: string,
	now: number
): NotificationPayload {
	const stats = json(row.completion_stats);
	const result = json(row.result);
	const warnings = kind === 'backup' ? stats.lifecycle?.warnings : json(row.warnings);
	const eventType: NotificationEventType =
		kind === 'backup'
			? row.status === 'completed'
				? Array.isArray(warnings) && warnings.length
					? 'backup.completed_with_warning'
					: 'backup.completed'
				: row.status === 'cancelled'
					? 'backup.cancelled'
					: 'backup.failed'
			: (`recovery.${row.status}` as NotificationEventType);
	const payload: NotificationPayload = {
		version: 1,
		event_id: eventId,
		event_type: eventType,
		timestamp: new Date(now).toISOString(),
		plan: {
			id: row.plan_id,
			name: Array.from(String(row.plan_name || 'Backup plan'))
				.filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
				.join('')
				.slice(0, 120),
		},
		started_at: time(row.started_at),
		completed_at: time(kind === 'backup' ? row.ended_at : row.completed_at),
	};
	const ended = kind === 'backup' ? row.ended_at : row.completed_at;
	if (typeof row.started_at === 'number' && typeof ended === 'number' && ended >= row.started_at)
		payload.duration_seconds = ended - row.started_at;
	if (kind === 'backup') {
		payload.backup = { id: row.id, status: row.status, snapshot_id: snapshot(stats.snapshot_id) };
		payload.summary = {
			files: count(stats.total_files_processed),
			bytes: count(stats.total_bytes_processed),
		};
		const artifacts =
			stats.lifecycle?.databases || (stats.lifecycle?.database ? [stats.lifecycle.database] : []);
		if (Array.isArray(artifacts))
			payload.summary.databases = artifacts.slice(0, 8).map((db: Row) => ({
				database_id: identifier(db.databaseId),
				engine: ['mariadb', 'mysql', 'postgresql'].includes(db.engine) ? db.engine : undefined,
				bytes: count(db.bytes) || 0,
				artifact_integrity: 'archived_in_snapshot',
				sql_import: 'not_tested',
			}));
	} else {
		payload.recovery = {
			id: row.id,
			backup_id: row.backup_id,
			status: row.status,
			snapshot_id: snapshot(row.snapshot_id) || '',
		};
		payload.summary = {
			files: count(result.filesystem?.files),
			bytes: count(result.filesystem?.bytes),
			databases: Array.isArray(result.databases)
				? result.databases.slice(0, 8).map((db: Row) => ({
						database_id: identifier(db.databaseId),
						engine: ['mariadb', 'mysql', 'postgresql'].includes(db.engine) ? db.engine : undefined,
						bytes: count(db.bytes) || 0,
						artifact_integrity: ['passed', 'failed', 'pending'].includes(db.artifactValidation)
							? db.artifactValidation
							: 'not_tested',
						sql_import: ['passed', 'failed', 'pending'].includes(db.importValidation)
							? db.importValidation
							: 'not_tested',
					}))
				: [],
			cleanup: {
				workspace: result.cleanup?.workspace === true,
				databases: result.cleanup?.databases === true,
			},
		};
	}
	if (row.status === 'failed')
		payload.error = {
			category: category(
				row.failure_code ||
					(row.progress_stats && json(row.progress_stats).failureCode) ||
					[...safeCodes].find(
						code =>
							typeof row.error_msg === 'string' &&
							(row.error_msg.includes(`/${code})`) || row.error_msg.includes(`/${code}; `))
					)
			),
		};
	if (row.status === 'cancelled') payload.error = { category: 'cancelled' };
	if (Array.isArray(warnings))
		payload.warnings = warnings
			.slice(0, 24)
			.map(warning => ({ category: category(warning.code, 'validation-warning') }));
	return payload;
}
const planRef = (row: Row) => ({
	id: row.plan_id,
	name: Array.from(String(row.plan_name || 'Backup plan'))
		.filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
		.join('')
		.slice(0, 120),
});
const label = (value: unknown, fallback: string) =>
	Array.from(String(value || fallback))
		.filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
		.join('')
		.slice(0, 120) || fallback;
/** Server-generated categories only: lowercase words joined by dashes. */
const replicationCode = (value: unknown) =>
	typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : 'replication-failed';
const isoMs = (value: unknown) =>
	typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : undefined;

/** A replica copy that failed, or stopped uncertainly (docs/OPERATIONAL_NOTIFICATIONS.md). */
export function replicationPayload(row: Row, eventId: string, now: number): NotificationPayload {
	const status = row.status === 'uncertain' ? 'uncertain' : 'failed';
	return {
		version: 1,
		event_id: eventId,
		event_type: 'replication.failed',
		timestamp: new Date(now).toISOString(),
		plan: planRef(row),
		backup: {
			id: row.backup_id,
			status: 'completed',
			snapshot_id: snapshot(row.source_snapshot_id),
		},
		replication: {
			id: row.id,
			replication_id: label(row.replication_id, 'replica'),
			replica_name: label(row.replica_name, 'Replica storage'),
			status,
			attempts: count(row.attempts),
		},
		started_at: isoMs(row.created_at),
		completed_at: isoMs(row.updated_at),
		error: { category: replicationCode(row.last_error_code) },
	};
}

/** An Agent that stayed offline past the grace period, or that came back afterwards. */
export function agentPayload(
	eventType: 'agent.offline' | 'agent.online',
	agent: { id: string; name: string; lastSeenMs: number | null; offlineSinceMs: number },
	eventId: string,
	now: number
): NotificationPayload {
	return {
		version: 1,
		event_id: eventId,
		event_type: eventType,
		timestamp: new Date(now).toISOString(),
		agent: {
			id: agent.id,
			name: label(agent.name, 'Agent'),
			last_seen: agent.lastSeenMs === null ? null : new Date(agent.lastSeenMs).toISOString(),
			offline_since: new Date(agent.offlineSinceMs).toISOString(),
		},
	};
}

/** Subject and plain text of a notification email (see notificationMessage for the HTML part). */
export function notificationText(payload: NotificationPayload): { subject: string; text: string } {
	const { subject, text } = notificationMessage(payload);
	return { subject, text };
}

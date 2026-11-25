import type { NotificationPayload } from '../types/notificationDelivery';
import { BRAND_NAME } from '../utils/brand';
import { formatBytes, formatDuration } from '../utils/formatter';
import {
	agentGuide,
	explainProblem,
	warningLabel,
	type ProblemExplanation,
} from './problemExplanations';

/**
 * Subject, plain text and HTML for notification channel emails. Everything shown comes from
 * the safe payload projection plus server-authored explanations; dynamic values are escaped.
 */
export type MessageContext = {
	/** Absolute http(s) dashboard URL; links are omitted without it. */
	appUrl?: string;
	/** IANA time zone for dates; the server zone when omitted. */
	timeZone?: string;
};
export type NotificationMessage = {
	subject: string;
	text: string;
	html: string;
	preHeader: string;
};

type Tone = 'success' | 'warning' | 'error' | 'info';
const tones: Record<Tone, { text: string; tint: string; border: string }> = {
	success: { text: '#067647', tint: '#ecfdf3', border: '#12b76a' },
	warning: { text: '#93370d', tint: '#fffaeb', border: '#f79009' },
	error: { text: '#b42318', tint: '#fef3f2', border: '#f04438' },
	info: { text: '#3538cd', tint: '#eef0ff', border: '#575aff' },
};

const labels: Record<string, string> = {
	'backup.completed': 'Backup Successful',
	'backup.completed_with_warning': 'Backup Completed with Warning',
	'backup.failed': 'Backup Failed',
	'backup.cancelled': 'Backup Cancelled',
	'recovery.passed': 'Recovery Test Passed',
	'recovery.passed_with_warning': 'Recovery Test Passed with Warning',
	'recovery.failed': 'Recovery Test Failed',
	'recovery.cancelled': 'Recovery Test Cancelled',
	'replication.failed': 'Replica Copy Needs Attention',
	'agent.offline': 'Agent Offline',
	'agent.online': 'Agent Back Online',
	'notification.test': 'Test Notification',
};

const outcomes: Record<string, string> = {
	'backup.completed': 'completed',
	'backup.completed_with_warning': 'completed with warnings',
	'backup.failed': 'failed',
	'backup.cancelled': 'was cancelled',
	'recovery.passed': 'passed',
	'recovery.passed_with_warning': 'passed with warnings',
	'recovery.failed': 'failed',
	'recovery.cancelled': 'was cancelled',
};

const toneOf = (eventType: string): Tone =>
	/failed|offline/.test(eventType)
		? 'error'
		: /warning|cancelled/.test(eventType)
			? 'warning'
			: eventType === 'notification.test'
				? 'info'
				: 'success';

const escapeHtml = (value: string) =>
	value.replace(
		/[&<>"']/g,
		char =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string
	);

function dashboardUrl(appUrl: string | undefined): string | undefined {
	if (!appUrl) return undefined;
	try {
		const url = new URL(appUrl);
		return url.protocol === 'https:' || url.protocol === 'http:'
			? url.origin + url.pathname.replace(/\/+$/, '')
			: undefined;
	} catch {
		return undefined;
	}
}

function formatDate(value: string | null | undefined, timeZone?: string): string | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return undefined;
	const options: Intl.DateTimeFormatOptions = {
		day: 'numeric',
		month: 'short',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		timeZoneName: 'short',
		hour12: false,
	};
	try {
		return new Intl.DateTimeFormat('en-GB', { ...options, timeZone }).format(date);
	} catch {
		return new Intl.DateTimeFormat('en-GB', options).format(date);
	}
}

const number = (value: number | undefined) =>
	value === undefined ? undefined : value.toLocaleString('en-US');
const size = (value: number | undefined) => (value === undefined ? undefined : formatBytes(value));
const resultLabel = (status: string | undefined) =>
	status ? status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ') : undefined;
const shortId = (value: string | null | undefined) => (value ? value.slice(0, 12) : undefined);

type Row = [label: string, value: string | undefined];
type Section = {
	headline: string;
	/** One-paragraph summary of the outcome and its impact. */
	summary: string;
	problem?: ProblemExplanation;
	/** Extra actions shown when there is no problem explanation. */
	steps?: string[];
	details: Row[];
	databases?: Row[][];
	warnings?: string[];
	notes?: string[];
	links: { label: string; path: string }[];
};

function describe(payload: NotificationPayload, context: MessageContext): Section {
	const type = payload.event_type;
	const when = (value?: string | null) => formatDate(value, context.timeZone);
	const ids: Row[] = [['Event ID', payload.event_id]];

	if (type === 'notification.test')
		return {
			headline: 'Test notification',
			summary: `This is a test message from ${BRAND_NAME}. If you can read it, this email channel works.`,
			details: [['Sent', when(payload.timestamp)], ...ids],
			links: [{ label: 'Open notification settings', path: '/settings' }],
		};

	if (payload.agent) {
		const agent = payload.agent;
		const offline = type === 'agent.offline';
		return {
			headline: offline ? `Agent ${agent.name} is offline` : `Agent ${agent.name} is back online`,
			summary: offline
				? `${BRAND_NAME} has not received a heartbeat from this Agent since ${when(agent.last_seen) || 'it was enrolled'}. Scheduled backups of this Agent wait in the queue while it is offline; they are not reported as failed. Check the host, its network and the pluton-agent service.`
				: 'The Agent is reachable again. Queued backups continue; check that the next scheduled runs complete.',
			steps: offline
				? [
						'Check that the host is powered on and connected to the network.',
						'On the host, run `systemctl status pluton-agent.service` and restart the service if it stopped.',
						`Check that the host can reach ${BRAND_NAME} over HTTPS (proxy, firewall, DNS).`,
						'When the Agent reconnects you receive an "Agent Back Online" message.',
					]
				: ['Open the plans of this Agent and check that the next scheduled backups complete.'],
			details: [
				['Agent', agent.name],
				['Last heartbeat', when(agent.last_seen) || 'Never'],
				['Offline since', when(agent.offline_since)],
				['Agent ID', agent.id],
				...ids,
			],
			links: [
				{ label: 'Open sources', path: '/sources' },
				...(offline ? [{ label: 'Agent troubleshooting', path: agentGuide }] : []),
			],
		};
	}

	const planLink = payload.plan
		? [{ label: 'Open plan', path: `/plan/${encodeURIComponent(payload.plan.id)}` }]
		: [];
	const planName = payload.plan?.name || 'Backup plan';

	if (payload.replication) {
		const copy = payload.replication;
		const uncertain = copy.status === 'uncertain';
		const problem = explainProblem(payload.error?.category, 'replication');
		return {
			headline: `Copy of ${planName} to ${copy.replica_name} needs attention`,
			summary: uncertain
				? `The copy stopped without a provable outcome. ${BRAND_NAME} does not retry it automatically and holds the replication queue; review it in the backup mirror details.`
				: 'The backup itself is safe in the primary repository. Retry the copy from the backup mirror details after fixing the cause.',
			problem,
			details: [
				['Plan', planName],
				['Replica', `${copy.replica_name} (${copy.replication_id})`],
				['Result', uncertain ? 'Uncertain' : 'Failed'],
				['Attempts', number(copy.attempts)],
				['Snapshot', shortId(payload.backup?.snapshot_id)],
				['Started', when(payload.started_at)],
				['Last attempt', when(payload.completed_at)],
				['Failure code', payload.error?.category || 'replication-failed'],
				['Backup ID', payload.backup?.id],
				...ids,
			],
			links: [...planLink, { label: 'Troubleshooting guide', path: problem.guide }],
		};
	}

	const recovery = payload.recovery;
	const failed = type.endsWith('.failed');
	const cancelled = type.endsWith('.cancelled');
	const problem = payload.error ? explainProblem(payload.error.category, 'job') : undefined;
	const summary = recovery
		? failed
			? 'The recovery test could not prove that this backup can be restored. The backup itself was not changed.'
			: cancelled
				? 'The recovery test was stopped before it finished. The backup itself was not changed.'
				: type === 'recovery.passed_with_warning'
					? 'The backup was restored into a private test area and checked, but some checks reported warnings. Review them below.'
					: 'The backup was restored into a private test area and checked.'
		: failed
			? 'No new restore point was created by this run. Earlier snapshots are unchanged and can still be restored.'
			: cancelled
				? 'This run was stopped before it finished, so no new restore point was created. Earlier snapshots are unchanged.'
				: type === 'backup.completed_with_warning'
					? 'A new snapshot was stored, but some checks reported warnings. Review them below.'
					: 'A new snapshot was stored and can be restored.';
	const databases = (payload.summary?.databases || []).map((db): Row[] => [
		['Database', `${db.database_id || 'Database'} (${db.engine || 'database'})`],
		['Dump size', size(db.bytes)],
		['Artifact integrity', resultLabel(db.artifact_integrity)],
		['SQL import', db.sql_import === 'not_tested' ? 'NOT TESTED' : resultLabel(db.sql_import)],
	]);
	const cleanupState = payload.summary?.cleanup;
	return {
		headline: `${recovery ? 'Recovery test' : 'Backup'} of ${planName} ${outcomes[type] || 'finished'}`,
		summary,
		problem: failed || cancelled ? problem : undefined,
		details: [
			['Plan', planName],
			['Result', resultLabel(recovery?.status || payload.backup?.status)],
			['Started', when(payload.started_at)],
			['Finished', when(payload.completed_at || payload.timestamp)],
			[
				'Duration',
				payload.duration_seconds !== undefined
					? formatDuration(payload.duration_seconds)
					: undefined,
			],
			['Files', number(payload.summary?.files)],
			['Size', size(payload.summary?.bytes)],
			[
				recovery ? 'Snapshot tested' : 'Snapshot',
				shortId(recovery?.snapshot_id || payload.backup?.snapshot_id) ||
					(failed || cancelled ? 'Not created' : undefined),
			],
			[
				'Cleanup',
				cleanupState
					? `Workspace ${cleanupState.workspace ? 'complete' : 'incomplete'}, databases ${cleanupState.databases ? 'complete' : 'incomplete'}`
					: undefined,
			],
			['Failure code', payload.error && !cancelled ? payload.error.category : undefined],
			[recovery ? 'Recovery test ID' : 'Backup ID', recovery?.id || payload.backup?.id],
			...(recovery ? ([['Backup ID', recovery.backup_id]] as Row[]) : []),
			...ids,
		],
		databases,
		warnings: (payload.warnings || []).map(
			warning => `${warningLabel(warning.category)} (${warning.category})`
		),
		notes: recovery
			? [
					'Structural restore / artifact integrity is not a guarantee of semantic application recovery. SQL import is validated only when explicitly reported passed.',
				]
			: undefined,
		links: [
			...planLink,
			...(problem && (failed || cancelled)
				? [{ label: 'Troubleshooting guide', path: problem.guide }]
				: []),
		],
	};
}

function renderText(section: Section, subjectLine: string, base?: string): string {
	const lines = [subjectLine, '', section.summary];
	if (section.problem) {
		lines.push('', `What happened: ${section.problem.title}`, section.problem.detail);
	}
	const steps = section.problem?.steps || section.steps;
	if (steps?.length) {
		lines.push('', 'What to do:');
		steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
	}
	if (section.warnings?.length) {
		lines.push('', 'Warnings:');
		section.warnings.forEach(warning => lines.push(`- Warning: ${warning}`));
	}
	lines.push('', 'Details:');
	for (const [name, value] of section.details)
		if (value !== undefined) lines.push(`${name}: ${value}`);
	for (const db of section.databases || [])
		lines.push(
			`Database artifact ${db
				.map(([name, value]) => `${name} ${value ?? 'Not available'}`)
				.join('; ')}`
		);
	for (const note of section.notes || []) lines.push('', note);
	if (base && section.links.length) {
		lines.push('');
		for (const link of section.links) lines.push(`${link.label}: ${base}${link.path}`);
	}
	return lines.join('\n');
}

const cell = 'padding:7px 12px;font-size:13px;line-height:1.4;vertical-align:top;';
const sectionTitle =
	'margin:24px 0 8px;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#8a93b8;';

function renderHtml(section: Section, eventType: string, base?: string): string {
	const tone = tones[toneOf(eventType)];
	const parts: string[] = [];
	parts.push(
		`<div style="padding:8px 30px 0;font-family:Inter,Arial,Helvetica,sans-serif;color:#3d3f5c;">`,
		`<div style="text-align:center;">`,
		`<span style="display:inline-block;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:700;background:${tone.tint};color:${tone.text};">${escapeHtml(labels[eventType] || 'Notification')}</span>`,
		`<h2 style="margin:14px 0 0;font-size:20px;line-height:1.3;color:#1d1f2b;">${escapeHtml(section.headline)}</h2>`,
		`</div>`,
		`<p style="margin:18px 0 0;font-size:14px;line-height:1.6;color:#3d3f5c;">${escapeHtml(section.summary)}</p>`
	);
	if (section.problem)
		parts.push(
			`<div style="margin:20px 0 0;padding:14px 16px;border-radius:8px;background:${tone.tint};border-left:4px solid ${tone.border};">`,
			`<div style="font-size:14px;font-weight:700;color:${tone.text};">${escapeHtml(section.problem.title)}</div>`,
			`<p style="margin:6px 0 0;font-size:13px;line-height:1.6;color:#3d3f5c;">${escapeHtml(section.problem.detail)}</p>`,
			`</div>`
		);
	const steps = section.problem?.steps || section.steps;
	if (steps?.length)
		parts.push(
			`<div style="${sectionTitle}">What to do</div>`,
			`<ol style="margin:0;padding-left:20px;font-size:13px;line-height:1.6;color:#3d3f5c;">`,
			...steps.map(step => `<li style="margin:0 0 6px;">${renderInlineCode(step)}</li>`),
			`</ol>`
		);
	if (section.warnings?.length)
		parts.push(
			`<div style="${sectionTitle}">Warnings</div>`,
			`<ul style="margin:0;padding-left:20px;font-size:13px;line-height:1.6;color:${tones.warning.text};">`,
			...section.warnings.map(warning => `<li style="margin:0 0 4px;">${escapeHtml(warning)}</li>`),
			`</ul>`
		);
	parts.push(`<div style="${sectionTitle}">Details</div>`, table(section.details));
	section.databases?.forEach(db => parts.push(`<div style="height:10px;"></div>`, table(db)));
	for (const note of section.notes || [])
		parts.push(
			`<p style="margin:16px 0 0;font-size:12px;line-height:1.5;color:#6e6f92;">${escapeHtml(note)}</p>`
		);
	if (base && section.links.length)
		parts.push(
			`<div style="margin:24px 0 4px;text-align:center;">`,
			...section.links.map(
				(link, index) =>
					`<a href="${escapeHtml(base + link.path)}" style="display:inline-block;margin:0 4px 8px;padding:10px 18px;border-radius:6px;font-size:13px;font-weight:700;text-decoration:none;${index === 0 ? 'background:#575aff;color:#ffffff;border:1px solid #575aff;' : 'background:#ffffff;color:#575aff;border:1px solid #c7c9ff;'}">${escapeHtml(link.label)}</a>`
			),
			`</div>`
		);
	parts.push(`</div>`);
	return parts.join('');
}

function table(rows: Row[]): string {
	const visible = rows.filter(([, value]) => value !== undefined);
	return [
		`<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;background:#f8faff;border-radius:8px;">`,
		...visible.map(
			([name, value], index) =>
				`<tr><td style="${cell}width:38%;color:#8a93b8;${index ? 'border-top:1px solid #eef1fa;' : ''}">${escapeHtml(name)}</td><td style="${cell}color:#1d1f2b;font-weight:600;word-break:break-word;${index ? 'border-top:1px solid #eef1fa;' : ''}">${escapeHtml(value as string)}</td></tr>`
		),
		`</table>`,
	].join('');
}

/** Renders `code` spans in server-authored steps; everything else stays escaped text. */
function renderInlineCode(step: string): string {
	return escapeHtml(step).replace(
		/`([^`]+)`/g,
		(_, code) =>
			`<code style="padding:1px 5px;border-radius:4px;background:#eef0f7;font-family:Menlo,Consolas,monospace;font-size:12px;">${code}</code>`
	);
}

export function notificationSubject(payload: NotificationPayload): string {
	const label = labels[payload.event_type] || 'Notification';
	if (payload.agent) return `[${BRAND_NAME}] ${label} — ${payload.agent.name}`;
	return `[${BRAND_NAME}] ${label}${payload.plan ? ` — ${payload.plan.name}` : ''}`;
}

export function notificationMessage(
	payload: NotificationPayload,
	context: MessageContext = {}
): NotificationMessage {
	const base = dashboardUrl(context.appUrl);
	const section = describe(payload, context);
	const subject = notificationSubject(payload);
	const heading = `${BRAND_NAME} — ${labels[payload.event_type] || 'Notification'}`;
	return {
		subject,
		preHeader: section.problem ? `${section.problem.title}. ${section.summary}` : section.summary,
		text: renderText(section, heading, base),
		html: renderHtml(section, payload.event_type, base),
	};
}

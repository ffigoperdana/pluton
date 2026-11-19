import path from 'path';
import { z } from 'zod';

/**
 * Restore to an Agent host (docs/AGENT_HOST_RESTORE.md). Shared, side-effect free
 * rules: capability and version gating, the heartbeat report schema, and the
 * lexical rules for the folder name and the snapshot selection. The Agent
 * re-validates all of them and its host policy at execution.
 */

export const AGENT_HOST_RESTORE_PARTIAL_SUFFIX = '.partial';
export const AGENT_HOST_RESTORE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const AGENT_HOST_ARTIFACT_PATH =
	/^\/pluton\/database\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,95}\.sql$/;
export const MAX_AGENT_HOST_SELECTION = 1024;
export const MAX_AGENT_HOST_SELECTION_CHARACTERS = 256 * 1024;
export const MAX_RESTORE_ROOTS = 8;

export const restoreRootCodes = [
	'restore-root-invalid',
	'restore-root-denied',
	'restore-root-overlap',
	'restore-root-missing',
	'restore-root-not-directory',
	'restore-root-not-canonical',
	'restore-root-owner',
	'restore-root-mode',
	'restore-root-ancestor-unsafe',
	'restore-root-not-writable',
	'restore-root-unavailable',
] as const;

export const restorePolicyErrorCodes = [
	'restore-policy-not-protected',
	'restore-policy-invalid',
	'restore-policy-agent-mismatch',
	'restore-policy-unavailable',
	'restore-policy-linux-required',
] as const;

const hasControl = (value: string) =>
	Array.from(value).some(
		character => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f
	);

/** Canonical absolute Linux directory, as the Agent's validateSourcePaths requires. */
export function isCanonicalLinuxDirectory(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.startsWith('/') &&
		!value.startsWith('//') &&
		(value === '/' || !value.endsWith('/')) &&
		value.length <= 1024 &&
		!hasControl(value) &&
		!/[\\,]/.test(value) &&
		!value.split('/').some(part => part === '.' || part === '..') &&
		path.posix.normalize(value) === value
	);
}

export const restoreAccessReportSchema = z
	.object({
		version: z.literal(1),
		roots: z
			.array(
				z
					.object({
						path: z.string().refine(isCanonicalLinuxDirectory),
						status: z.enum(['writable', 'unavailable', 'rejected']),
						code: z.enum(restoreRootCodes).optional(),
						availableBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
						availableInodes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
					})
					.strict()
			)
			.max(MAX_RESTORE_ROOTS)
			.refine(roots => new Set(roots.map(root => root.path)).size === roots.length),
		policyError: z.enum(restorePolicyErrorCodes).optional(),
	})
	.strict();

export type RestoreAccessReport = z.infer<typeof restoreAccessReportSchema>;

/** Agent 0.9.0 introduced RESTORE_FILESYSTEM payload version 1. */
export function supportsAgentHostRestoreVersion(version: string): boolean {
	const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
	if (!match) return false;
	const [major, minor] = match.slice(1).map(Number);
	return major > 0 || minor >= 9;
}

export type AgentHostRestoreUnsupportedReason =
	| 'agent-missing'
	| 'agent-revoked'
	| 'agent-version'
	| 'capability-missing'
	| 'restore-policy-error'
	| 'no-writable-root';

type AgentLike = {
	agentVersion: string;
	capabilities: Record<string, unknown> | null | undefined;
	revokedAt?: Date | null;
} | null;

/** Capability, command type and version: an older Agent would never acknowledge the command. */
export function agentHostRestoreCapability(agent: AgentLike):
	| { supported: true }
	| { supported: false; reason: AgentHostRestoreUnsupportedReason } {
	if (!agent) return { supported: false, reason: 'agent-missing' };
	if (agent.revokedAt) return { supported: false, reason: 'agent-revoked' };
	if (!supportsAgentHostRestoreVersion(agent.agentVersion))
		return { supported: false, reason: 'agent-version' };
	const capabilities = agent.capabilities || {};
	const commandTypes = Array.isArray(capabilities.commandTypes) ? capabilities.commandTypes : [];
	if (
		capabilities.restoreFilesystemVersion !== 1 ||
		!commandTypes.includes('RESTORE_FILESYSTEM')
	)
		return { supported: false, reason: 'capability-missing' };
	return { supported: true };
}

/** The last heartbeat's report, stored beside the capabilities. Invalid data offers nothing. */
export function storedRestoreAccess(
	capabilities: Record<string, unknown> | null | undefined
): RestoreAccessReport | undefined {
	const parsed = restoreAccessReportSchema.safeParse(capabilities?.restoreAccess);
	return parsed.success ? parsed.data : undefined;
}

export function writableRestoreRoots(
	capabilities: Record<string, unknown> | null | undefined
): RestoreAccessReport['roots'] {
	const report = storedRestoreAccess(capabilities);
	if (!report || report.policyError) return [];
	return report.roots.filter(root => root.status === 'writable');
}

export function isAgentHostRestoreName(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		AGENT_HOST_RESTORE_NAME.test(value) &&
		!value.endsWith(AGENT_HOST_RESTORE_PARTIAL_SUFFIX)
	);
}

/** Exact absolute snapshot path: Restic reads --include/--exclude as patterns. */
export function isAgentHostSelectionPath(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.startsWith('/') &&
		value !== '/' &&
		value.length <= 4096 &&
		!value.endsWith('/') &&
		!value.includes('//') &&
		!hasControl(value) &&
		!/[*?[\]\\]/.test(value) &&
		!value
			.slice(1)
			.split('/')
			.some(part => part === '' || part === '.' || part === '..')
	);
}

export type AgentHostSelection = { includes: string[]; excludes: string[] };

/** Same rules as the Agent parser; returns a closed reason instead of throwing. */
export function agentHostSelectionProblem(selection: AgentHostSelection): string | undefined {
	const { includes, excludes } = selection;
	if (
		!Array.isArray(includes) ||
		!Array.isArray(excludes) ||
		includes.length > MAX_AGENT_HOST_SELECTION ||
		excludes.length > MAX_AGENT_HOST_SELECTION
	)
		return 'The selection is too large.';
	if (![...includes, ...excludes].every(isAgentHostSelectionPath))
		return 'Select exact absolute snapshot paths without wildcard characters.';
	if (new Set(includes).size !== includes.length || new Set(excludes).size !== excludes.length)
		return 'The selection repeats a path.';
	if (includes.length && excludes.length)
		return 'Agent host restore restores either selected items or everything except excluded items, not both. Select only the items to restore.';
	if ([...includes, ...excludes].reduce((sum, entry) => sum + entry.length, 0) > MAX_AGENT_HOST_SELECTION_CHARACTERS)
		return 'The selection is too large.';
	const within = (parent: string, child: string) =>
		child === parent || child.startsWith(`${parent}/`);
	if (includes.some(entry => includes.some(other => other !== entry && within(other, entry))))
		return 'The selection contains an item inside another selected item.';
	return undefined;
}

/** `<hostname>-<yyyymmdd>-<first 8 of the restore ID>`, reduced to the safe alphabet. */
export function suggestedAgentHostRestoreName(hostname: string, restoreId: string, now: Date): string {
	const host =
		hostname
			.toLowerCase()
			.replace(/[^a-z0-9.-]+/g, '-')
			.replace(/^[^a-z0-9]+/, '')
			.slice(0, 63) || 'agent';
	const date = now.toISOString().slice(0, 10).replace(/-/g, '');
	return `${host}-${date}-${restoreId.slice(0, 8)}`.slice(0, 100);
}

export const restoreStageSchema = z.enum([
	'preparing-restore',
	'checking-repository',
	'checking-space',
	'restoring',
	'verifying',
	'finalizing',
]);

export const restoreFailureStageSchema = z.enum([
	'command-status-check',
	'payload-validation',
	'restore-policy',
	'target-creation',
	'tool-validation',
	'sftp-password-obscure',
	'temporary-storage-config',
	'repository-check',
	'snapshot-validation',
	'space-check',
	'restic-restore',
	'artifact-verification',
	'finalize',
	'cleanup',
]);

export const restoreFailureCodeSchema = z.enum([
	'command-lease-unavailable',
	'command-authorization-rejected',
	'control-plane-rate-limited',
	'control-plane-unavailable',
	'control-plane-timeout',
	'control-plane-network-failed',
	'control-plane-response-invalid',
	'control-plane-unexpected',
	'invalid-payload',
	'restore-policy-invalid',
	'restore-root-not-approved',
	'restore-root-unsafe',
	'restore-root-overlap',
	'restore-target-exists',
	'restore-target-failed',
	'tool-unavailable',
	'sftp-password-obscure-failed',
	'temporary-config-failed',
	'repository-check-failed',
	'target-check-access-failed',
	'target-check-auth-failed',
	'target-check-transport-failed',
	'restore-snapshot-mismatch',
	'restore-selection-missing',
	'restore-insufficient-space',
	'restic-restore-failed',
	'restore-verification-failed',
	'restore-finalize-failed',
	'cleanup-failed',
	'cancelled',
	'unexpected',
]);

/** Operator advice per closed code; never contains provider output. */
export function agentHostRestoreFailureAdvice(code: string | undefined): string {
	switch (code) {
		case 'restore-target-exists':
			return 'The folder or its .partial copy already exists on the host. Review or remove it, then start a new restore with another folder name.';
		case 'restore-root-not-approved':
		case 'restore-root-unsafe':
		case 'restore-root-overlap':
		case 'restore-policy-invalid':
			return 'The host administrator must approve a safe restore root with "pluton-agent restore-roots approve".';
		case 'restore-insufficient-space':
			return 'The restore root does not have enough free space or inodes for the selection.';
		case 'restore-selection-missing':
			return 'A selected path is not in the snapshot.';
		case 'restore-snapshot-mismatch':
			return 'The snapshot in the repository does not match this backup.';
		case 'restore-verification-failed':
		case 'restic-restore-failed':
		case 'restore-finalize-failed':
			return 'A partial folder ending in .partial may remain on the host; review and remove it.';
		case 'target-check-auth-failed':
		case 'target-check-access-failed':
		case 'target-check-transport-failed':
		case 'repository-check-failed':
			return 'The Agent could not read the repository from its host.';
		default:
			return 'See the Agent log on the host for the stage.';
	}
}

import path from 'path';
import { AppError } from '../AppError';
import { managedSnapshotPath } from '../managedSnapshotPath';

export type ManagedExportMode = 'full' | 'regular-files';
export const MANAGED_EXPORT_LIMITS = Object.freeze({ maxProofBytes: 128 * 1024 ** 2 });
export type ManagedExportBinding = { backupId: string; repositoryId: string; snapshotId: string };
export type ManagedExportCounts = Record<string, number>;
export type ManagedExportEntry = {
	path: string;
	type: 'file' | 'dir' | 'symlink';
	size: number;
	sha256?: string;
	linkTarget?: string;
	/** Canonical, allowlisted TAR metadata, never a host filesystem path. */
	metadata: string;
};
export type ManagedExportSummary = {
	version: 1;
	binding: ManagedExportBinding;
	mode: ManagedExportMode;
	includedEntries: number;
	excludedEntries: number;
	includedByType: ManagedExportCounts;
	excludedByType: ManagedExportCounts;
	manifestSha256: string;
	archiveSha256: string;
	archiveBytes: number;
};
export type ManagedExportFailure =
	| 'invalid-export-mode'
	| 'unsupported-node-type'
	| 'unsafe-link-target'
	| 'symlink-graph-limit'
	| 'tar-invalid'
	| 'tar-extension-unsupported'
	| 'tar-metadata-limit'
	| 'archive-incomplete'
	| 'archive-entry-mismatch'
	| 'archive-content-mismatch'
	| 'export-resource-limit'
	| 'export-proof-missing'
	| 'posix-restore-required';
const messages: Record<ManagedExportFailure, string> = {
	'invalid-export-mode': 'Choose Full Download or Download Regular Files Only.',
	'unsupported-node-type':
		'Full Download and Restore refuse special filesystem nodes. Download Regular Files Only is an explicitly partial alternative.',
	'unsafe-link-target':
		'Full Download and Restore support relative symbolic links contained within the staged snapshot only. Absolute or escaping targets were refused; no entries were silently omitted.',
	'symlink-graph-limit': 'The symbolic-link graph exceeds the supported bounded validation limits.',
	'tar-invalid': 'The snapshot archive is malformed or truncated. No complete export was verified.',
	'tar-extension-unsupported': 'The archive uses unsupported or ambiguous TAR extension metadata.',
	'tar-metadata-limit': 'Archive metadata exceeds the bounded validation limits.',
	'archive-incomplete':
		'The archive does not contain every entry required by the selected export mode.',
	'archive-entry-mismatch': 'An archive entry does not match the exact snapshot index.',
	'archive-content-mismatch': 'Archive content or metadata changed from the verified preparation.',
	'export-resource-limit': 'Export verification exceeded the bounded metadata cache capacity.',
	'export-proof-missing':
		'Export verification expired. Prepare this exact snapshot and mode again.',
	'posix-restore-required':
		'Symbolic-link reconstruction requires an isolated Linux or POSIX staging destination.',
};
export class ManagedExportError extends AppError {
	readonly code = 'managed-export-refused';
	constructor(readonly reason: ManagedExportFailure) {
		super(reason === 'invalid-export-mode' ? 400 : 409, messages[reason]);
		Object.setPrototypeOf(this, new.target.prototype);
	}
}
export function managedExportMode(value: unknown = 'full'): ManagedExportMode {
	if (value !== 'full' && value !== 'regular-files')
		throw new ManagedExportError('invalid-export-mode');
	return value;
}
export const exportIncludes = (mode: ManagedExportMode, type: string) =>
	type === 'file' || type === 'dir' || (mode === 'full' && type === 'symlink');

/** Validate target TEXT only. Never stat, open, realpath or otherwise follow it. */
export function assertManagedLinkTarget(linkPath: string, target: string): void {
	managedSnapshotPath(linkPath);
	if (
		!target ||
		Buffer.byteLength(target) > 4096 ||
		target.startsWith('/') ||
		target.includes('\\') ||
		target.includes('\uFFFD') ||
		[...target].some(value => value.charCodeAt(0) <= 31 || value.charCodeAt(0) === 127)
	)
		throw new ManagedExportError('unsafe-link-target');
	const resolved = path.posix.join(path.posix.dirname(linkPath).slice(1), target);
	if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/'))
		throw new ManagedExportError('unsafe-link-target');
}

/** Account for symlinks in a target's parent components using stored metadata.
 * Harmless cycles/broken internal targets remain metadata; no dereference occurs. */
export function assertManagedLinkGraph(
	link: ManagedExportEntry,
	get: (value: string) => ManagedExportEntry | undefined
) {
	const pending = [
		...path.posix.dirname(link.path).split('/').filter(Boolean),
		...link.linkTarget!.split('/'),
	];
	const resolved: string[] = [];
	const seen = new Set<string>();
	let followed = 0,
		steps = 0;
	while (pending.length) {
		if (++steps > 4096) throw new ManagedExportError('symlink-graph-limit');
		const part = pending.shift()!;
		if (!part || part === '.') continue;
		if (part === '..') {
			if (!resolved.length) throw new ManagedExportError('unsafe-link-target');
			resolved.pop();
			continue;
		}
		resolved.push(part);
		const entry = get('/' + resolved.join('/'));
		if (entry?.type !== 'symlink') continue;
		const state = JSON.stringify([entry.path, pending]);
		if (seen.has(state)) return; // a closed cycle, not permission to traverse it
		seen.add(state);
		if (++followed > 40) throw new ManagedExportError('symlink-graph-limit');
		assertManagedLinkTarget(entry.path, entry.linkTarget!);
		resolved.pop();
		pending.unshift(...entry.linkTarget!.split('/'));
	}
}

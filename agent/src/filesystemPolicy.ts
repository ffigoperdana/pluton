import path from 'node:path';
import { realpath } from 'node:fs/promises';

function rejectUnsafePath(value: string): void {
	if (!value || value.includes('\0') || /[\x00-\x1f\x7f]/.test(value)) {
		throw new Error('Path contains an unsafe character.');
	}
	if (value.split(/[\\/]+/).includes('..')) {
		throw new Error('Path traversal is not allowed.');
	}
}

export async function resolveAllowedRoots(roots: string[]): Promise<string[]> {
	const resolved = await Promise.all(
		roots.map(async root => {
			rejectUnsafePath(root);
			if (!path.isAbsolute(root)) throw new Error('Allowed roots must be absolute paths.');
			return realpath(root);
		})
	);
	return [...new Set(resolved)];
}

/**
 * Realpath containment intentionally rejects traversal, sibling-prefix tricks,
 * and symlink escapes. It is a future command boundary; no file command exists
 * in this Phase 4 foundation.
 */
export async function assertPathWithinAllowedRoots(candidate: string, roots: string[]): Promise<string> {
	rejectUnsafePath(candidate);
	if (!path.isAbsolute(candidate)) throw new Error('Path must be absolute.');
	const resolvedRoots = await resolveAllowedRoots(roots);
	const resolvedCandidate = await realpath(candidate);
	const permitted = resolvedRoots.some(root => {
		const relative = path.relative(root, resolvedCandidate);
		return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
	});
	if (!permitted) throw new Error('Path is outside the configured allowed roots.');
	return resolvedCandidate;
}

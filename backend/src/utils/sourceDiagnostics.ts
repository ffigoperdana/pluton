import { z } from 'zod';

/** Keep in sync with the independent Agent's sourceDiagnostics contract. Reject
 * unsafe names instead of truncating them into misleading filenames. */
export function safeDiagnosticRelativePath(value: string): boolean {
	return (
		value === '.' ||
		Boolean(
			value &&
				value.length <= 512 &&
				!/\p{M}{4,}/u.test(value) &&
				/^[\p{L}\p{N}\p{M} ._+@()[\]{}!#$%&',;~/-]+$/u.test(value) &&
				!value.startsWith('/') &&
				!value.split('/').some(part => !part || part === '.' || part === '..') &&
				!/(?:password|token|secret|credential|key)\s*=|-----BEGIN|:\/\//i.test(value)
		)
	);
}

export const sourceDiagnosticsSchema = z
	.object({
		version: z.literal(1),
		origin: z.enum(['preflight', 'restic']),
		problemCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		countIsLowerBound: z.boolean(),
		entries: z
			.array(
				z
					.object({
						relativePath: z.string().max(512).refine(safeDiagnosticRelativePath).optional(),
						entryType: z.enum(['file', 'directory', 'symlink', 'other', 'unknown']),
						errno: z.enum(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'ELOOP', 'UNKNOWN']),
						excluded: z.literal(false),
					})
					.strict()
			)
			.min(1)
			.max(20),
	})
	.strict()
	.refine(report => report.problemCount >= report.entries.length);

export type SourceDiagnostics = z.infer<typeof sourceDiagnosticsSchema>;
export type SourceFailure = {
	failureStage: string;
	failureCode: string;
	sourceDiagnostics?: SourceDiagnostics;
};

/** An explicit signed opt-in avoids sending new completion fields to old servers
 * whose 0.7.0 schemas reject unknown keys. No inventory capability is added. */
export function supportsSourceDiagnostics(version: string): boolean {
	const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) return false;
	const [major, minor, patch] = match.slice(1).map(Number);
	return major > 0 || minor > 7 || (minor === 7 && patch >= 1);
}

import path from 'node:path';
import { z } from 'zod';
import type { SourceAccessReport } from '../types/agentSourceAccess';

export const SOURCE_ACCESS_MAX_ROOTS = 32;
export const SOURCE_ACCESS_MAX_PATH_LENGTH = 1024;
export const sourceAccessIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
export const sourceAccessCodeSchema = z
	.string()
	.regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
	.max(96);

export function isSafeSourceAccessPath(value: string): boolean {
	return (
		value.startsWith('/') &&
		value.length <= SOURCE_ACCESS_MAX_PATH_LENGTH &&
		!value.includes('\\') &&
		!value.includes(',') &&
		!value.includes('//') &&
		(value === '/' || !value.endsWith('/')) &&
		![...value].some(
			character => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f
		) &&
		!value.split('/').some(part => part === '..' || part === '.')
	);
}

export function sourcePathWithin(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(root === '/' ? '/' : `${root}/`);
}

export function isCanonicalSourcePath(value: string): boolean {
	return isSafeSourceAccessPath(value) && path.posix.normalize(value) === value;
}

const deniedExactRoots = new Set([
	'/',
	'/home',
	'/srv',
	'/var',
	'/var/www',
	'/opt',
	'/mnt',
	'/media',
	'/run',
	'/usr',
	'/usr/local',
	'/usr/share',
	'/usr/lib',
	'/bin',
	'/sbin',
	'/lib',
	'/lib64',
	'/var/lib',
	'/var/log',
	'/var/cache',
	'/tmp',
	'/var/tmp',
	'/run/user',
	'/lost+found',
]);
const deniedSubtrees = [
	'/etc',
	'/proc',
	'/sys',
	'/dev',
	'/boot',
	'/root',
	'/var/lib/pluton-agent',
	'/var/lib/pluton-agent-upgrades',
	'/opt/pluton-agent',
];

/** Existing host-approved static roots remain usable; a new request cannot broaden into these locations. */
export function isNewSourceRootAllowed(value: string): boolean {
	return (
		!deniedExactRoots.has(value) && !deniedSubtrees.some(root => sourcePathWithin(root, value))
	);
}

export function sourcePathContainsPrivateDirectory(value: string): boolean {
	return value.split('/').some(part => ['.ssh', '.aws', '.gnupg', '.kube'].includes(part));
}

export const sourceAccessPathSchema = z
	.string()
	.min(1)
	.max(SOURCE_ACCESS_MAX_PATH_LENGTH)
	.refine(isSafeSourceAccessPath);
const canonicalPathSchema = sourceAccessPathSchema.refine(isCanonicalSourcePath);
const canonicalRootsSchema = z
	.array(canonicalPathSchema)
	.max(SOURCE_ACCESS_MAX_ROOTS)
	.refine(roots => new Set(roots).size === roots.length);

export const sourceAccessReportSchema = z
	.object({
		version: z.literal(1),
		authorizationMode: z.enum(['host-approved', 'server-managed']).optional(),
		delegatedRoots: canonicalRootsSchema.optional(),
		lastModeSetupRequestId: sourceAccessIdSchema.optional(),
		hostPolicyRevision: z.string().regex(/^[a-f0-9]{64}$/),
		effectiveVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		approvedRoots: canonicalRootsSchema,
		effectiveRoots: canonicalRootsSchema,
		rootStatuses: z
			.array(
				z
					.object({
						path: canonicalPathSchema,
						status: z.enum(['readable', 'unreadable', 'missing', 'rejected']),
						code: sourceAccessCodeSchema.optional(),
					})
					.strict()
			)
			.max(SOURCE_ACCESS_MAX_ROOTS),
		lastAppliedRequestId: sourceAccessIdSchema.optional(),
		policyError: sourceAccessCodeSchema.optional(),
	})
	.strict()
	.refine(
		report =>
			(report.authorizationMode === 'server-managed' || !report.delegatedRoots?.length) &&
			new Set([...report.approvedRoots, ...(report.delegatedRoots || [])]).size <=
				SOURCE_ACCESS_MAX_ROOTS &&
			report.effectiveRoots.every(root =>
				[
					...report.approvedRoots,
					...(report.authorizationMode === 'server-managed' ? report.delegatedRoots || [] : []),
				].some(approved => sourcePathWithin(approved, root))
			) &&
			report.effectiveRoots.every(root =>
				report.rootStatuses.some(status => status.path === root && status.status === 'readable')
			) &&
			new Set(report.rootStatuses.map(root => root.path)).size === report.rootStatuses.length
	);

export const sourceAccessValidationSchema = z
	.array(
		z
			.object({
				requestedPath: sourceAccessPathSchema,
				canonicalPath: canonicalPathSchema.optional(),
				status: z.enum(['approved', 'pending-host-approval', 'rejected']),
				code: sourceAccessCodeSchema.optional(),
			})
			.strict()
			.refine(item => item.status === 'rejected' || !!item.canonicalPath)
	)
	.max(SOURCE_ACCESS_MAX_ROOTS);

export const sourceAccessResultSchema = z
	.object({
		sourceAccess: sourceAccessReportSchema,
		validation: sourceAccessValidationSchema.optional(),
		modeSetup: z
			.object({
				requestId: sourceAccessIdSchema,
				authorizationMode: z.enum(['host-approved', 'server-managed']),
				delegatedRoots: canonicalRootsSchema,
				expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
			})
			.strict()
			.optional(),
	})
	.strict();

export const sourceAccessModeSetupSchema = z
	.object({
		expectedVersion: z
			.number()
			.int()
			.nonnegative()
			.max(Number.MAX_SAFE_INTEGER - 1),
		expectedHostPolicyRevision: z.string().regex(/^[a-f0-9]{64}$/),
		authorizationMode: z.enum(['host-approved', 'server-managed']),
		roots: canonicalRootsSchema,
		confirmedAffectedPlanIds: z
			.array(sourceAccessIdSchema)
			.max(500)
			.refine(ids => new Set(ids).size === ids.length),
	})
	.strict()
	.refine(input =>
		input.authorizationMode === 'server-managed' ? input.roots.length > 0 : input.roots.length === 0
	);

export const sourceAccessRequestSchema = z
	.object({
		expectedVersion: z
			.number()
			.int()
			.nonnegative()
			.max(Number.MAX_SAFE_INTEGER - 1),
		expectedHostPolicyRevision: z.string().regex(/^[a-f0-9]{64}$/),
		roots: z
			.array(sourceAccessPathSchema)
			.max(SOURCE_ACCESS_MAX_ROOTS)
			.refine(roots => new Set(roots).size === roots.length),
		confirmedAffectedPlanIds: z
			.array(sourceAccessIdSchema)
			.max(500)
			.refine(ids => new Set(ids).size === ids.length)
			.optional(),
	})
	.strict();

export function sameSourceRoots(left: string[], right: string[]): boolean {
	const sortedRight = [...right].sort();
	return (
		left.length === right.length &&
		[...left].sort().every((root, index) => root === sortedRight[index])
	);
}

export function hasOverlappingSourceRoots(roots: string[]): boolean {
	return roots.some((root, index) =>
		roots.some((other, otherIndex) => index !== otherIndex && sourcePathWithin(root, other))
	);
}

export function sourceReportHealthy(report: SourceAccessReport): boolean {
	return (
		!report.policyError &&
		report.effectiveRoots.every(
			root =>
				!report.rootStatuses.some(status => status.path === root && status.status !== 'readable')
		)
	);
}

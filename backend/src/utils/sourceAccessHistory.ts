import { z } from 'zod';
import type { AgentSourceAccessRequest } from '../db/schema/agentSourceAccess';
import type { SourceAccessRequest } from '../types/agentSourceAccess';
import { AppError } from './AppError';

const statuses = [
	'queued',
	'validating',
	'validated',
	'pending-host-approval',
	'pending-host-setup',
	'applied',
	'rejected',
	'cancelled',
] as const;
const kinds = ['validate', 'apply', 'mode-setup'] as const;
const cursorSchema = z
	.object({
		version: z.literal(1),
		ceiling: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		before: z
			.object({
				time: z.number().int().min(0).max(8640000000000000),
				id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
			})
			.strict()
			.optional(),
	})
	.strict();
export type SourceHistoryCursor = z.infer<typeof cursorSchema>;
const querySchema = z
	.object({
		limit: z
			.string()
			.regex(/^\d{1,2}$/)
			.transform(Number)
			.pipe(z.number().int().min(1).max(50))
			.optional(),
		cursor: z
			.string()
			.min(1)
			.max(1024)
			.regex(/^[A-Za-z0-9_-]+$/)
			.optional(),
		status: z.enum(statuses).optional(),
		kind: z.enum(kinds).optional(),
	})
	.strict();

export function parseSourceHistoryQuery(input: unknown) {
	const query = querySchema.safeParse(input);
	if (!query.success)
		throw new AppError(400, 'Invalid Source Access history pagination or filter.');
	let cursor: SourceHistoryCursor | undefined;
	if (query.data.cursor) {
		try {
			const bytes = Buffer.from(query.data.cursor, 'base64url');
			if (bytes.toString('base64url') !== query.data.cursor) throw new Error();
			cursor = cursorSchema.parse(JSON.parse(bytes.toString('utf8')));
		} catch {
			throw new AppError(400, 'Invalid Source Access history cursor. Refresh history.');
		}
	}
	return {
		limit: query.data.limit ?? 10,
		status: query.data.status,
		kind: query.data.kind,
		cursor,
	};
}

export function sourceHistoryCursor(cursor: SourceHistoryCursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

/** Explicit public audit projection. Never return command payloads, signatures or lease tokens. */
export function publicSourceAccessRequest(request: AgentSourceAccessRequest): SourceAccessRequest {
	return {
		id: request.id,
		requestId: request.id,
		kind: request.kind,
		...(request.requestedMode ? { requestedMode: request.requestedMode } : {}),
		...(request.setupExpiresAt ? { setupExpiresAt: request.setupExpiresAt } : {}),
		status: request.status,
		roots: request.roots,
		expectedVersion: request.expectedVersion,
		expectedHostPolicyRevision: request.expectedHostPolicyRevision,
		...(request.validation ? { validation: request.validation } : {}),
		...(request.resultCode ? { resultCode: request.resultCode } : {}),
		createdAt: request.createdAt,
		completedAt: request.completedAt,
	};
}

import { z } from 'zod';

export const scopes = [
	'plans:read',
	'agents:read',
	'backups:read',
	'storages:read',
	'replication:read',
	'recovery:read',
] as const;
const noControls = (value: string) =>
	![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
export const resourceId = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9_-]+$/);
export const pageInput = z
	.object({
		limit: z.coerce.number().int().min(1).max(50).default(20),
		offset: z.coerce.number().int().min(0).max(10000).default(0),
	})
	.strict();
export const grantInput = z
	.object({
		name: z.string().trim().min(1).max(80),
		clientType: z.enum(['Claude', 'Codex', 'Grok', 'Custom']),
		subject: z.string().min(1).max(256).refine(noControls),
		oauthClientId: z.string().min(1).max(512).refine(noControls),
		scopes: z.array(z.enum(scopes)).min(1).max(scopes.length),
		planIds: z.array(resourceId).max(100),
		agentIds: z.array(resourceId).max(100),
		storageIds: z.array(resourceId).max(100),
		expiresAt: z.number().int().positive().nullable(),
	})
	.strict();
export type GrantInput = z.infer<typeof grantInput>;
export type Grant = GrantInput & {
	id: string;
	createdAt: number;
	revokedAt: number | null;
	lastUsedAt: number | null;
};
export type Principal = { grant: Grant; tokenScopes: string[]; expiresAt: number };
export class McpFault extends Error {
	constructor(
		public status: number,
		public code: string
	) {
		super(code);
	}
}
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
	const result = schema.safeParse(value);
	if (!result.success) throw new McpFault(400, 'invalid_request');
	return result.data;
}

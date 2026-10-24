import { z } from 'zod';
import { pageInput, resourceId } from './contracts';
import { toolCatalog } from './OperationalReadService';

export const actionNames = [
	'backup_now',
	'pause_plan',
	'resume_plan',
	'cancel_backup',
	'create_plan',
	'update_plan',
	'update_schedule',
	'update_exclusions',
	'recovery_test',
] as const;
export const writeToolNames = actionNames.map(action => `pluton_request_${action}`);
export const tokenToolNames = [...toolCatalog.map(tool => tool.name), ...writeToolNames] as [
	string,
	...string[],
];
export const tokenInput = z
	.object({
		name: z.string().trim().min(1).max(80),
		purpose: z.string().trim().max(240).default(''),
		mode: z.enum(['read', 'write', 'read_write']),
		tools: z.array(z.enum(tokenToolNames)).min(1).max(32),
		planIds: z.array(resourceId).max(100),
		agentIds: z.array(resourceId).max(100),
		storageIds: z.array(resourceId).max(100),
		ttlHours: z.number().int().min(1).max(2160).default(168),
		approvalPolicy: z.literal('always').default('always'),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (
			value.tools.some(name =>
				value.mode === 'read'
					? name.startsWith('pluton_request_')
					: value.mode === 'write'
						? !name.startsWith('pluton_request_')
						: false
			)
		)
			ctx.addIssue({ code: 'custom', message: 'Tool does not match permission mode.' });
	});
export type TokenInput = z.infer<typeof tokenInput>;
export type NativeToken = Omit<TokenInput, 'ttlHours'> & {
	id: string;
	issuer: string;
	createdAt: number;
	expiresAt: number;
	lastUsedAt: number | null;
	revokedAt: number | null;
	disabled: boolean;
	revision: number;
};
const interval = z
	.object({
		type: z.enum(['hourly', 'daily', 'weekly', 'monthly', 'days', 'hours', 'minutes']),
		time: z.string().max(10).optional(),
		days: z.string().max(100).optional(),
		hours: z.string().max(10).optional(),
		minutes: z.number().int().min(1).max(59).optional(),
		timeZone: z.string().min(1).max(100),
	})
	.strict();
const requestBase = {
	planId: resourceId,
	idempotencyKey: z
		.string()
		.min(16)
		.max(80)
		.regex(/^[A-Za-z0-9_-]+$/),
};
export const actionSchemas = {
	backup_now: z.object(requestBase).strict(),
	pause_plan: z.object(requestBase).strict(),
	resume_plan: z.object(requestBase).strict(),
	cancel_backup: z.object({ ...requestBase, backupId: resourceId }).strict(),
	create_plan: z.object({ ...requestBase, title: z.string().trim().min(1).max(80) }).strict(),
	update_plan: z.object({ ...requestBase, title: z.string().trim().min(1).max(80) }).strict(),
	update_schedule: z.object({ ...requestBase, interval }).strict(),
	update_exclusions: z
		.object({ ...requestBase, exclusions: z.array(z.string().min(1).max(512)).max(100) })
		.strict(),
	recovery_test: z.object({ ...requestBase, backupId: resourceId }).strict(),
};
export type ActionName = keyof typeof actionSchemas;
export type ActionArgs = {
	planId: string;
	idempotencyKey: string;
	backupId?: string;
	title?: string;
	interval?: z.infer<typeof interval>;
	exclusions?: string[];
};
export const actionStatusInput = z.object({ id: resourceId }).strict();
export const actionListInput = pageInput;

import Cryptr from 'cryptr';
import { z } from 'zod';
import { AppError } from './AppError';
import type { PlanBackupSettings } from '../types/plans';
import type { RemoteBackupLifecycle } from '../types/remoteLifecycle';

const hookSchema = z
	.object({
		id: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/),
		args: z
			.array(
				z
					.string()
					.max(128)
					.regex(/^[A-Za-z0-9_.,:@/+ =-]*$/)
					.refine(
						arg => !arg.startsWith('-') && !arg.startsWith('/') && !arg.split('/').includes('..')
					)
			)
			.max(16),
		timeoutSeconds: z.number().int().min(1).max(300),
	})
	.strict();

export const remoteLifecycleSchema = z
	.object({
		version: z.literal(1),
		database: z
			.object({
				engine: z.enum(['mysql', 'mariadb']),
				host: z
					.string()
					.max(253)
					.regex(/^(?:[A-Za-z0-9][A-Za-z0-9.:-]*|::1)$/),
				port: z.number().int().min(1).max(65535),
				tls: z.enum(['verify-identity', 'local']),
				database: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/),
				username: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/),
				dumpFilename: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,95}\.sql$/),
				timeoutSeconds: z.number().int().min(1).max(3600),
				maxDumpBytes: z
					.number()
					.int()
					.min(1024)
					.max(100 * 1024 ** 3),
				includeRoutines: z.boolean(),
				includeEvents: z.boolean(),
				password: z
					.string()
					.min(1)
					.max(1024)
					.refine(value => !value.includes('\0'))
					.optional(),
				passwordConfigured: z.boolean().optional(),
			})
			.strict()
			.refine(db => db.tls !== 'local' || ['localhost', '127.0.0.1', '::1'].includes(db.host))
			.optional(),
		preHook: hookSchema.optional(),
		postHook: hookSchema.optional(),
	})
	.strict();

/** Never expose zod input/error text: a failed field may contain a credential. */
export function parseRemoteLifecycle(value: unknown): RemoteBackupLifecycle {
	const parsed = remoteLifecycleSchema.safeParse(value);
	if (!parsed.success) throw new AppError(400, 'Remote backup lifecycle configuration is invalid.');
	return parsed.data;
}

/** Credentials live in a separate table, never in plan JSON or API responses. */
export function prepareRemoteLifecycleSettings(
	settings: PlanBackupSettings,
	existingCredential: string | null,
	secret: string
): { settings: PlanBackupSettings; credential?: string | null } {
	if (settings.remoteLifecycle === undefined) return { settings };
	const lifecycle = parseRemoteLifecycle(settings.remoteLifecycle);
	if (!lifecycle.database && !lifecycle.preHook && !lifecycle.postHook) {
		return { settings: { ...settings, remoteLifecycle: undefined }, credential: null };
	}
	let credential: string | null = null;
	if (lifecycle.database) {
		const { password, passwordConfigured: _ignored, ...database } = lifecycle.database;
		credential = password === undefined ? existingCredential : new Cryptr(secret).encrypt(password);
		if (!credential)
			throw new AppError(400, 'A database password is required when enabling database backup.');
		lifecycle.database = { ...database, passwordConfigured: true };
	}
	return { settings: { ...settings, remoteLifecycle: lifecycle }, credential };
}

export function materializeRemoteLifecycle(
	value: unknown,
	credential: string | null,
	secret: string
): RemoteBackupLifecycle {
	const lifecycle = parseRemoteLifecycle(value);
	if (!lifecycle.database) return lifecycle;
	if (lifecycle.database.password !== undefined || !credential) {
		throw new AppError(500, 'Database backup credentials could not be prepared.');
	}
	try {
		const { passwordConfigured: _ignored, ...database } = lifecycle.database;
		const password = new Cryptr(secret).decrypt(credential);
		return parseRemoteLifecycle({ ...lifecycle, database: { ...database, password } });
	} catch {
		throw new AppError(500, 'Database backup credentials could not be prepared.');
	}
}

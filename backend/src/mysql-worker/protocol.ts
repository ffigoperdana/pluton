import { z } from 'zod';
import type { Socket } from 'net';
import { recoveryTargetSchema } from '../utils/recoveryTestPolicy';
import { RecoveryTestError } from '../utils/recoveryValidation';

export const SOCKET = '/run/pluton-mysql-worker/worker.sock';
export const FRAME_LIMIT = 96 * 1024;
export const CHUNK_BYTES = 32 * 1024;
export const DEADLINE_MS = 75 * 60_000;
const id = z.string().regex(/^[a-f0-9]{24}$/);
const database = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/);
export const leaseSchema = z
	.object({
		id,
		testId: id,
		targetId: id,
		database,
		ownerToken: z.string().regex(/^[a-f0-9]{48}$/),
	})
	.strict();
const target = recoveryTargetSchema.safeExtend({
	engine: z.literal('mysql'),
	tls: z.literal('verify-identity'),
	password: recoveryTargetSchema.shape.password.unwrap(),
});
export const requestSchema = z.discriminatedUnion('operation', [
	z
		.object({
			version: z.literal(1),
			operation: z.literal('import'),
			target,
			testId: id,
			targetId: id,
			entry: z
				.object({
					engine: z.literal('mysql'),
					database,
					bytes: z
						.number()
						.int()
						.positive()
						.max(100 * 1024 ** 3),
					sha256: z.string().regex(/^[a-f0-9]{64}$/),
				})
				.strict(),
			allowedDatabases: z.array(database).min(1).max(8),
			leases: z.array(leaseSchema).max(8),
		})
		.strict(),
	z
		.object({ version: z.literal(1), operation: z.literal('cleanup'), target, lease: leaseSchema })
		.strict(),
]);
export type WorkerRequest = z.infer<typeof requestSchema>;
export const workerConfigSchema = z
	.object({
		host: recoveryTargetSchema.shape.host,
		port: recoveryTargetSchema.shape.port,
		username: recoveryTargetSchema.shape.username,
		databases: z.array(database).min(1).max(8),
		maxArtifactBytes: z
			.number()
			.int()
			.positive()
			.max(100 * 1024 ** 3),
	})
	.strict();
export type WorkerConfig = z.infer<typeof workerConfigSchema>;
export const stages = [
	'database-artifact-validation',
	'database-target-preflight',
	'database-import',
	'database-import-validation',
	'database-cleanup',
] as const;
export const codes = [
	'cancelled',
	'database-client-missing',
	'database-client-incompatible',
	'database-tls-failed',
	'database-authentication-failed',
	'database-target-unavailable',
	'database-import-failed',
	'database-import-timeout',
	'database-import-validation-failed',
	'database-output-limit',
	'database-already-exists',
	'recovery-target-unsafe',
	'recovery-target-not-configured',
	'database-cleanup-failed',
	'database-artifact-size-mismatch',
	'database-artifact-hash-mismatch',
	'mysql-worker-busy',
	'mysql-worker-protocol-failed',
] as const;
export const responseSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('ready') }).strict(),
	z.object({ type: z.literal('heartbeat') }).strict(),
	z.object({ type: z.literal('stage'), stage: z.enum(stages) }).strict(),
	z.object({ type: z.literal('lease'), lease: leaseSchema }).strict(),
	z
		.object({
			type: z.literal('complete'),
			tables: z.number().int().nonnegative(),
			views: z.number().int().nonnegative(),
		})
		.strict(),
	z.object({ type: z.literal('cleaned') }).strict(),
	z.object({ type: z.literal('error'), stage: z.enum(stages), code: z.enum(codes) }).strict(),
]);
export function protocolError(): RecoveryTestError {
	return new RecoveryTestError('database-target-preflight', 'mysql-worker-protocol-failed');
}
/** Length-bounded JSON frames, never raw provider output. Stream backpressure bounds memory. */
export async function* frames(socket: Socket): AsyncGenerator<unknown> {
	let pending = Buffer.alloc(0);
	for await (const chunk of socket) {
		pending = Buffer.concat([pending, chunk]);
		while (pending.length >= 4) {
			const size = pending.readUInt32BE(0);
			if (!size || size > FRAME_LIMIT) throw protocolError();
			if (pending.length < size + 4) break;
			let value: unknown;
			try {
				value = JSON.parse(pending.subarray(4, size + 4).toString('utf8'));
			} catch {
				throw protocolError();
			}
			pending = pending.subarray(size + 4);
			yield value;
		}
	}
	if (pending.length) throw protocolError();
}
export function send(socket: Socket, value: unknown): Promise<void> {
	const body = Buffer.from(JSON.stringify(value));
	if (body.length > FRAME_LIMIT) return Promise.reject(protocolError());
	const header = Buffer.alloc(4);
	header.writeUInt32BE(body.length);
	return new Promise((resolve, reject) =>
		socket.write(Buffer.concat([header, body]), error =>
			error ? reject(protocolError()) : resolve()
		)
	);
}

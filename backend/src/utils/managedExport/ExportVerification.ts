import { TemporaryExportError } from './ExportPolicy';
import { ExportKeyError } from './ExportKeyring';
import {
	ExportOperationError,
	exportDiagnostic,
	exportHttpStatus,
	publicExportDiagnostic,
	type ExportDiagnostic,
} from './ExportDiagnostics';
import { exportRequestReceipt, exportTransportCode } from './ExportRequestDiagnostics';

const phases = [
	'keyring-manifest',
	'identity',
	'head',
	'get-headers',
	'ciphertext-body',
	'decrypt',
	'plaintext-body',
	'plaintext-sha256',
	'privacy-object',
	'privacy-list',
] as const;
const operations = [
	'KeyringValidation',
	'ObjectIdentity',
	'HeadObject',
	'GetObject',
	'PlaintextSha256',
	'AnonymousObjectGet',
	'AnonymousListGet',
] as const;
const kinds = [
	'invalid-response',
	'embedded-error',
	'sdk-parsing-error',
	'provider-error',
	'transport-error',
	'body-invalid',
	'integrity-error',
	'keyring-error',
] as const;
export type VerificationPhase = (typeof phases)[number];
export type VerificationOperation = (typeof operations)[number];
export type VerificationDiagnostic = {
	phase: VerificationPhase;
	operation: VerificationOperation;
	outcome: 'transport' | 'provider' | 'identity-integrity' | 'privacy' | 'keyring';
	category: ExportDiagnostic['category'];
	providerCategory: ExportDiagnostic['providerCategory'];
	providerCode: ExportDiagnostic['providerCode'];
	detail: ExportDiagnostic['detail'];
	responseKind: (typeof kinds)[number];
	httpStatus?: number;
	attempts?: number;
	transportCode: string;
	elapsedMs: number;
	phaseElapsedMs: number;
	abortedAtStart: boolean;
	abortReason: 'none' | 'deadline' | 'cancelled';
	wireBytesRead: number;
	plaintextBytesRead: number;
	bodyComplete: boolean;
};
const ms = (value: number) => Math.min(604800000, Math.max(0, Math.round(value)));
/** A diagnostic is neither integrity proof nor cleanup authority. */
export function publicVerificationDiagnostic(
	value?: VerificationDiagnostic
): VerificationDiagnostic | undefined {
	if (!value) return;
	// Reuse the existing exact provider/category/detail allowlists.
	const safe = publicExportDiagnostic(value as unknown as ExportDiagnostic)!;
	const count = (n: number, max: number) => (Number.isSafeInteger(n) && n >= 0 && n <= max ? n : 0);
	return {
		phase: phases.includes(value.phase) ? value.phase : 'identity',
		operation: operations.includes(value.operation) ? value.operation : 'ObjectIdentity',
		outcome: ['transport', 'provider', 'identity-integrity', 'privacy', 'keyring'].includes(
			value.outcome
		)
			? value.outcome
			: 'provider',
		category: safe.category,
		providerCategory: safe.providerCategory,
		providerCode: safe.providerCode,
		detail: safe.detail,
		responseKind: kinds.includes(value.responseKind) ? value.responseKind : 'invalid-response',
		httpStatus: exportHttpStatus({ $metadata: { httpStatusCode: value.httpStatus } }),
		attempts:
			Number.isInteger(value.attempts) && value.attempts! >= 1 && value.attempts! <= 100
				? value.attempts
				: undefined,
		transportCode: [
			'none',
			'ECONNRESET',
			'EPIPE',
			'ETIMEDOUT',
			'ENOTFOUND',
			'ECONNREFUSED',
			'EAI_AGAIN',
			'other',
		].includes(value.transportCode)
			? value.transportCode
			: 'other',
		elapsedMs: count(value.elapsedMs, 604800000),
		phaseElapsedMs: count(value.phaseElapsedMs, 604800000),
		abortedAtStart: value.abortedAtStart === true,
		abortReason: ['none', 'deadline', 'cancelled'].includes(value.abortReason)
			? value.abortReason
			: 'none',
		wireBytesRead: count(value.wireBytesRead, 129 * 1024 ** 3),
		plaintextBytesRead: count(value.plaintextBytesRead, 128 * 1024 ** 3),
		bodyComplete: value.bodyComplete === true,
	};
}
export class ExportVerificationError extends TemporaryExportError {
	constructor(
		error: unknown,
		readonly diagnostic: VerificationDiagnostic
	) {
		super(
			error instanceof ExportKeyError
				? 'encryption-key-unavailable'
				: error instanceof TemporaryExportError
					? error.reason
					: 'storage-unavailable'
		);
	}
}
export class VerificationTrace {
	private started = performance.now();
	private phaseStart = this.started;
	private totals: Partial<Record<VerificationPhase, number>> = {};
	private phase: VerificationPhase = 'identity';
	private operation: VerificationOperation = 'ObjectIdentity';
	private response?: { httpStatus?: number; attempts?: number };
	private wire = 0;
	private plaintext = 0;
	private complete = false;
	private abortedAtStart: boolean;
	constructor(private signal: AbortSignal) {
		this.abortedAtStart = signal.aborted;
	}
	enter(phase: VerificationPhase, operation: VerificationOperation, preserveResponse = false) {
		const now = performance.now();
		this.totals[this.phase] = (this.totals[this.phase] || 0) + now - this.phaseStart;
		this.phaseStart = now;
		this.phase = phase;
		this.operation = operation;
		if (!preserveResponse) this.response = undefined;
	}
	headers(value: unknown) {
		const receipt = exportRequestReceipt(value);
		const attempts =
			receipt?.attempts || (value as { $metadata?: { attempts?: number } })?.$metadata?.attempts;
		this.response = { httpStatus: exportHttpStatus(value), attempts };
	}
	wireEvent(phase: 'ciphertext-body' | 'decrypt', bytes?: number, complete = false) {
		this.enter(phase, 'GetObject', true);
		if (bytes) this.wire += bytes;
		if (complete) this.complete = true;
	}
	plainBytes(bytes: number) {
		this.plaintext += bytes;
	}
	bodyComplete() {
		this.complete = true;
	}
	fail(error: unknown) {
		if (error instanceof ExportVerificationError) return error;
		const existing = error instanceof ExportOperationError ? error : undefined;
		const safe = exportDiagnostic(error, {} as never, 'read-only', 'full-readback');
		const receipt = exportRequestReceipt(error) || existing?.request;
		const providerCategory =
			existing?.responseKind === 'sdk-parsing-error' ? 'invalid-response' : safe.providerCategory;
		const keyring = this.phase === 'keyring-manifest';
		const integrity =
			error instanceof TemporaryExportError &&
			['object-mismatch', 'encryption-metadata-invalid'].includes(error.reason);
		const transport = ['network', 'deadline', 'aborted', 'tls-validation'].includes(
			providerCategory
		);
		const operation =
			existing && operations.includes(existing.operation as VerificationOperation)
				? (existing.operation as VerificationOperation)
				: this.operation;
		const diagnostic = publicVerificationDiagnostic({
			phase: this.phase,
			operation,
			outcome: keyring
				? 'keyring'
				: transport
					? 'transport'
					: integrity
						? 'identity-integrity'
						: this.phase.startsWith('privacy')
							? 'privacy'
							: 'provider',
			category: safe.category,
			providerCategory,
			providerCode: safe.providerCode,
			detail: integrity
				? existing?.detail ||
					(this.phase === 'plaintext-sha256'
						? 'checksum-mismatch'
						: this.phase === 'ciphertext-body' && this.complete
							? 'length-mismatch'
							: 'identity-mismatch')
				: safe.detail,
			responseKind: keyring
				? 'keyring-error'
				: integrity
					? this.phase === 'ciphertext-body'
						? 'body-invalid'
						: 'integrity-error'
					: existing?.responseKind || (transport ? 'transport-error' : 'provider-error'),
			httpStatus: safe.httpStatus ?? existing?.wireHttpStatus ?? this.response?.httpStatus,
			attempts: receipt?.attempts || existing?.requestAttempts || this.response?.attempts,
			transportCode: receipt?.transportCode || exportTransportCode(error),
			elapsedMs: ms(performance.now() - this.started),
			phaseElapsedMs: ms((this.totals[this.phase] || 0) + performance.now() - this.phaseStart),
			abortedAtStart: this.abortedAtStart,
			abortReason: this.signal.aborted
				? this.signal.reason?.name === 'TimeoutError'
					? 'deadline'
					: 'cancelled'
				: providerCategory === 'deadline'
					? 'deadline'
					: 'none',
			wireBytesRead: this.wire,
			plaintextBytesRead: this.plaintext,
			bodyComplete: this.complete,
		})!;
		const classified =
			this.signal.aborted &&
			!(error instanceof TemporaryExportError) &&
			!(error instanceof ExportKeyError)
				? new TemporaryExportError('interrupted')
				: error;
		return new ExportVerificationError(classified, diagnostic);
	}
	async run<T>(phase: VerificationPhase, operation: VerificationOperation, work: () => Promise<T>) {
		this.enter(phase, operation);
		try {
			return await work();
		} catch (error) {
			throw this.fail(error);
		}
	}
}
export function verificationStep<T>(
	trace: VerificationTrace | undefined,
	phase: VerificationPhase,
	operation: VerificationOperation,
	work: () => Promise<T>
) {
	return trace ? trace.run(phase, operation, work) : work();
}

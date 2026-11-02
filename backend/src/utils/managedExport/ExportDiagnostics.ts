import {
	ExportPreflightError,
	TemporaryExportError,
	type ExportCapability,
	type ExportJob,
} from './ExportPolicy';

const operations = [
	'GetBucketVersioning',
	'PutObject',
	'HeadObject',
	'GetObject',
	'GetObjectAcl',
	'CreateMultipartUpload',
	'UploadPart',
	'CompleteMultipartUpload',
	'AbortMultipartUpload',
	'ListParts',
	'ListObjectsV2',
	'ListMultipartUploads',
	'DeleteObject',
	'creation-response',
	'ownership-proof',
	'configuration',
	'unknown',
] as const;
export type ExportOperation = (typeof operations)[number];
const details = [
	'provider-error',
	'missing-etag',
	'unexpected-creation-status',
	'version-present',
	'etag-mismatch',
	'length-mismatch',
	'missing-last-modified',
	'sse-s3-unverified',
	'ownership-marker-mismatch',
	'ownership-proof-missing',
	'identity-mismatch',
	'checksum-mismatch',
	'unknown-multipart',
	'multipart-remains',
	'listing-incomplete',
	'directory-marker-nonzero',
	'directory-marker-unverified',
	'foreign-object',
	'listing-invalid',
	'versioning-changed',
	'unexpected-head-status',
	'object-remains',
] as const;
type Detail = (typeof details)[number];
const providers = [
	'access-denied',
	'unsupported-api',
	'not-found',
	'precondition-failed',
	'conflict',
	'tls-validation',
	'network',
	'deadline',
	'aborted',
	'invalid-response',
	'service-error',
] as const;
type Provider = (typeof providers)[number];
const providerCodes = [
	'AccessDenied',
	'InvalidAccessKeyId',
	'SignatureDoesNotMatch',
	'AuthorizationHeaderMalformed',
	'NotImplemented',
	'MethodNotAllowed',
	'InvalidRequest',
	'InvalidArgument',
	'InvalidPart',
	'InvalidPartOrder',
	'NoSuchUpload',
	'InvalidObjectState',
	'OperationAborted',
	'BadDigest',
	'SlowDown',
	'InternalError',
	'ServiceUnavailable',
	'unrecognized',
] as const;
type ProviderCode = (typeof providerCodes)[number];
const providerCode = (error: unknown): ProviderCode => {
	if (error instanceof ExportOperationError) return error.providerCode;
	const e = error as { name?: string; Code?: string; code?: string } | undefined;
	return providerCodes.find(code => [e?.name, e?.Code, e?.code].includes(code)) || 'unrecognized';
};
type Target = 'namespace' | 'archive' | 'probe' | 'race' | 'put-race' | 'unknown';
export const exportTarget = (key?: string): Target =>
	!key
		? 'namespace'
		: key.endsWith('.probe-put-race')
			? 'put-race'
			: key.endsWith('.probe-race')
				? 'race'
				: key.endsWith('.probe')
					? 'probe'
					: 'archive';
export type ExportDiagnostic = {
	stage: 'preflight' | 'cleanup' | 'read-only';
	capability: ExportCapability;
	operation: ExportOperation;
	target: Target;
	category: ExportPreflightError['category'];
	providerCategory: Provider;
	providerCode: ProviderCode;
	detail: Detail;
	httpStatus?: number;
	creationAcknowledged: boolean;
	durableOwnershipProof: boolean;
	objectCleanupPending: boolean;
	multipartCleanupPending: boolean;
};
export const exportHttpStatus = (error: unknown) => {
	const n = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
	return Number.isInteger(n) && n! >= 100 && n! <= 599 ? n : undefined;
};
/** Exact allowlists only. Never copy messages, headers, IDs, names or arbitrary codes. */
function provider(error: unknown): Provider {
	if (error instanceof ExportOperationError) return error.providerCategory;
	const e = error as { name?: string; code?: string } | undefined;
	const names = [e?.name, e?.code];
	if (
		names.some(n =>
			[
				'DEPTH_ZERO_SELF_SIGNED_CERT',
				'SELF_SIGNED_CERT_IN_CHAIN',
				'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
				'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
				'ERR_TLS_CERT_ALTNAME_INVALID',
				'CERT_HAS_EXPIRED',
			].includes(n || '')
		)
	)
		return 'tls-validation';
	if (names.includes('TimeoutError') || names.includes('ETIMEDOUT')) return 'deadline';
	if (names.includes('AbortError')) return 'aborted';
	if (
		names.some(n =>
			['ECONNRESET', 'EPIPE', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'].includes(n || '')
		)
	)
		return 'network';
	const status = exportHttpStatus(error);
	if (status === 401 || status === 403) return 'access-denied';
	if (status === 405 || status === 501) return 'unsupported-api';
	if (status === 404) return 'not-found';
	if (status === 412) return 'precondition-failed';
	if (status === 409) return 'conflict';
	if (error instanceof TemporaryExportError) return 'invalid-response';
	return 'service-error';
}
export class ExportOperationError extends TemporaryExportError {
	readonly $metadata: { httpStatusCode?: number };
	readonly providerCategory: Provider;
	readonly providerCode: ProviderCode;
	constructor(
		readonly operation: ExportOperation,
		error: unknown,
		readonly detail: Detail = 'provider-error',
		reason: 'object-mismatch' | 'cleanup-pending' | 'storage-unavailable' = 'storage-unavailable',
		readonly target: Target = 'unknown'
	) {
		super(reason);
		this.$metadata = { httpStatusCode: exportHttpStatus(error) };
		this.providerCategory = detail === 'provider-error' ? provider(error) : 'invalid-response';
		this.providerCode = detail === 'provider-error' ? providerCode(error) : 'unrecognized';
	}
}
export class ExportCleanupError extends ExportPreflightError {
	constructor(readonly diagnostic: ExportDiagnostic) {
		super('cleanup', 'cleanup-failed', diagnostic.httpStatus);
		this.message = 'Reliable Download unavailable (cleanup-pending).';
	}
}
/** Inventory is read-only: these diagnostics confer neither ownership nor cleanup permission. */
export class ExportInventoryError extends ExportPreflightError {
	readonly diagnostic: ExportDiagnostic;
	constructor(error: unknown) {
		const diagnostic = exportDiagnostic(
			error,
			{} as ExportJob,
			'read-only',
			'destination-isolation'
		);
		super('destination-isolation', diagnostic.category, diagnostic.httpStatus);
		this.diagnostic = {
			...diagnostic,
			creationAcknowledged: false,
			durableOwnershipProof: false,
			objectCleanupPending: false,
			multipartCleanupPending: false,
		};
	}
}
export function exportDiagnostic(
	error: unknown,
	job: ExportJob,
	stage: ExportDiagnostic['stage'],
	capability: ExportCapability,
	operation: ExportOperation = 'unknown'
): ExportDiagnostic {
	if (error instanceof ExportCleanupError) return { ...error.diagnostic, stage };
	const p = error instanceof ExportOperationError ? error.providerCategory : provider(error);
	const target = error instanceof ExportOperationError ? error.target : 'unknown';
	const suffix = {
		'archive': '',
		'probe': '.probe',
		'race': '.probe-race',
		'put-race': '.probe-put-race',
	};
	const key = target in suffix ? job.key + suffix[target as keyof typeof suffix] : undefined;
	return {
		stage,
		capability,
		target,
		operation: error instanceof ExportOperationError ? error.operation : operation,
		category:
			p === 'tls-validation'
				? 'tls-validation'
				: p === 'access-denied'
					? 'access-denied'
					: p === 'unsupported-api'
						? 'unsupported-api'
						: ['network', 'deadline', 'aborted'].includes(p)
							? 'network-or-deadline'
							: 'unexpected-response',
		providerCategory: p,
		providerCode: error instanceof ExportOperationError ? error.providerCode : providerCode(error),
		detail: error instanceof ExportOperationError ? error.detail : 'provider-error',
		httpStatus: exportHttpStatus(error),
		creationAcknowledged: !!job.creationReceipts?.some(
			r => (!key || r.key === key) && r.acknowledged
		),
		durableOwnershipProof: !!job.ownedObjects?.some(p => !key || p.key === key),
		objectCleanupPending: job.cleanupState?.objects !== 'verified-absent',
		multipartCleanupPending: job.cleanupState?.multipart !== 'verified-absent',
	};
}
/** Defensive field projection for persisted metadata and public/log output. */
export function publicExportDiagnostic(d?: ExportDiagnostic): ExportDiagnostic | undefined {
	if (!d) return;
	return {
		stage: ['preflight', 'cleanup', 'read-only'].includes(d.stage) ? d.stage : 'cleanup',
		capability: d.stage === 'preflight' ? 'write-once-creation' : 'cleanup',
		// Capability is replaced below only when it is a known policy value.
		...([
			'https',
			'destination-isolation',
			'versioning',
			'sse-s3',
			'application-encryption',
			'authenticated-readback',
			'private-acl',
			'anonymous-denial',
			'immutable-version',
			'range-resume',
			'version-enumeration',
			'multipart-upload',
			'multipart-completion',
			'multipart-enumeration',
			'conditional-completion',
			'write-once-creation',
			'collision-rejection',
			'concurrent-publication',
			'conditional-range',
			'full-readback',
			'object-enumeration',
			'ownership-cleanup',
			'presigned-get',
			'cleanup',
		].includes(d.capability)
			? { capability: d.capability }
			: {}),
		operation: operations.includes(d.operation) ? d.operation : 'unknown',
		target: ['namespace', 'archive', 'probe', 'race', 'put-race', 'unknown'].includes(d.target)
			? d.target
			: 'unknown',
		category: [
			'tls-validation',
			'access-denied',
			'unsupported-api',
			'unexpected-response',
			'network-or-deadline',
			'cleanup-failed',
		].includes(d.category)
			? d.category
			: 'unexpected-response',
		providerCategory: providers.includes(d.providerCategory) ? d.providerCategory : 'service-error',
		providerCode: providerCodes.includes(d.providerCode) ? d.providerCode : 'unrecognized',
		detail: details.includes(d.detail) ? d.detail : 'provider-error',
		httpStatus: exportHttpStatus({ $metadata: { httpStatusCode: d.httpStatus } }),
		creationAcknowledged: d.creationAcknowledged === true,
		durableOwnershipProof: d.durableOwnershipProof === true,
		objectCleanupPending: d.objectCleanupPending !== false,
		multipartCleanupPending: d.multipartCleanupPending !== false,
	};
}

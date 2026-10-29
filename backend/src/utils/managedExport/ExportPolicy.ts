import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { AppError } from '../AppError';
import { httpsS3Endpoint } from '../storageSecurity';
import type { ManagedExportMode, ManagedExportSummary } from '../restic/ManagedExportPolicy';

export const EXPORT_LIMITS = Object.freeze({
	partBytes: 16 * 1024 ** 2,
	maxObjectBytes: 128 * 1024 ** 3,
	quotaBytes: 256 * 1024 ** 3,
	maxJobs: 64,
	maxAdmitted: 4,
	maxObjects: 4,
	deadlineMs: 7 * 24 * 60 * 60_000,
	authorizationSeconds: 300,
});
export type ExportFailure =
	| 'not-configured'
	| 'configuration-invalid'
	| 'destination-not-isolated'
	| 'storage-unavailable'
	| 'security-capability-missing'
	| 'archive-refused'
	| 'object-mismatch'
	| 'quota-exceeded'
	| 'queue-full'
	| 'cancelled'
	| 'interrupted'
	| 'cleanup-pending'
	| 'expired'
	| 'range-invalid'
	| 'binding-changed';
export class TemporaryExportError extends AppError {
	readonly code = 'temporary-export-refused';
	constructor(readonly reason: ExportFailure) {
		super(
			reason === 'not-configured'
				? 503
				: reason === 'range-invalid'
					? 416
					: reason === 'queue-full'
						? 429
						: 409,
			`Reliable Download unavailable (${reason}).`
		);
		Object.setPrototypeOf(this, new.target.prototype);
	}
}
export type ExportCapability =
	| 'https'
	| 'destination-isolation'
	| 'versioning'
	| 'sse-s3'
	| 'private-acl'
	| 'anonymous-denial'
	| 'immutable-version'
	| 'range-resume'
	| 'version-enumeration'
	| 'multipart-upload'
	| 'multipart-completion'
	| 'multipart-enumeration'
	| 'conditional-completion'
	| 'write-once-creation'
	| 'collision-rejection'
	| 'concurrent-publication'
	| 'conditional-range'
	| 'full-readback'
	| 'object-enumeration'
	| 'ownership-cleanup'
	| 'presigned-get'
	| 'cleanup';
export class ExportPreflightError extends TemporaryExportError {
	constructor(
		readonly capability: ExportCapability,
		readonly category:
			| 'tls-validation'
			| 'access-denied'
			| 'unsupported-api'
			| 'unexpected-response'
			| 'network-or-deadline'
			| 'cleanup-failed',
		readonly httpStatus?: number
	) {
		super('security-capability-missing');
		Object.setPrototypeOf(this, new.target.prototype);
	}
}
export type ExportConfig = {
	allowSharedNamespace?: boolean;
	endpoint: string;
	region: string;
	bucket: string;
	prefix: string;
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	ca?: Buffer;
	ttlSeconds: number;
	fingerprint: string;
};
const configSchema = z.strictObject({
	endpoint: z.string(),
	region: z.string().regex(/^[a-z0-9-]{1,64}$/),
	bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
	prefix: z.string().regex(/^pluton-temporary-exports(?:\/[A-Za-z0-9_-]{1,64})?$/),
	accessKeyId: z.string().min(1).max(256),
	secretAccessKey: z.string().min(1).max(1024),
	sessionToken: z.string().max(4096).optional(),
	ttlSeconds: z.number().int().min(3600).max(604800),
});
export function exportConfiguration(
	env: NodeJS.ProcessEnv = process.env
): ExportConfig | undefined {
	if (env.MANAGED_EXPORT_ENABLED !== 'true') return;
	const parsed = configSchema.safeParse({
		endpoint: env.MANAGED_EXPORT_ENDPOINT,
		region: env.MANAGED_EXPORT_REGION || 'us-east-1',
		bucket: env.MANAGED_EXPORT_BUCKET,
		prefix: env.MANAGED_EXPORT_PREFIX || 'pluton-temporary-exports',
		accessKeyId: env.MANAGED_EXPORT_ACCESS_KEY_ID,
		secretAccessKey: env.MANAGED_EXPORT_SECRET_ACCESS_KEY,
		sessionToken: env.MANAGED_EXPORT_SESSION_TOKEN,
		ttlSeconds: Number(env.MANAGED_EXPORT_TTL_SECONDS || 259200),
	});
	if (!parsed.success) throw new TemporaryExportError('configuration-invalid');
	try {
		const c = parsed.data;
		if (
			env.MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE &&
			!['true', 'false'].includes(env.MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE)
		)
			throw new Error();
		const allowSharedNamespace = env.MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE === 'true';
		if (allowSharedNamespace && c.prefix !== 'pluton-temporary-exports') throw new Error();
		c.endpoint = httpsS3Endpoint(c.endpoint).origin;
		// This client uses path-style bucket addressing. A bucket-qualified host
		// could add an unintended object-key component on HCP; do not guess.
		if (allowSharedNamespace && new URL(c.endpoint).hostname.startsWith(c.bucket + '.'))
			throw new Error();
		let ca: Buffer | undefined;
		if (env.MANAGED_EXPORT_CA_FILE) {
			const stat = fs.lstatSync(env.MANAGED_EXPORT_CA_FILE);
			if (
				!path.isAbsolute(env.MANAGED_EXPORT_CA_FILE) ||
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				stat.size > 256 * 1024 ||
				(process.platform !== 'win32' && stat.mode & 0o022)
			)
				throw new Error();
			ca = fs.readFileSync(env.MANAGED_EXPORT_CA_FILE);
			const certificates = ca
				.toString('utf8')
				.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
			if (!certificates?.length || certificates.some(pem => !new crypto.X509Certificate(pem).ca))
				throw new Error();
		}
		const fingerprint = crypto
			.createHash('sha256')
			.update(
				JSON.stringify([
					c.endpoint,
					c.region,
					c.bucket,
					c.prefix,
					'AES256',
					ca ? crypto.createHash('sha256').update(ca).digest('hex') : 'system-ca',
				])
			)
			.digest('hex');
		return { ...c, ca, fingerprint, allowSharedNamespace };
	} catch {
		throw new TemporaryExportError('configuration-invalid');
	}
}
/** Safe projection from the application's actual process configuration. Values,
 * credential hashes and signed URLs are deliberately excluded. */
export function exportConfigurationStatus() {
	const enabled = process.env.MANAGED_EXPORT_ENABLED === 'true';
	try {
		const c = exportConfiguration();
		return {
			enabled,
			configured: !!c,
			endpointConfigured: !!c?.endpoint,
			regionConfigured: !!c?.region,
			bucketConfigured: !!c?.bucket,
			prefixConfigured: !!c?.prefix,
			credentialsConfigured: !!c?.accessKeyId && !!c?.secretAccessKey,
			sessionTokenConfigured: !!c?.sessionToken,
			privateCaConfigured: !!c?.ca,
			sharedNamespaceEnabled: !!c?.allowSharedNamespace,
			ttlSeconds: c?.ttlSeconds,
			destinationFingerprint: c?.fingerprint,
		};
	} catch {
		return { enabled, configured: false, reason: 'configuration-invalid' };
	}
}
export type ExportBinding = {
	backupId: string;
	planId: string;
	sourceId: string;
	repositoryId: string;
	snapshotId: string;
	mode: ManagedExportMode;
};
export type ExportIntegrityMode = 'versioned' | 'hcp-write-once';
export type ExportIdentity =
	| { mode: 'versioned'; versionId: string; etag: string }
	| {
			mode: 'hcp-write-once';
			key: string;
			etag: string;
			bytes: number;
			sha256: string;
			binding: string;
			created: string;
			capability: string;
	  };
/** No configuration values or credentials in the public capability report. */
export type ExportProviderEvidence = {
	mode: ExportIntegrityMode;
	versioning: 'enabled' | 'disabled-or-unavailable';
	writeOnce: boolean;
	collisionStatus?: number;
	concurrentPublication?: boolean;
	conditionalRange: boolean;
	cleanup: 'version-specific' | 'conditional-etag' | 'exclusive-prefix-bounded';
	transport: 'versioned-presigned-and-proxy' | 'authenticated-proxy';
	verifiedAt: number;
};
export const EXPORT_CAPABILITY_REVISION = 'write-once-v1';
/** Nonversioned cleanup re-reads the complete object. Give healthy streaming a
 * size-based bound (1 MiB/s plus one minute), not a metadata-only 60s deadline. */
export const exportCleanupDeadline = (job: ExportJob) =>
	job.integrityMode === 'hcp-write-once'
		? Math.min(
				EXPORT_LIMITS.deadlineMs,
				60_000 +
					Math.ceil(
						Math.min(
							EXPORT_LIMITS.maxObjectBytes,
							Math.max(0, job.summary?.archiveBytes || job.reservedBytes || 0)
						) /
							1024 ** 2
					) *
						1000
			)
		: 60_000;
/** Private proof binding; never returned or logged. Changing credentials or CA
 * requires a fresh operator preflight, without orphaning historical job records. */
export const exportCapabilityBinding = (c: ExportConfig) =>
	crypto
		.createHash('sha256')
		.update(
			JSON.stringify([
				EXPORT_CAPABILITY_REVISION,
				c.fingerprint,
				!!c.allowSharedNamespace,
				c.accessKeyId,
				c.secretAccessKey,
				c.sessionToken || '',
			])
		)
		.digest('hex');
export type ExportState =
	| 'queued'
	| 'validating'
	| 'exporting'
	| 'uploading'
	| 'verifying'
	| 'ready'
	| 'failed'
	| 'cancelled'
	| 'expired';
export type ExportJob = {
	kind?: 'archive' | 'preflight' | 'inventory';
	integrityMode?: ExportIntegrityMode;
	identity?: ExportIdentity;
	providerEvidence?: ExportProviderEvidence;
	capabilityBinding?: string;
	ownershipNonce?: string;
	publicationAttempted?: boolean;
	ownedObjects?: { key: string; etag: string; bytes: number; sha256: string; created: string }[];
	ownedUploads?: { key: string; uploadId: string }[];
	capabilityProbe?: ExportJob;
	ownedVersions?: { key: string; versionId: string; etag?: string; bytes: number }[];
	inventory?: { objects: number; uploads: number; exclusive: true };
	id: string;
	owner: string;
	binding: ExportBinding;
	destination: string;
	key: string;
	state: ExportState;
	createdAt: number;
	updatedAt: number;
	expiresAt?: number;
	uploadedBytes: number;
	uploadStartedAt?: number;
	uploadFinishedAt?: number;
	processedBytes: number;
	reservedBytes: number;
	summary?: ManagedExportSummary;
	uploadId?: string;
	probeUploadId?: string;
	versionId?: string;
	etag?: string;
	failure?: ExportFailure;
	failureStage?:
		| 'preflight'
		| 'archive-validation'
		| 'upload'
		| 'object-verification'
		| 'binding-validation';
	failureDetail?: string;
	preflightChecks?: ExportCapability[];
	probeFailure?: {
		capability: ExportCapability;
		category: ExportPreflightError['category'];
		httpStatus?: number;
	};
	failureCapability?: ExportCapability;
	failureCategory?: ExportPreflightError['category'];
	failureHttpStatus?: number;
	cleaned: boolean;
	cleanupAttempts: number;
};
export const activeExport = (s: ExportState) =>
	['queued', 'validating', 'exporting', 'uploading', 'verifying'].includes(s);
export const exportFileName = (job: ExportJob) =>
	`backup-${job.id}${job.binding.mode === 'regular-files' ? '-regular-files' : ''}.tar`;
export const bindingDigest = (b: ExportBinding) =>
	crypto.createHash('sha256').update(JSON.stringify(b)).digest('hex');
export function exportRange(
	range: unknown,
	ifRange: unknown,
	size: number,
	etag: string
): { status: 200 | 206; start: number; end: number } {
	if (range === undefined || (ifRange !== undefined && ifRange !== etag))
		return { status: 200, start: 0, end: size - 1 };
	if (typeof range !== 'string' || range.length > 80)
		throw new TemporaryExportError('range-invalid');
	const m = /^bytes=(\d*)-(\d*)$/.exec(range);
	if (!m || (!m[1] && !m[2])) throw new TemporaryExportError('range-invalid');
	const first = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
	const last = m[1] ? (m[2] ? Math.min(size - 1, Number(m[2])) : size - 1) : size - 1;
	if (
		![first, last, Number(m[1] || 0), Number(m[2] || 0)].every(Number.isSafeInteger) ||
		first < 0 ||
		first >= size ||
		last < first ||
		(!m[1] && Number(m[2]) === 0)
	)
		throw new TemporaryExportError('range-invalid');
	return { status: 206, start: first, end: last };
}

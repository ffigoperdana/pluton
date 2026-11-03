import { bindingDigest, type ExportJob } from './ExportPolicy';
import { exportTarget, publicExportDiagnostic, type ExportDiagnostic } from './ExportDiagnostics';

export type PublicationResponse =
	| 'success'
	| 'invalid-response'
	| 'provider-error'
	| 'embedded-error'
	| 'sdk-parsing-error'
	| 'transport-error';
export type PublicationValidation = {
	status200: boolean;
	entityTagPresent: boolean;
	entityTagQuoted: boolean;
	versionAbsentOrNull: boolean;
	objectIdentityRequired: boolean;
	bucketPresent: boolean;
	bucketMatches: boolean;
	keyPresent: boolean;
	keyMatches: boolean;
};
/** Evaluate the existing admission rules without normalizing provider values.
 * Persist only booleans: even malformed or foreign response fields stay private. */
export function publicationValidation(
	result: {
		$metadata?: { httpStatusCode?: number };
		ETag?: string;
		VersionId?: string;
		Bucket?: string;
		Key?: string;
	},
	bucket: string,
	key: string,
	multipart: boolean
) {
	const checks: PublicationValidation = {
		status200: result.$metadata?.httpStatusCode === 200,
		entityTagPresent: typeof result.ETag === 'string' && result.ETag.length > 0,
		entityTagQuoted: typeof result.ETag === 'string' && /^"[^"\r\n]{1,1022}"$/.test(result.ETag),
		versionAbsentOrNull: !result.VersionId || result.VersionId === 'null',
		objectIdentityRequired: multipart,
		bucketPresent: typeof result.Bucket === 'string' && result.Bucket.length > 0,
		bucketMatches: result.Bucket === bucket,
		keyPresent: typeof result.Key === 'string' && result.Key.length > 0,
		keyMatches: result.Key === key,
	};
	return {
		checks,
		valid:
			checks.status200 &&
			checks.entityTagQuoted &&
			checks.versionAbsentOrNull &&
			(!multipart || (checks.bucketMatches && checks.keyMatches)),
	};
}
const validationFields = [
	'status200',
	'entityTagPresent',
	'entityTagQuoted',
	'versionAbsentOrNull',
	'objectIdentityRequired',
	'bucketPresent',
	'bucketMatches',
	'keyPresent',
	'keyMatches',
] as const;
function publicValidation(value?: PublicationValidation): PublicationValidation | undefined {
	if (!value || !validationFields.every(field => typeof value[field] === 'boolean')) return;
	return Object.fromEntries(
		validationFields.map(field => [field, value[field]])
	) as PublicationValidation;
}
export type ExportPublicationAttempt = {
	competitor: 'multipart-a' | 'multipart-b' | 'put';
	operation: 'CompleteMultipartUpload' | 'PutObject';
	bytes: number;
	sha256: string;
	uploadId?: string;
	outcome: 'pending' | 'acknowledged' | 'rejected';
	response?: PublicationResponse;
	etag?: string;
	validResponse?: boolean;
	/** Observation only; never used to reconstruct or relax ownership proof. */
	validation?: PublicationValidation;
	httpStatus?: number;
	wireHttpStatus?: number;
	failure?: ExportDiagnostic;
	uploadAbsent?: boolean;
	abortAcknowledged?: boolean;
};
export type ExportPublicationRace = {
	key: string;
	binding: string;
	destination: string;
	nonce: string;
	state: 'pending' | 'single-winner' | 'ambiguous' | 'verified';
	attempts: ExportPublicationAttempt[];
};
/** A non-409 failure is not proof that the competitor did not commit. */
export function publicationVerdict(attempts: ExportPublicationAttempt[]) {
	if (attempts.some(a => a.outcome === 'pending')) return 'pending' as const;
	const winners = attempts.filter(a => a.outcome === 'acknowledged');
	return winners.length === 1 &&
		winners[0].validResponse === true &&
		attempts.every(
			a =>
				a === winners[0] ||
				(a.outcome === 'rejected' && a.httpStatus === 409 && a.response === 'provider-error')
		)
		? ('single-winner' as const)
		: ('ambiguous' as const);
}
/** Validate complete new-format intent/receipts before crash recovery can use them.
 * HEAD/key/hash alone, pending operations and all legacy jobs remain insufficient. */
function settledWinner(job: ExportJob, race: ExportPublicationRace) {
	const put = race.key === job.key + '.probe-put-race';
	if (
		(!put && race.key !== job.key + '.probe-race') ||
		!['single-winner', 'verified'].includes(race.state) ||
		race.binding !== bindingDigest(job.binding) ||
		race.destination !== job.destination ||
		!job.ownershipNonce ||
		race.nonce !== job.ownershipNonce ||
		race.attempts.length !== (put ? 3 : 2) ||
		race.attempts.some(
			(a, i) =>
				a.competitor !== ['multipart-a', 'multipart-b', 'put'][i] ||
				a.operation !== (i === 2 ? 'PutObject' : 'CompleteMultipartUpload') ||
				!Number.isSafeInteger(a.bytes) ||
				a.bytes < 1 ||
				a.bytes > 1024 ||
				!/^[a-f0-9]{64}$/.test(a.sha256)
		) ||
		publicationVerdict(race.attempts) !== 'single-winner'
	)
		return;
	const winner = race.attempts.find(a => a.outcome === 'acknowledged')!;
	if (
		winner.httpStatus !== 200 ||
		winner.response !== 'success' ||
		typeof winner.etag !== 'string' ||
		!/^"[^"\r\n]{1,1022}"$/.test(winner.etag) ||
		!job.creationReceipts?.some(r => r.key === race.key && r.acknowledged)
	)
		return;
	return winner;
}
export function publicationWinner(job: ExportJob, race: ExportPublicationRace) {
	// Historical diagnostics can outlive cleanup, but recovery additionally
	// requires the original, still-tracked upload ownership. Never adopt a
	// reappearing object after those proof records have been cleared.
	if (
		race.attempts.some(
			a =>
				a.operation === 'CompleteMultipartUpload' &&
				(!a.uploadId ||
					!job.ownedUploads?.some(u => u.key === race.key && u.uploadId === a.uploadId))
		)
	)
		return;
	return settledWinner(job, race);
}
/** Safe additive projection: no keys, upload IDs, ETags, hashes, nonce or bodies. */
export function publicExportPublications(job: ExportJob) {
	const races = Array.isArray(job.publicationRaces) ? job.publicationRaces : [];
	return races
		.filter(
			race =>
				race &&
				[job.key + '.probe-race', job.key + '.probe-put-race'].includes(race.key) &&
				Array.isArray(race.attempts) &&
				race.attempts.every(a => a && typeof a === 'object')
		)
		.slice(0, 2)
		.map(race => ({
			target: exportTarget(race.key),
			acknowledgedResponses: race.attempts.filter(a => a.outcome === 'acknowledged').length,
			validSuccessResponses: race.attempts.filter(
				a => a.outcome === 'acknowledged' && a.validResponse === true
			).length,
			multipleAcknowledgements: race.attempts.filter(a => a.outcome === 'acknowledged').length > 1,
			multipleSuccesses:
				race.attempts.filter(a => a.outcome === 'acknowledged' && a.validResponse === true).length >
				1,
			ambiguityRemaining: !settledWinner(job, race),
			proofVerified: race.state === 'verified' && !!settledWinner(job, race),
			objectProof:
				race.state === 'verified' &&
				!!publicationWinner(job, race) &&
				!!job.ownedObjects?.some(p => p.key === race.key),
			multipartCleanupPending: job.cleanupState?.multipart !== 'verified-absent',
			objectCleanupPending: job.cleanupState?.objects !== 'verified-absent',
			operations: race.attempts.slice(0, 3).map(a => ({
				competitor: ['multipart-a', 'multipart-b', 'put'].includes(a.competitor)
					? a.competitor
					: 'unknown',
				operation: a.operation === 'PutObject' ? 'PutObject' : 'CompleteMultipartUpload',
				httpStatus: safeStatus(a.httpStatus),
				wireHttpStatus: safeStatus(a.wireHttpStatus),
				response: [
					'success',
					'invalid-response',
					'provider-error',
					'embedded-error',
					'sdk-parsing-error',
					'transport-error',
				].includes(a.response || '')
					? a.response
					: 'pending',
				acknowledged: a.outcome === 'acknowledged',
				validationEvidence: publicValidation(a.validation)
					? ('recorded' as const)
					: a.outcome === 'rejected' || a.outcome === 'pending'
						? ('not-evaluated' as const)
						: ('not-recorded' as const),
				validation: publicValidation(a.validation),
				durableReceipt: ['acknowledged', 'rejected'].includes(a.outcome),
				providerCategory: publicExportDiagnostic(a.failure)?.providerCategory,
				providerCode: publicExportDiagnostic(a.failure)?.providerCode,
				uploadAbsent: a.uploadAbsent === true,
				abortAcknowledged: a.abortAcknowledged === true,
			})),
		}));
}
const safeStatus = (value?: number) =>
	Number.isInteger(value) && value! >= 100 && value! <= 599 ? value : undefined;

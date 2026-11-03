import { publicCompletionShape, type CompletionShape } from './ExportCompletionShape';
import { bindingDigest, type ExportJob } from './ExportPolicy';
import { exportTarget, publicExportDiagnostic, type ExportDiagnostic } from './ExportDiagnostics';

export type PublicationResponse =
	| 'success'
	| 'invalid-response'
	| 'provider-error'
	| 'embedded-error'
	| 'sdk-parsing-error'
	| 'transport-error'
	| 'body-invalid';
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
	completion?: CompletionShape;
	etag?: string;
	validResponse?: boolean;
	/** Observation only; never used to reconstruct or relax ownership proof. */
	validation?: PublicationValidation;
	httpStatus?: number;
	wireHttpStatus?: number;
	requestAttempts?: number;
	failure?: ExportDiagnostic;
	uploadAbsent?: boolean;
	abortAcknowledged?: boolean;
};
export type ExportPublicationRace = {
	/** Written with fresh intent only; never inferred for historical races. */
	protocol?: 'hcp-final-error-v1';
	key: string;
	binding: string;
	destination: string;
	nonce: string;
	state: 'pending' | 'single-winner' | 'ambiguous' | 'verified';
	attempts: ExportPublicationAttempt[];
};
function finalConflict(a: ExportPublicationAttempt) {
	const c = a.completion;
	return (
		a.operation === 'CompleteMultipartUpload' &&
		a.outcome === 'rejected' &&
		a.validResponse !== true &&
		a.etag === undefined &&
		a.failure?.operation === 'CompleteMultipartUpload' &&
		a.httpStatus === 200 &&
		a.wireHttpStatus === 200 &&
		a.response === 'embedded-error' &&
		a.failure?.providerCode === 'OperationAborted' &&
		c?.body === 'complete' &&
		c.xml === 'error' &&
		c.xmlParser === 'accepted' &&
		c.sdkParser === 'not-run' &&
		['none', 's3', 'hcp'].includes(c.namespace) &&
		!c.entityTagPresent &&
		!c.bucketPresent &&
		!c.keyPresent &&
		c.identityUnique &&
		c.operationAbortedVerified === true &&
		c.requestAttempts === 1 &&
		c.replayBlocked === false
	);
}
/** A verified final OperationAborted is a rejected request, never an ACK.
 * Only fresh protocol receipts qualify. Other 200 errors remain ambiguous. */
export function publicationVerdict(
	attempts: ExportPublicationAttempt[],
	protocol?: ExportPublicationRace['protocol']
) {
	if (attempts.some(a => a.outcome === 'pending')) return 'pending' as const;
	if (
		attempts.some(
			a =>
				a.completion?.replayBlocked || (a.requestAttempts !== undefined && a.requestAttempts !== 1)
		)
	)
		return 'ambiguous' as const;
	const winners = attempts.filter(a => a.outcome === 'acknowledged');
	const semantic = protocol === 'hcp-final-error-v1' && attempts.some(finalConflict);
	const winnerBody = winners[0]?.completion;
	return winners.length === 1 &&
		winners[0].validResponse === true &&
		(!semantic || attempts.every(a => a.requestAttempts === 1)) &&
		(!semantic ||
			winners[0].operation === 'PutObject' ||
			(winnerBody?.body === 'complete' &&
				winnerBody.xml === 'result' &&
				winnerBody.xmlParser === 'accepted' &&
				winnerBody.sdkParser === 'resolved' &&
				winnerBody.entityTagPresent &&
				winnerBody.bucketPresent &&
				winnerBody.keyPresent &&
				winnerBody.identityUnique)) &&
		attempts.every(
			a =>
				a === winners[0] ||
				(a.outcome === 'rejected' &&
					a.httpStatus === 409 &&
					a.response === 'provider-error' &&
					(a.wireHttpStatus === undefined || a.wireHttpStatus === 409) &&
					(protocol !== 'hcp-final-error-v1' || a.failure?.providerCode === 'OperationAborted')) ||
				(semantic && finalConflict(a))
		)
		? ('single-winner' as const)
		: ('ambiguous' as const);
}
/** Validate complete new-format intent/receipts before crash recovery can use them.
 * HEAD/key/hash alone, pending operations and all legacy jobs remain insufficient. */
export function publicationCandidate(job: ExportJob, race: ExportPublicationRace) {
	const put = race.key === job.key + '.probe-put-race';
	if (
		(!put && race.key !== job.key + '.probe-race') ||
		(race.protocol === 'hcp-final-error-v1' && job.integrityMode !== 'application-encrypted-hcp') ||
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
		publicationVerdict(race.attempts, race.protocol) !== 'single-winner'
	)
		return;
	const winner = race.attempts.find(a => a.outcome === 'acknowledged')!;
	if (race.protocol === 'hcp-final-error-v1') {
		const v = publicValidation(winner.validation);
		const ids = race.attempts
			.filter(a => a.operation === 'CompleteMultipartUpload')
			.map(a => a.uploadId);
		if (
			!v ||
			!v.status200 ||
			!v.entityTagPresent ||
			!v.entityTagQuoted ||
			!v.versionAbsentOrNull ||
			v.objectIdentityRequired !== (winner.operation === 'CompleteMultipartUpload') ||
			(v.objectIdentityRequired &&
				(!v.bucketPresent || !v.bucketMatches || !v.keyPresent || !v.keyMatches)) ||
			ids.some(id => !id) ||
			new Set(ids).size !== 2
		)
			return;
	}
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
function settledWinner(job: ExportJob, race: ExportPublicationRace) {
	if (
		race.protocol === 'hcp-final-error-v1' &&
		race.attempts.some(a => a.operation === 'CompleteMultipartUpload' && a.uploadAbsent !== true)
	)
		return;
	return publicationCandidate(job, race);
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
			protocol: race.protocol === 'hcp-final-error-v1' ? 'hcp-final-error-v1' : 'legacy',
			target: exportTarget(race.key),
			httpAcknowledgements: race.attempts.filter(
				a => a.wireHttpStatus === 200 || a.httpStatus === 200
			).length,
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
				requestAttempts:
					Number.isInteger(a.requestAttempts) &&
					a.requestAttempts! >= 1 &&
					a.requestAttempts! <= 100
						? a.requestAttempts
						: undefined,
				response: [
					'success',
					'invalid-response',
					'provider-error',
					'embedded-error',
					'sdk-parsing-error',
					'transport-error',
					'body-invalid',
				].includes(a.response || '')
					? a.response
					: 'pending',
				httpAcknowledged: a.wireHttpStatus === 200 || a.httpStatus === 200,
				completion: publicCompletionShape(a.completion),
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

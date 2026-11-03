export type CompletionShape = {
	/** New observations only. Missing fields never establish historical proof. */
	requestAttempts?: number;
	replayBlocked?: boolean;
	operationAbortedVerified?: boolean;
	body: 'complete' | 'empty' | 'incomplete' | 'too-large' | 'unavailable';
	xml: 'result' | 'error' | 'other' | 'malformed' | 'not-parsed';
	namespace: 's3' | 'hcp' | 'none' | 'unsupported' | 'not-parsed';
	xmlParser: 'accepted' | 'rejected' | 'not-run';
	sdkParser: 'resolved' | 'rejected' | 'not-run';
	entityTagPresent: boolean;
	bucketPresent: boolean;
	keyPresent: boolean;
	identityUnique: boolean;
};
const choices = {
	body: ['complete', 'empty', 'incomplete', 'too-large', 'unavailable'],
	xml: ['result', 'error', 'other', 'malformed', 'not-parsed'],
	namespace: ['s3', 'hcp', 'none', 'unsupported', 'not-parsed'],
	xmlParser: ['accepted', 'rejected', 'not-run'],
	sdkParser: ['resolved', 'rejected', 'not-run'],
};
/** Persisted evidence is additive, bounded and never synthesized for old jobs. */
export function publicCompletionShape(value?: CompletionShape): CompletionShape | undefined {
	if (
		!value ||
		!Object.entries(choices).every(([key, allowed]) =>
			allowed.includes(value[key as keyof typeof choices])
		)
	)
		return;
	const flags = ['entityTagPresent', 'bucketPresent', 'keyPresent', 'identityUnique'] as const;
	if (!flags.every(key => typeof value[key] === 'boolean')) return;
	if (value.requestAttempts !== undefined && ![0, 1].includes(value.requestAttempts)) return;
	for (const key of ['replayBlocked', 'operationAbortedVerified'] as const)
		if (value[key] !== undefined && typeof value[key] !== 'boolean') return;
	return Object.fromEntries(
		[
			...Object.keys(choices),
			...flags,
			...['requestAttempts', 'replayBlocked', 'operationAbortedVerified'].filter(
				key => value[key as keyof CompletionShape] !== undefined
			),
		].map(key => [key, value[key as keyof CompletionShape]])
	) as CompletionShape;
}

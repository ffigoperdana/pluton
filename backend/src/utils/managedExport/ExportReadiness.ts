import { exportCapabilityBinding, type ExportConfig, type ExportJob } from './ExportPolicy';

/** Exactly the existing admission contract. No provider calls or inferred proof. */
export function exportProofValid(
	proof: ExportJob | undefined,
	config: ExportConfig,
	now = Date.now()
) {
	return (
		!!proof &&
		proof.state === 'ready' &&
		proof.cleaned &&
		(proof.expiresAt || 0) > now &&
		proof.capabilityBinding === exportCapabilityBinding(config) &&
		!!proof.providerEvidence &&
		!!proof.preflightChecks?.includes('cleanup') &&
		(!config.exportMode ||
			(!!proof.preflightChecks?.includes('application-encryption') &&
				!!proof.preflightChecks?.includes('authenticated-readback')))
	);
}
export function exportReadiness(
	jobs: ExportJob[],
	config: ExportConfig,
	owner: string,
	now = Date.now()
) {
	const matching = jobs.filter(j => j.kind === 'preflight' && j.destination === config.fingerprint);
	const latest = matching.at(-1);
	const valid = exportProofValid(latest, config, now);
	let reason = 'ready';
	if (!valid) {
		reason = !latest
			? jobs.some(j => j.kind === 'preflight')
				? 'destination-mismatch'
				: 'preflight-required'
			: latest.capabilityBinding && latest.capabilityBinding !== exportCapabilityBinding(config)
				? 'destination-mismatch'
				: ['ready', 'expired'].includes(latest.state) && (latest.expiresAt || 0) <= now
					? 'preflight-expired'
					: matching.slice(0, -1).some(j => j.state === 'ready')
						? 'preflight-superseded'
						: ['queued', 'validating'].includes(latest.state)
							? 'preflight-running'
							: !latest.cleaned
								? 'cleanup-pending'
								: latest.state === 'failed'
									? 'provider-checks-failed'
									: 'preflight-required';
	}
	// Nonshared configurations retain their existing per-export preflight behavior.
	return {
		admissionAllowed: !config.allowSharedNamespace || valid,
		preflight: valid ? ('GO' as const) : ('NO-GO' as const),
		requiredBeforeAdmission: config.allowSharedNamespace,
		reason: !config.allowSharedNamespace && !valid ? 'checked-during-export' : reason,
		expiresAt: valid ? latest!.expiresAt : undefined,
		cleanupPending: jobs.some(
			j =>
				j.destination === config.fingerprint &&
				j.kind === 'preflight' &&
				!j.cleaned &&
				['failed', 'cancelled', 'expired'].includes(j.state)
		),
		// Only this owner's journal identifiers can be used for diagnostic actions.
		latest:
			latest?.owner === owner
				? {
						id: latest.id,
						state: latest.state,
						expiresAt: latest.expiresAt,
						cleanupPending:
							!latest.cleaned && ['failed', 'cancelled', 'expired'].includes(latest.state),
					}
				: undefined,
	};
}

/** Fixed enums and bounded counters only; never retain request/provider values. */
const phases = ['sdk', 'request', 'body', 'xml', 'deserialize', 'complete'] as const;
const aborts = ['none', 'deadline', 'cancelled'] as const;
const codes = [
	'none',
	'ECONNRESET',
	'EPIPE',
	'ETIMEDOUT',
	'ENOTFOUND',
	'ECONNREFUSED',
	'EAI_AGAIN',
	'other',
] as const;
export type ExportRequestDiagnostic = {
	phase: (typeof phases)[number];
	elapsedMs: number;
	attempts: number;
	abortedAtStart: boolean;
	abortReason: (typeof aborts)[number];
	transportCode: (typeof codes)[number];
	headersMs?: number;
	httpStatus?: number;
	bodyComplete: boolean;
};
export function publicExportRequest(
	d?: ExportRequestDiagnostic
): ExportRequestDiagnostic | undefined {
	if (!d) return;
	const ms = (n: number | undefined) =>
		Number.isSafeInteger(n) && n! >= 0 && n! <= 604_800_000 ? n : undefined;
	return {
		phase: phases.includes(d.phase) ? d.phase : 'sdk',
		elapsedMs: ms(d.elapsedMs) ?? 0,
		attempts:
			Number.isSafeInteger(d.attempts) && d.attempts >= 0 && d.attempts <= 100 ? d.attempts : 0,
		abortedAtStart: d.abortedAtStart === true,
		abortReason: aborts.includes(d.abortReason) ? d.abortReason : 'none',
		transportCode: codes.includes(d.transportCode) ? d.transportCode : 'other',
		headersMs: ms(d.headersMs),
		httpStatus:
			Number.isInteger(d.httpStatus) && d.httpStatus! >= 100 && d.httpStatus! <= 599
				? d.httpStatus
				: undefined,
		bodyComplete: d.bodyComplete === true,
	};
}
export const exportTransportCode = (e: unknown): ExportRequestDiagnostic['transportCode'] => {
	const code = (e as { code?: string })?.code;
	return codes.find(c => c === code) || (code ? 'other' : 'none');
};

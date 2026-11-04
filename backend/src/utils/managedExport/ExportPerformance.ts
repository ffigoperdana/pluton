/** Constant-size, numeric-only diagnostics; never an ownership or integrity proof. */
export type ExportPerformance = {
	phase?: 'indexing' | 'archive-validation' | 'upload' | 'publication' | 'verification';
	indexedEntries?: number;
	indexingMs?: number;
	archiveValidationMs?: number;
	firstTarByteMs?: number;
	streamMs?: number;
	streamBytes?: number;
	sourceWaitMs?: number;
	destinationWaitMs?: number;
	uploadRequestMs?: number;
	uploadedWireBytes?: number;
	multipartCompletionMs?: number;
	verificationMs?: number;
	lastProgressAt?: number;
};
const durations = [
	'indexingMs',
	'archiveValidationMs',
	'firstTarByteMs',
	'streamMs',
	'sourceWaitMs',
	'destinationWaitMs',
	'uploadRequestMs',
	'multipartCompletionMs',
	'verificationMs',
] as const;
export function publicExportPerformance(value?: ExportPerformance, now = Date.now()) {
	if (!value) return undefined;
	const result: Record<string, number | string> = {};
	if (
		['indexing', 'archive-validation', 'upload', 'publication', 'verification'].includes(
			value.phase || ''
		)
	)
		result.phase = value.phase!;
	for (const key of [...durations, 'indexedEntries', 'streamBytes', 'uploadedWireBytes'] as const) {
		const number = value[key];
		const limit =
			key === 'indexedEntries' ? 500000 : key.endsWith('Bytes') ? 129 * 1024 ** 3 : 7 * 86400000;
		if (typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= limit)
			result[key] = Math.round(number);
	}
	if (
		Number.isSafeInteger(value.lastProgressAt) &&
		value.lastProgressAt! >= 0 &&
		value.lastProgressAt! <= now
	)
		result.lastProgressAgeMs = Math.min(7 * 86400000, now - value.lastProgressAt!);
	if (
		typeof result.streamMs === 'number' &&
		result.streamMs > 0 &&
		typeof result.streamBytes === 'number'
	)
		result.streamBytesPerSecond = Math.round((result.streamBytes * 1000) / result.streamMs);
	if (
		typeof result.uploadRequestMs === 'number' &&
		result.uploadRequestMs > 0 &&
		typeof result.uploadedWireBytes === 'number'
	)
		result.uploadRequestBytesPerSecond = Math.round(
			(result.uploadedWireBytes * 1000) / result.uploadRequestMs
		);
	return result;
}

/** Observe the existing TAR stream without adding buffers or changing its backpressure. */
export function exportStreamTiming(
	observe?: (value: Partial<ExportPerformance>) => void,
	now = () => performance.now()
) {
	if (!observe)
		return { sourceWrite() {}, sourceReady() {}, tarBytes(_count: number) {}, finish() {} };
	const start = now();
	let ready = start,
		waiting = 0,
		bytes = 0,
		first = false,
		lastReport = start;
	const emit = (value: Partial<ExportPerformance>) => {
		try {
			observe?.(value);
		} catch {
			/* Diagnostics cannot change the stream contract. */
		}
	};
	return {
		sourceWrite() {
			waiting += Math.max(0, now() - ready);
		},
		sourceReady() {
			ready = now();
		},
		tarBytes(count: number) {
			bytes += count;
			if (!first) {
				first = true;
				emit({ firstTarByteMs: now() - start });
			}
			const at = now();
			if (at - lastReport >= 5000) {
				lastReport = at;
				emit({ streamMs: at - start, streamBytes: bytes, sourceWaitMs: waiting });
			}
		},
		finish() {
			emit({ streamMs: now() - start, streamBytes: bytes, sourceWaitMs: waiting });
		},
	};
}

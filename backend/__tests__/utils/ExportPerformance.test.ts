import {
	exportStreamTiming,
	publicExportPerformance,
} from '../../src/utils/managedExport/ExportPerformance';

test('measures source wait separately from processing/backpressure and reports first TAR byte once', () => {
	let time = 100;
	const values: any[] = [];
	const timing = exportStreamTiming(
		value => values.push(value),
		() => time
	);
	time += 20;
	timing.sourceWrite();
	time += 5;
	timing.tarBytes(1024);
	time += 75; // processing and blocked destination; not counted as source idle
	timing.sourceReady();
	time += 10;
	timing.sourceWrite();
	timing.tarBytes(2048);
	timing.sourceReady();
	timing.finish();
	expect(values).toEqual([
		{ firstTarByteMs: 25 },
		{ streamMs: 110, streamBytes: 3072, sourceWaitMs: 30 },
	]);
});
test('diagnostics remain bounded and sanitized, including historical malformed metadata', () => {
	expect(publicExportPerformance(undefined)).toBeUndefined();
	expect(
		publicExportPerformance(
			{
				phase: 'upload',
				streamMs: 1000,
				streamBytes: 1024,
				uploadRequestMs: 2000,
				uploadedWireBytes: 2048,
				indexedEntries: 6000,
				lastProgressAt: 500,
				secret: 'captured-private-content',
				sourceWaitMs: Infinity,
				verificationMs: -1,
				indexingMs: 8 * 86400000,
			} as any,
			1500
		)
	).toEqual({
		phase: 'upload',
		streamMs: 1000,
		streamBytes: 1024,
		uploadRequestMs: 2000,
		uploadedWireBytes: 2048,
		indexedEntries: 6000,
		lastProgressAgeMs: 1000,
		streamBytesPerSecond: 1024,
		uploadRequestBytesPerSecond: 1024,
	});
	expect(
		publicExportPerformance({ phase: 'captured-private-content', lastProgressAt: NaN } as any)
	).toEqual({});
});
test('diagnostic consumer failures cannot break the archive stream', () => {
	const timing = exportStreamTiming(() => {
		throw new Error('unavailable');
	});
	expect(() => {
		timing.sourceWrite();
		timing.tarBytes(10);
		timing.sourceReady();
		timing.finish();
	}).not.toThrow();
});

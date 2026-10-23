import {
	sourceDiagnosticsSchema,
	supportsSourceDiagnostics,
} from '../../src/utils/sourceDiagnostics';
const entry = {
	relativePath: 'app/logs/id_rsa',
	entryType: 'file',
	errno: 'EACCES',
	excluded: false,
};
const report = {
	version: 1,
	origin: 'restic',
	problemCount: 1,
	countIsLowerBound: true,
	entries: [entry],
};

describe('private source diagnostic contract', () => {
	it('accepts relative names without accepting contents or credentials', () => {
		expect(sourceDiagnosticsSchema.parse(report)).toEqual(report);
		for (const relativePath of ['report with spaces.pdf', '資料/café.pdf', '.'])
			expect(
				sourceDiagnosticsSchema.safeParse({ ...report, entries: [{ ...entry, relativePath }] })
					.success
			).toBe(true);
		expect(
			sourceDiagnosticsSchema.safeParse({
				...report,
				entries: [{ ...entry, relativePath: undefined }],
			}).success
		).toBe(true);
	});
	it.each([
		'/srv/example-app/key',
		'../outside',
		'a/../b',
		'a\\b',
		'a\nb',
		'a\u001bb',
		'a\u202eb',
		'a' + '\u0301'.repeat(10),
		'a\ud800b',
		'a'.repeat(513),
		'token=synthetic',
		'-----BEGIN PRIVATE KEY-----',
	])('rejects unsafe name %p', relativePath => {
		expect(
			sourceDiagnosticsSchema.safeParse({ ...report, entries: [{ ...entry, relativePath }] })
				.success
		).toBe(false);
	});
	it.each([
		{ ...report, version: 2 },
		{ ...report, problemCount: 0 },
		{ ...report, problemCount: Infinity },
		{ ...report, entries: Array(21).fill(entry), problemCount: 21 },
		{ ...report, entries: [entry, entry] },
		{ ...report, contents: 'synthetic private data' },
		{ ...report, entries: [{ ...entry, errno: 'arbitrary provider error' }] },
		{ ...report, entries: [{ ...entry, excluded: true }] },
		{ ...report, entries: [{ ...entry, contents: 'synthetic private data' }] },
	])('bounds and closes every diagnostic field', value =>
		expect(sourceDiagnosticsSchema.safeParse(value).success).toBe(false)
	);
	it('negotiates only supported stable releases without altering 0.7.0 messages', () => {
		for (const version of ['0.7.1', 'v0.7.1', '0.8.0', '1.0.0'])
			expect(supportsSourceDiagnostics(version)).toBe(true);
		for (const version of ['0.7.0', '0.6.9', '0.7.1-dev', 'unknown', '0.7.1-malicious'])
			expect(supportsSourceDiagnostics(version)).toBe(false);
	});
});

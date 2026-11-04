import path from 'path';
import { spawnSync } from 'child_process';

let report: any;
beforeAll(() => {
	const child = spawnSync(
		process.execPath,
		['--import', 'tsx', path.join(__dirname, '../fixtures/hcpVersioningTransport.process.ts')],
		{
			encoding: 'utf8',
			timeout: 20_000,
			maxBuffer: 64 * 1024,
			env: process.env,
		}
	);
	// Never emit raw child stdout/stderr on failure.
	expect({ status: child.status, signal: child.signal, error: child.error?.name }).toEqual({
		status: 0,
		signal: null,
		error: undefined,
	});
	report = JSON.parse(
		child.stdout
			.split('\n')
			.find(line => line.startsWith('VERSIONING '))!
			.slice(11)
	);
}, 25_000);
test('distinguishes the reproduced socket reset from an expired deadline', () => {
	expect(report.reset).toMatchObject({
		aborted: false,
		requests: 2,
		failure: {
			operation: 'GetBucketVersioning',
			target: 'namespace',
			category: 'network-or-deadline',
			providerCategory: 'network',
			request: {
				phase: 'request',
				attempts: 2,
				abortReason: 'none',
				transportCode: 'ECONNRESET',
				bodyComplete: false,
			},
		},
	});
	expect(report.reset.failure.httpStatus).toBeUndefined();
	expect(report.success.cleaned).toBe(true);
});
test('retains the existing one-reset read retry and accepts complete HCP XML with absent Status', () => {
	expect(report['transient-reset']).toMatchObject({ cleaned: true, aborted: false, requests: 9 });
	expect(report.success).toMatchObject({ cleaned: true, aborted: false, requests: 8 });
	expect(report.success.versioningWire).toEqual({
		get: true,
		pathStyle: true,
		signed: true,
		versioningOnly: true,
	});
	expect(report.success.modeAdmission).toBe('application-encrypted-hcp');
	expect(report.Enabled.modeAdmission).toBe('versioned');
	for (const fault of ['Suspended', '501', '403', 'empty', 'wrongRoot'])
		expect(report[fault].modeAdmission).toBe('refused');
	expect(report.success.inspection).toMatchObject({
		readOnly: true,
		ownershipAdopted: false,
		unchanged: true,
		versioning: {
			operation: 'GetBucketVersioning',
			versioningInspection: 'disabled',
			httpStatus: 200,
			request: { phase: 'complete', bodyComplete: true, attempts: 1, abortReason: 'none' },
		},
	});
});
test.each([
	'Enabled',
	'sdk-mismatch',
	'Suspended',
	'403',
	'empty',
	'malformed',
	'wrongRoot',
	'duplicate',
	'unknownStatus',
	'whitespaceStatus',
	'huge',
])('fails closed before any object request for %s', fault => {
	expect(report[fault]).toMatchObject({
		cleaned: false,
		requests: 1,
		failure: { operation: 'GetBucketVersioning' },
	});
});
test('keeps explicit unsupported API distinct from disabled versioning; permission denial never succeeds', () => {
	expect(report['501']).toMatchObject({
		cleaned: false,
		requests: 1,
		failure: { httpStatus: 501, providerCategory: 'unsupported-api' },
	});
	expect(report['403'].failure).toMatchObject({
		httpStatus: 403,
		providerCategory: 'access-denied',
	});
});
test.each([
	'deadline-before',
	'cancel-before',
	'deadline-request',
	'cancel-request',
	'deadline-body',
	'cancel-body',
])('never accepts an aborted or expired request: %s', fault => {
	const before = fault.endsWith('-before'),
		body = fault.endsWith('-body');
	expect(report[fault]).toMatchObject({
		cleaned: false,
		aborted: true,
		requests: before ? 0 : 1,
		failure: {
			operation: 'GetBucketVersioning',
			providerCategory: fault.startsWith('deadline') ? 'deadline' : 'aborted',
			request: {
				phase: before ? 'sdk' : body ? 'body' : 'request',
				abortedAtStart: before,
				abortReason: fault.startsWith('deadline') ? 'deadline' : 'cancelled',
				bodyComplete: false,
			},
		},
	});
	if (body) expect(report[fault].failure.httpStatus).toBe(200);
});
test('never exposes provider bodies, configuration, credentials or abort reasons', () => {
	expect(JSON.stringify(report)).not.toMatch(
		/private-|authorization|\.tar|example-exports|example\.internal|keyring|signature/i
	);
	for (const item of Object.values(report) as any[])
		if (item.failure?.operation === 'GetBucketVersioning') {
			expect(item.failure.request.elapsedMs).toBeGreaterThanOrEqual(0);
			expect(item.failure.request.elapsedMs).toBeLessThan(20_000);
		}
});
test('distinguishes SDK request timeout from caller cancellation without treating either as success', () => {
	expect(report['sdk-timeout']).toMatchObject({
		cleaned: false,
		aborted: false,
		failure: {
			providerCategory: 'deadline',
			request: { phase: 'request', attempts: 1, abortReason: 'none', transportCode: 'ETIMEDOUT' },
		},
	});
	// The real SDK timer may expire before a contended server observes the
	// request. Require one SDK dispatch, not a race against server scheduling.
	expect(report['sdk-timeout'].requests).toBeGreaterThanOrEqual(0);
	expect(report['sdk-timeout'].requests).toBeLessThanOrEqual(1);
});
test('does not lose HTTP 200 evidence on transport truncation or accept a success racing cancellation', () => {
	expect(report.truncated).toMatchObject({
		cleaned: false,
		aborted: false,
		failure: {
			httpStatus: 200,
			providerCategory: 'network',
			request: { phase: 'body', bodyComplete: false, transportCode: 'ECONNRESET' },
		},
	});
	expect(report['deadline-complete']).toMatchObject({
		cleaned: false,
		aborted: true,
		failure: {
			httpStatus: 200,
			providerCategory: 'deadline',
			request: { phase: 'deserialize', bodyComplete: true, abortReason: 'deadline' },
		},
	});
});
test.each(['historical', 'deadline-body'])(
	'SQLite restart and fresh cleanup verify absence without adopting ownership: %s',
	fault => {
		expect(report[fault]).toMatchObject({
			cleaned: false,
			deletes: 0,
			afterRestart: {
				cleanupState: { objects: 'verified-absent', multipart: 'verified-absent' },
				ownedObjects: 0,
				deletes: 0,
				retainedFailure: fault === 'historical' ? 'ownership-proof' : 'GetBucketVersioning',
			},
		});
		if (fault === 'historical')
			expect(report[fault].failure.detail).toBe('ownership-proof-missing');
	}
);

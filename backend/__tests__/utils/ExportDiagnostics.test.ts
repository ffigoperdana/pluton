import {
	ExportOperationError,
	exportDiagnostic,
	publicExportDiagnostic,
} from '../../src/utils/managedExport/ExportDiagnostics';
import type { ExportJob } from '../../src/utils/managedExport/ExportPolicy';
import { publicExportPublications } from '../../src/utils/managedExport/ExportPublication';
import type { PublicationValidation } from '../../src/utils/managedExport/ExportPublication';

describe('bounded export diagnostics', () => {
	test('schema evidence projects only complete boolean allowlist fields and never copies provider values', () => {
		const validation = {
			status200: true,
			entityTagPresent: true,
			entityTagQuoted: false,
			versionAbsentOrNull: true,
			objectIdentityRequired: true,
			bucketPresent: true,
			bucketMatches: false,
			keyPresent: false,
			keyMatches: false,
		};
		const job = {
			key: 'fixture.tar',
			publicationRaces: [
				{
					key: 'fixture.tar.probe-race',
					state: 'ambiguous',
					attempts: [
						{
							outcome: 'acknowledged',
							validResponse: false,
							competitor: 'multipart-a',
							operation: 'CompleteMultipartUpload',
							validation: {
								...validation,
								raw: 'private-response',
								key: 'private-key',
								headers: 'private-headers',
							},
						},
					],
				},
			],
		} as unknown as ExportJob;
		const result = publicExportPublications(job)[0].operations[0];
		expect(result.validation).toEqual(validation);
		expect(result.validationEvidence).toBe('recorded');
		expect(JSON.stringify(result)).not.toContain('private-');
		job.publicationRaces![0].attempts[0].validation = {
			...validation,
			keyMatches: 'private-value',
		} as unknown as PublicationValidation;
		expect(publicExportPublications(job)[0].operations[0]).toMatchObject({
			validationEvidence: 'not-recorded',
		});
		expect(publicExportPublications(job)[0].operations[0].validation).toBeUndefined();
	});
	test('old 200 receipts do not manufacture missing schema evidence or change retained failure history', () => {
		const job = {
			key: 'fixture.tar',
			publicationRaces: [
				{
					key: 'fixture.tar.probe-race',
					state: 'ambiguous',
					attempts: [
						{
							outcome: 'acknowledged',
							validResponse: true,
							httpStatus: 200,
							response: 'success',
							competitor: 'multipart-a',
							operation: 'CompleteMultipartUpload',
						},
						{
							outcome: 'acknowledged',
							validResponse: false,
							httpStatus: 200,
							response: 'invalid-response',
							competitor: 'multipart-b',
							operation: 'CompleteMultipartUpload',
						},
					],
				},
			],
			preflightFailure: { detail: 'race-multiple-successes' },
		} as unknown as ExportJob;
		const before = JSON.stringify(job),
			report = publicExportPublications(job)[0];
		expect(report).toMatchObject({
			acknowledgedResponses: 2,
			validSuccessResponses: 1,
			multipleSuccesses: false,
			ambiguityRemaining: true,
		});
		expect(
			report.operations.every(
				a => a.validationEvidence === 'not-recorded' && a.validation === undefined
			)
		).toBe(true);
		expect(JSON.stringify(job)).toBe(before);
	});
	test('publication projection is bounded and removes corrupted/private receipt values', () => {
		const job = {
			key: 'fixture.tar',
			publicationRaces: [
				{ key: 'private-key', attempts: [] },
				{ key: 'fixture.tar.probe-race', attempts: null },
				{
					key: 'fixture.tar.probe-race',
					state: 'private-state',
					attempts: [
						{
							competitor: 'private-competitor',
							operation: 'private-operation',
							response: 'private-response',
							httpStatus: 999,
							wireHttpStatus: 999,
							etag: 'private-etag',
							uploadId: 'private-upload',
							failure: { detail: 'private-detail' },
						},
					],
				},
			],
		} as unknown as ExportJob;
		const report = publicExportPublications(job);
		expect(report).toHaveLength(1);
		expect(report[0].ambiguityRemaining).toBe(true);
		expect(JSON.stringify(report)).not.toContain('private-');
		expect(publicExportPublications({} as ExportJob)).toEqual([]);
	});
	test('unknown and race diagnostics never borrow acknowledgement or proof from another object', () => {
		const job = {
			key: 'fixture.tar',
			creationReceipts: [{ key: 'fixture.tar.probe', acknowledged: true }],
			ownedObjects: [{ key: 'fixture.tar.probe' }],
		} as ExportJob;
		for (const target of ['unknown', 'namespace', 'race', 'put-race'] as const) {
			const d = exportDiagnostic(
				new ExportOperationError(
					'CompleteMultipartUpload',
					{},
					'provider-error',
					'object-mismatch',
					target
				),
				job,
				'preflight',
				'concurrent-publication'
			);
			expect(d).toMatchObject({
				target,
				creationAcknowledged: false,
				durableOwnershipProof: false,
			});
		}
	});
	test.each([
		[{ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }, 'access-denied'],
		[{ name: 'NotImplemented', $metadata: { httpStatusCode: 501 } }, 'unsupported-api'],
		[{ code: 'CERT_HAS_EXPIRED' }, 'tls-validation'],
		[{ code: 'ECONNRESET' }, 'network'],
		[{ name: 'TimeoutError' }, 'deadline'],
		[{ name: 'AbortError' }, 'aborted'],
		[{ name: 'private-unrecognized-provider-code' }, 'service-error'],
	])('allowlists provider category without messages or headers: %j', (fields, expected) => {
		const error = Object.assign(new Error('private-provider-message'), fields, {
			headers: { authorization: 'private-header-value' },
			$response: { body: 'private-body' },
		});
		const diagnostic = exportDiagnostic(
			new ExportOperationError('PutObject', error),
			{} as ExportJob,
			'preflight',
			'write-once-creation'
		);
		expect(diagnostic.providerCategory).toBe(expected);
		expect(JSON.stringify(diagnostic)).not.toMatch(/private-|authorization|headers|\$response/);
		expect(Buffer.byteLength(JSON.stringify(diagnostic))).toBeLessThan(700);
	});
	test('public projection removes arbitrary fields, strings and non-HTTP numeric values', () => {
		const bad = {
			stage: 'private-stage',
			capability: 'private-capability',
			operation: 'private-operation',
			category: 'private-category',
			providerCategory: 'private-provider',
			detail: 'private-detail',
			httpStatus: 999,
			creationAcknowledged: 'private-receipt',
			durableOwnershipProof: 'private-proof',
			objectCleanupPending: 'private-state',
			multipartCleanupPending: 'private-state',
			extra: 'private-extra',
		};
		const result = publicExportDiagnostic(bad as any);
		expect(JSON.stringify(result)).not.toContain('private-');
		expect(result).toMatchObject({
			operation: 'unknown',
			objectCleanupPending: true,
			multipartCleanupPending: true,
			creationAcknowledged: false,
			durableOwnershipProof: false,
		});
		expect(result?.httpStatus).toBeUndefined();
	});
});

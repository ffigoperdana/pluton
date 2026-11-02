import {
	ExportOperationError,
	exportDiagnostic,
	publicExportDiagnostic,
} from '../../src/utils/managedExport/ExportDiagnostics';
import type { ExportJob } from '../../src/utils/managedExport/ExportPolicy';

describe('bounded export diagnostics', () => {
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

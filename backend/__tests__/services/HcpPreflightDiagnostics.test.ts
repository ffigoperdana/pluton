/** Local HTTP protocol responses processed by the real pinned AWS SDK.
 * No socket, external destination or backup data is used. */
import crypto from 'crypto';
import { Readable } from 'stream';
import { S3ExportStorage } from '../../src/utils/managedExport/S3ExportStorage';
import { exportConfiguration, type ExportJob } from '../../src/utils/managedExport/ExportPolicy';

jest.mock('../../src/utils/logger', () => ({ planLogger: () => ({ info: jest.fn() }) }));

function protocol(fault: string) {
	const config = exportConfiguration({
		MANAGED_EXPORT_ENABLED: 'true',
		MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE: 'true',
		MANAGED_EXPORT_ENDPOINT: 'https://s3.example.internal',
		MANAGED_EXPORT_BUCKET: 'example-exports',
		MANAGED_EXPORT_ACCESS_KEY_ID: crypto.randomBytes(16).toString('hex'),
		MANAGED_EXPORT_SECRET_ACCESS_KEY: crypto.randomBytes(32).toString('hex'),
	})!;
	const id = crypto.randomUUID();
	const job: ExportJob = {
		id,
		owner: 'fixture-owner',
		kind: 'preflight',
		binding: {
			backupId: 'backup-01',
			planId: 'plan-01',
			sourceId: 'app-01',
			repositoryId: 'repository-01',
			snapshotId: 'a'.repeat(64),
			mode: 'full',
		},
		destination: config.fingerprint,
		key: `${config.prefix}/${id}.tar`,
		state: 'validating',
		createdAt: 1,
		updatedAt: 1,
		processedBytes: 0,
		uploadedBytes: 0,
		reservedBytes: 0,
		cleaned: false,
		cleanupAttempts: 0,
	};
	const storage = new S3ExportStorage(config);
	let body: Buffer | undefined,
		metadata: Record<string, string> = {},
		puts = 0;
	const calls: string[] = [];
	const etag = '"fixture-etag"';
	const reply = (
		statusCode: number,
		headers: Record<string, string> = {},
		value: string | Buffer = ''
	) => ({
		response: {
			statusCode,
			headers,
			body: Readable.from([value]),
		},
	});
	const error = (status: number, code: string) =>
		reply(
			status,
			{ 'content-type': 'application/xml' },
			`<Error><Code>${code}</Code><Message>synthetic-private-provider-output</Message></Error>`
		);
	const handler = jest.spyOn(storage.client.config.requestHandler, 'handle') as jest.Mock;
	handler.mockImplementation(async (request: any) => {
		const query = request.query || {};
		calls.push(
			request.method +
				':' +
				(Object.keys(query)
					.filter(k => !k.startsWith('x-'))
					.join(',') || 'object')
		);
		if ('versioning' in query) {
			if (fault === 'versioning-unsupported') return error(501, 'NotImplemented');
			return reply(200, { 'content-type': 'application/xml' }, '<VersioningConfiguration/>');
		}
		if ('uploads' in query) {
			if (fault === 'list-incompatible') return error(501, 'NotImplemented');
			return reply(
				200,
				{ 'content-type': 'application/xml' },
				'<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>'
			);
		}
		if (request.method === 'PUT') {
			if (fault === 'put-invalid-request') return error(400, 'InvalidRequest');
			if (puts++) return error(503, 'SlowDown'); // independent probe failure AFTER durable creation
			body = Buffer.isBuffer(request.body) ? request.body : Buffer.from(request.body);
			metadata = Object.fromEntries(
				Object.entries(request.headers).filter(([k]) => k.startsWith('x-amz-meta-'))
			) as Record<string, string>;
			if (fault === 'lost-put')
				throw Object.assign(new Error('synthetic-private-provider-output'), { code: 'ECONNRESET' });
			return reply(200, fault === 'missing-etag' || fault === 'list-incompatible' ? {} : { etag });
		}
		if (request.method === 'HEAD') {
			if (!body || !request.path.endsWith('.probe')) return reply(404);
			return reply(fault === 'unexpected-head' ? 206 : 200, {
				...metadata,
				'etag': fault === 'mismatched-etag' ? '"different"' : etag,
				'content-length': String(body.length),
				'last-modified': new Date(1000).toUTCString(),
				...(fault === 'missing-sse'
					? {}
					: { 'x-amz-server-side-encryption': fault === 'unsupported-sse' ? 'aws:kms' : 'AES256' }),
			});
		}
		if (request.method === 'GET')
			return reply(
				200,
				{
					...metadata,
					etag,
					'content-length': String(body!.length),
					'last-modified': new Date(1000).toUTCString(),
					'x-amz-server-side-encryption': 'AES256',
				},
				body!
			);
		if (request.method === 'DELETE') return error(403, 'AccessDenied');
		throw new Error('Unexpected local protocol operation.');
	});
	return {
		storage,
		job,
		calls,
		config,
		update: (fields: Partial<ExportJob>) => Object.assign(job, structuredClone(fields)),
	};
}

describe('real SDK write-once preflight diagnostics', () => {
	test.each([
		['missing-etag', 'creation-response', 'missing-etag', true, 200],
		['mismatched-etag', 'HeadObject', 'etag-mismatch', true, 200],
		['missing-sse', 'HeadObject', 'sse-s3-unverified', true, 200],
		['unsupported-sse', 'HeadObject', 'sse-s3-unverified', true, 200],
		['unexpected-head', 'HeadObject', 'unexpected-head-status', true, 206],
		['lost-put', 'PutObject', 'provider-error', false, undefined],
	])(
		'protocol %s: no inferred ownership or delete',
		async (fault, operation, detail, acknowledged, status) => {
			const f = protocol(fault as string);
			try {
				await expect(
					f.storage.preflight(f.job, AbortSignal.timeout(2000), f.update)
				).rejects.toThrow();
				expect(f.job.preflightFailure).toMatchObject({
					capability: 'write-once-creation',
					operation,
					detail,
					creationAcknowledged: acknowledged,
					durableOwnershipProof: false,
				});
				expect(f.job.preflightFailure?.httpStatus).toBe(status);
				expect(f.job.cleanupFailure).toMatchObject({
					operation: 'ownership-proof',
					detail: 'ownership-proof-missing',
				});
				expect(f.calls.some(c => c.startsWith('DELETE'))).toBe(false);
				expect(f.calls.filter(c => c.startsWith('PUT'))).toHaveLength(1); // never retry uncertain writes
				expect(JSON.stringify([f.job.preflightFailure, f.job.cleanupFailure])).not.toMatch(
					/synthetic-private|fixture-etag|example\.internal/
				);
			} finally {
				f.storage.close();
			}
		}
	);
	test('multipart-list failure keeps the earlier creation failure and precise SDK status', async () => {
		const f = protocol('list-incompatible');
		try {
			await expect(
				f.storage.preflight(f.job, AbortSignal.timeout(2000), f.update)
			).rejects.toThrow();
			expect(f.job.preflightFailure?.detail).toBe('missing-etag');
			expect(f.job.cleanupFailure).toMatchObject({
				operation: 'ListMultipartUploads',
				httpStatus: 501,
				providerCategory: 'unsupported-api',
				providerCode: 'NotImplemented',
			});
		} finally {
			f.storage.close();
		}
	});
	test('a provider rejection retains its exact allowlisted API code without its raw response', async () => {
		const f = protocol('put-invalid-request');
		try {
			await expect(
				f.storage.preflight(f.job, AbortSignal.timeout(2000), f.update)
			).rejects.toThrow();
			expect(f.job.preflightFailure).toMatchObject({
				operation: 'PutObject',
				httpStatus: 400,
				providerCode: 'InvalidRequest',
				creationAcknowledged: false,
				durableOwnershipProof: false,
			});
			expect(f.job.cleanupFailure).toBeUndefined();
			expect(f.job.cleanupState).toEqual({
				objects: 'verified-absent',
				multipart: 'verified-absent',
			});
			expect(JSON.stringify(f.job.preflightFailure)).not.toContain('synthetic-private');
		} finally {
			f.storage.close();
		}
	});
	test('DELETE denial preserves acknowledged, durable proof and original collision-stage failure', async () => {
		const f = protocol('delete-denied');
		try {
			await expect(
				f.storage.preflight(f.job, AbortSignal.timeout(2000), f.update)
			).rejects.toThrow();
			expect(f.job.preflightFailure).toMatchObject({
				capability: 'collision-rejection',
				operation: 'PutObject',
				httpStatus: 503,
			});
			expect(f.job.cleanupFailure).toMatchObject({
				operation: 'DeleteObject',
				httpStatus: 403,
				providerCategory: 'access-denied',
				providerCode: 'AccessDenied',
				creationAcknowledged: true,
				durableOwnershipProof: true,
			});
			expect(f.job.ownedObjects).toHaveLength(1);
		} finally {
			f.storage.close();
		}
	});
});

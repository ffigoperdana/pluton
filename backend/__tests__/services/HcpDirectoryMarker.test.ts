/** Read-only SDK and wire-protocol fixtures, never a claim about production HCP. */
import crypto from 'crypto';
import { Readable } from 'stream';
import { S3ExportStorage } from '../../src/utils/managedExport/S3ExportStorage';
import { exportConfiguration } from '../../src/utils/managedExport/ExportPolicy';
import { publicExportDiagnostic } from '../../src/utils/managedExport/ExportDiagnostics';

jest.mock('../../src/utils/logger', () => ({ planLogger: () => ({ info: jest.fn() }) }));
const active: S3ExportStorage[] = [];
afterEach(() => {
	for (const storage of active.splice(0)) storage.close();
});
const signal = () => AbortSignal.timeout(5000);
const page = (fields: Record<string, unknown> = {}) => ({
	$metadata: { httpStatusCode: 200 },
	IsTruncated: false,
	...fields,
});
function fixture() {
	const config = exportConfiguration({
		MANAGED_EXPORT_ENABLED: 'true',
		MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE: 'true',
		MANAGED_EXPORT_ENDPOINT: 'https://s3.example.internal',
		MANAGED_EXPORT_BUCKET: 'example-exports',
		MANAGED_EXPORT_ACCESS_KEY_ID: crypto.randomBytes(16).toString('hex'),
		MANAGED_EXPORT_SECRET_ACCESS_KEY: crypto.randomBytes(32).toString('hex'),
	})!;
	const storage = new S3ExportStorage(config);
	active.push(storage);
	const marker = {
		Key: config.prefix + '/',
		Size: 0,
		ETag: '"empty-etag"',
		LastModified: new Date(1000),
	};
	const head = {
		$metadata: { httpStatusCode: 200 },
		ContentLength: 0,
		ETag: marker.ETag,
		LastModified: marker.LastModified,
	};
	const send = jest.spyOn(storage.client, 'send') as jest.Mock;
	const objects = jest.fn(async (_input: any) => page({ Contents: [marker] }));
	const uploads = jest.fn(async (_input: any) => page());
	const inspect = jest.fn(async () => head);
	send.mockImplementation(async (command: any) => {
		switch (command.constructor.name) {
			case 'GetBucketVersioningCommand':
				return {};
			case 'ListObjectsV2Command':
				return objects(command.input);
			case 'ListMultipartUploadsCommand':
				return uploads(command.input);
			case 'HeadObjectCommand':
				return inspect();
			default:
				throw new Error('Inventory must never mutate or read object bodies');
		}
	});
	return { config, storage, marker, head, send, objects, uploads, inspect };
}
async function refused(
	f: ReturnType<typeof fixture>,
	detail: string,
	category = 'unexpected-response'
) {
	const error = await f.storage.inventory([], signal()).catch(e => e);
	expect(error).toMatchObject({
		capability: 'destination-isolation',
		category,
		diagnostic: { detail },
	});
	const diagnostic = publicExportDiagnostic(error.diagnostic);
	expect(diagnostic).toMatchObject({
		creationAcknowledged: false,
		durableOwnershipProof: false,
		objectCleanupPending: false,
		multipartCleanupPending: false,
	});
	expect(JSON.stringify(diagnostic)).not.toMatch(
		/private-|example.internal|pluton-temporary|authorization/
	);
	expect(Buffer.byteLength(JSON.stringify(diagnostic))).toBeLessThan(700);
	expect(
		f.send.mock.calls.every(([c]: any) =>
			[
				'GetBucketVersioningCommand',
				'ListObjectsV2Command',
				'ListMultipartUploadsCommand',
				'HeadObjectCommand',
			].includes(c.constructor.name)
		)
	).toBe(true);
}

describe('exact HCP structural directory marker', () => {
	test('LIST fractional seconds agree with the second-precision HTTP HEAD date', async () => {
		const f = fixture();
		f.marker.LastModified = new Date(1234);
		expect(await f.storage.inventory([], signal())).toMatchObject({
			directoryMarker: 'verified-empty',
		});
	});
	test('empty prefix remains ready without HEAD or a marker claim', async () => {
		const f = fixture();
		f.objects.mockResolvedValue(page());
		expect(await f.storage.inventory([], signal())).toEqual({
			objects: 0,
			uploads: 0,
			exclusive: true,
		});
		expect(f.inspect).not.toHaveBeenCalled();
	});
	test('zero-byte LIST plus conditional, matching HEAD is excluded from export counts', async () => {
		const f = fixture();
		expect(await f.storage.inventory([], signal())).toEqual({
			objects: 0,
			uploads: 0,
			exclusive: true,
			directoryMarker: 'verified-empty',
		});
		const head = f.send.mock.calls.find(
			([c]: any) => c.constructor.name === 'HeadObjectCommand'
		)![0] as any;
		expect(head.input).toEqual({
			Bucket: f.config.bucket,
			Key: f.marker.Key,
			IfMatch: f.marker.ETag,
		});
		expect(f.inspect).toHaveBeenCalledTimes(1);
	});
	test.each([
		['list-nonzero', { Size: 1 }, {}, 'directory-marker-nonzero'],
		['list-size-missing', { Size: undefined }, {}, 'directory-marker-unverified'],
		['list-string-size', { Size: '0' }, {}, 'directory-marker-unverified'],
		['list-negative-size', { Size: -1 }, {}, 'directory-marker-unverified'],
		['list-etag-missing', { ETag: undefined }, {}, 'directory-marker-unverified'],
		['list-time-missing', { LastModified: undefined }, {}, 'directory-marker-unverified'],
		['head-nonzero', {}, { ContentLength: 1 }, 'directory-marker-nonzero'],
		['head-size-missing', {}, { ContentLength: undefined }, 'directory-marker-unverified'],
		['head-etag-mismatch', {}, { ETag: '"different"' }, 'directory-marker-unverified'],
		['head-time-mismatch', {}, { LastModified: new Date(2000) }, 'directory-marker-unverified'],
		['head-invalid-time', {}, { LastModified: new Date(NaN) }, 'directory-marker-unverified'],
		['head-status', {}, { $metadata: { httpStatusCode: 206 } }, 'directory-marker-unverified'],
		['head-delete-marker', {}, { DeleteMarker: true }, 'directory-marker-unverified'],
		['head-version', {}, { VersionId: 'private-version' }, 'directory-marker-unverified'],
	])('blocks ambiguous/non-inert marker: %s', async (_name, listFields, headFields, detail) => {
		const f = fixture();
		Object.assign(f.marker, listFields);
		Object.assign(f.head, headFields);
		await refused(f, detail as string);
	});
	test.each(['nested/', 'nested/foreign.tar', '../', '/', 'foreign.tar'])(
		'never exempts foreign descendants: %s',
		async suffix => {
			const f = fixture();
			f.marker.Key += suffix;
			await refused(f, 'foreign-object');
			expect(f.inspect).not.toHaveBeenCalled();
		}
	);
	test('root marker exemption never covers an unknown multipart upload', async () => {
		const f = fixture();
		f.uploads.mockResolvedValue(
			page({ Uploads: [{ Key: f.marker.Key, UploadId: 'private-upload' }] })
		);
		await refused(f, 'unknown-multipart');
	});
	test.each([
		[{ name: 'TimeoutError' }, 'network-or-deadline', 'deadline'],
		[{ code: 'ECONNREFUSED' }, 'network-or-deadline', 'network'],
		[
			{ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } },
			'access-denied',
			'access-denied',
		],
		[
			{ name: 'NotImplemented', $metadata: { httpStatusCode: 501 } },
			'unsupported-api',
			'unsupported-api',
		],
	])('preserves bounded provider diagnostics: %j', async (fields, category, providerCategory) => {
		const f = fixture();
		f.inspect.mockRejectedValue(
			Object.assign(new Error('private-provider-body'), fields, {
				headers: { authorization: 'private-value' },
			})
		);
		await refused(f, 'provider-error', category as string);
		await expect(f.storage.inventory([], signal())).rejects.toMatchObject({
			diagnostic: { operation: 'HeadObject', providerCategory },
		});
	});
	test('cancellation after marker HEAD cannot publish ready or adopt cleanup ownership', async () => {
		const f = fixture(),
			controller = new AbortController();
		f.inspect.mockImplementation(async () => {
			controller.abort();
			return f.head;
		});
		await expect(f.storage.inventory([], controller.signal)).rejects.toThrow();
		expect(
			f.send.mock.calls.every(([c]: any) => !/Put|Delete|AbortMultipart/.test(c.constructor.name))
		).toBe(true);
	});
});

describe('bounded complete inventory enumeration', () => {
	test('versioned S3 never receives the nonversioned structural exemption', async () => {
		const f = fixture();
		f.send.mockImplementation(async (command: any) => {
			if (command.constructor.name === 'GetBucketVersioningCommand') return { Status: 'Enabled' };
			if (command.constructor.name === 'ListObjectVersionsCommand')
				return {
					Versions: [{ Key: f.marker.Key, VersionId: 'foreign-version', Size: 0 }],
					IsTruncated: false,
				};
			throw new Error('Versioned inventory must reject the unowned marker');
		});
		await expect(f.storage.inventory([], signal())).rejects.toMatchObject({
			capability: 'destination-isolation',
		});
		expect(f.inspect).not.toHaveBeenCalled();
	});
	test('multipart non-adjacent token cycles and collapsed CommonPrefixes are blocked', async () => {
		const f = fixture();
		let n = 0;
		f.uploads.mockImplementation(async () =>
			page({
				IsTruncated: true,
				NextKeyMarker: f.config.prefix + '/last',
				NextUploadIdMarker: ['a', 'b', 'a'][n++],
			})
		);
		await refused(f, 'listing-incomplete');
		expect(f.uploads).toHaveBeenCalledTimes(3);
		f.uploads.mockResolvedValue(page({ CommonPrefixes: [{ Prefix: f.marker.Key + 'hidden/' }] }));
		await refused(f, 'listing-invalid');
	});
	test('follows valid object and multipart tokens; root marker verified once', async () => {
		const f = fixture();
		f.objects
			.mockResolvedValueOnce(
				page({ Contents: [f.marker], IsTruncated: true, NextContinuationToken: 'opaque-a' })
			)
			.mockResolvedValueOnce(page());
		f.uploads
			.mockResolvedValueOnce(
				page({
					IsTruncated: true,
					NextKeyMarker: f.config.prefix + '/last.tar',
					NextUploadIdMarker: 'opaque-upload',
				})
			)
			.mockResolvedValueOnce(page());
		expect(await f.storage.inventory([], signal())).toMatchObject({
			objects: 0,
			uploads: 0,
			directoryMarker: 'verified-empty',
		});
		expect(f.objects.mock.calls[1][0]).toMatchObject({
			ContinuationToken: 'opaque-a',
			MaxKeys: 100,
		});
		expect(f.uploads.mock.calls[1][0]).toMatchObject({
			KeyMarker: f.config.prefix + '/last.tar',
			UploadIdMarker: 'opaque-upload',
			MaxUploads: 100,
		});
		expect(f.inspect).toHaveBeenCalledTimes(1);
	});
	test.each([
		{ IsTruncated: true },
		{ IsTruncated: true, NextContinuationToken: 42 },
		{ IsTruncated: true, NextContinuationToken: ' ' },
		{ IsTruncated: true, NextContinuationToken: 'x'.repeat(2049) },
		{ IsTruncated: false, NextContinuationToken: 'unexpected' },
	])('rejects missing/malformed continuation evidence: %j', async fields => {
		const f = fixture();
		f.objects.mockResolvedValue(page(fields));
		await refused(f, 'listing-incomplete');
	});
	test.each([
		{ IsTruncated: undefined },
		{ IsTruncated: 'false' },
		{ Contents: null },
		{ KeyCount: 2 },
		{ CommonPrefixes: [{ Prefix: 'private-prefix/' }] },
		{ $metadata: { httpStatusCode: 206 } },
		{ Prefix: 'private-prefix/' },
	])('rejects malformed or incomplete responses: %j', async fields => {
		const f = fixture();
		f.objects.mockResolvedValue(page(fields));
		await refused(f, 'listing-invalid');
	});
	test('rejects a non-adjacent token cycle rather than silently exhausting the page bound', async () => {
		const f = fixture();
		let n = 0;
		f.objects.mockImplementation(async () =>
			page({ IsTruncated: true, NextContinuationToken: ['a', 'b', 'a'][n++] })
		);
		await refused(f, 'listing-incomplete');
		expect(f.objects).toHaveBeenCalledTimes(3);
	});
	test('stops at eight pages and 100 rows per page', async () => {
		const f = fixture();
		let n = 0;
		f.objects.mockImplementation(async () =>
			page({ IsTruncated: true, NextContinuationToken: `token-${++n}` })
		);
		await refused(f, 'listing-incomplete');
		expect(f.objects).toHaveBeenCalledTimes(8);
		f.objects.mockResolvedValue(page({ Contents: Array(101).fill(f.marker) }));
		await refused(f, 'listing-invalid');
	});
	test('duplicate marker on a later page is not counted or reverified', async () => {
		const f = fixture();
		f.objects.mockResolvedValueOnce(
			page({ Contents: [f.marker], IsTruncated: true, NextContinuationToken: 'next' })
		);
		await refused(f, 'listing-invalid');
		expect(f.inspect).toHaveBeenCalledTimes(1);
	});
	test.each([
		{ IsTruncated: true },
		{ IsTruncated: true, NextKeyMarker: 'foreign/', NextUploadIdMarker: 'id' },
		{ IsTruncated: true, NextKeyMarker: 'pluton-temporary-exports/last', NextUploadIdMarker: 1 },
		{ IsTruncated: false, NextUploadIdMarker: 'unexpected' },
	])('rejects incomplete multipart pagination: %j', async fields => {
		const f = fixture();
		f.uploads.mockResolvedValue(page(fields));
		await refused(f, 'listing-incomplete');
	});
});

describe('real pinned AWS SDK XML deserialization', () => {
	test.each(['valid', 'missing-size', 'nonzero', 'missing-truncation', 'foreign', 'access-denied'])(
		'HCP-style ListBucketResult and conditional HEAD: %s',
		async fault => {
			const f = fixture();
			f.send.mockRestore();
			const reply = (statusCode: number, body: string, headers: Record<string, string> = {}) => ({
				response: {
					statusCode,
					headers: { 'content-type': 'application/xml', ...headers },
					body: Readable.from([body]),
				},
			});
			const handler = jest.spyOn(f.storage.client.config.requestHandler, 'handle') as jest.Mock;
			handler.mockImplementation(async (request: any) => {
				if ('versioning' in request.query) return reply(200, '<VersioningConfiguration/>');
				if ('uploads' in request.query)
					return reply(
						200,
						'<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>'
					);
				if (request.method === 'HEAD') {
					expect(request.headers['if-match']).toBe('"empty-etag"');
					return reply(200, '', {
						'content-length': '0',
						'etag': '"empty-etag"',
						'last-modified': new Date(1000).toUTCString(),
					});
				}
				if (fault === 'access-denied')
					return reply(
						403,
						'<Error><Code>AccessDenied</Code><Message>private-provider-body</Message></Error>'
					);
				return reply(
					200,
					`<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
					<Name>example-exports</Name><Prefix>${f.config.prefix}/</Prefix><KeyCount>1</KeyCount><MaxKeys>100</MaxKeys>
					${fault === 'missing-truncation' ? '' : '<IsTruncated>false</IsTruncated>'}<Contents>
					<Key>${f.marker.Key}${fault === 'foreign' ? 'nested/' : ''}</Key>
					<LastModified>1970-01-01T00:00:01.000Z</LastModified><ETag>&quot;empty-etag&quot;</ETag>
					${fault === 'missing-size' ? '' : `<Size>${fault === 'nonzero' ? '1' : '0'}</Size>`}<StorageClass>STANDARD</StorageClass>
					</Contents></ListBucketResult>`
				);
			});
			if (fault === 'valid')
				expect(await f.storage.inventory([], signal())).toMatchObject({
					directoryMarker: 'verified-empty',
					objects: 0,
				});
			else
				await expect(f.storage.inventory([], signal())).rejects.toMatchObject({
					capability: 'destination-isolation',
					diagnostic: {
						detail:
							fault === 'missing-size'
								? 'directory-marker-unverified'
								: fault === 'nonzero'
									? 'directory-marker-nonzero'
									: fault === 'missing-truncation'
										? 'listing-invalid'
										: fault === 'foreign'
											? 'foreign-object'
											: 'provider-error',
					},
				});
			expect(handler.mock.calls.every(([r]: any) => ['GET', 'HEAD'].includes(r.method))).toBe(true);
		}
	);
});

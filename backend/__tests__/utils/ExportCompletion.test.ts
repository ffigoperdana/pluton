import crypto from 'crypto';
import { Readable } from 'stream';
import { createRequire } from 'module';
import { S3Client, CompleteMultipartUploadCommand } from '@aws-sdk/client-s3';
import {
	checkedCompletion,
	COMPLETION_BODY_LIMIT,
} from '../../src/utils/managedExport/ExportCompletion';
import { publicCompletionShape } from '../../src/utils/managedExport/ExportCompletionShape';
import { publicationValidation } from '../../src/utils/managedExport/ExportPublication';
import {
	exportDiagnostic,
	publicExportDiagnostic,
} from '../../src/utils/managedExport/ExportDiagnostics';
import type { ExportJob } from '../../src/utils/managedExport/ExportPolicy';
import type { ExportConfig } from '../../src/utils/managedExport/ExportPolicy';
import { HcpWriteOnceStorage } from '../../src/utils/managedExport/HcpWriteOnceStorage';

const bucket = 'example-exports',
	key = 'disposable/' + crypto.randomUUID();
const identity = `<Bucket>${bucket}</Bucket><Key>${key}</Key><ETag>&quot;private-tag&quot;</ETag>`;
const xml = (inside = identity, attrs = '') =>
	`<CompleteMultipartUploadResult${attrs}>${inside}</CompleteMultipartUploadResult>`;
const clients: S3Client[] = [];
afterEach(() => {
	clients.splice(0).forEach(client => client.destroy());
});
function fixture(
	body: Readable | Buffer | string | undefined,
	headers: Record<string, string> = {},
	statusCode = 200
) {
	const handle = jest.fn(async () => ({
		response: {
			statusCode,
			headers,
			body: body instanceof Readable || body === undefined ? body : Readable.from([body]),
		},
	}));
	const client = new S3Client({
		region: 'us-east-1',
		endpoint: 'https://s3.example.internal',
		maxAttempts: 1,
		forcePathStyle: true,
		credentials: {
			accessKeyId: crypto.randomBytes(16).toString('hex'),
			secretAccessKey: crypto.randomBytes(32).toString('hex'),
		},
		requestHandler: { handle },
	});
	clients.push(client);
	const command = new CompleteMultipartUploadCommand({
		Bucket: bucket,
		Key: key,
		UploadId: 'disposable-upload',
		MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"part"' }] },
	});
	return {
		client,
		command,
		handle,
		run: (signal = new AbortController().signal) =>
			checkedCompletion(command, signal, () => client.send(command, { abortSignal: signal })),
	};
}
test('unmodified pinned SDK reproduces the observed 200/missing-identity shape for whitespace after Error', async () => {
	const f = fixture('<Error><Code>InvalidPart</Code><Message>private-body</Message></Error> \r\n');
	const result = await f.client.send(f.command);
	expect(result.$metadata.httpStatusCode).toBe(200);
	expect(result.ETag).toBeUndefined();
	expect(result.Bucket).toBeUndefined();
	expect(result.Key).toBeUndefined();
	expect(publicationValidation(result, bucket, key, true).valid).toBe(false);
});
test.each([
	'',
	' xmlns="http://s3.amazonaws.com/doc/2006-03-01/"',
	' xmlns="http://s3.amazonaws.com/doc/2020-09-01/"',
])('complete success XML retains SDK values and strict identity validation: %s', async attrs => {
	const f = fixture('\r\n' + xml(identity, attrs) + '\n');
	const result = await f.run();
	expect(publicationValidation(result, bucket, key, true).valid).toBe(true);
	expect(result.exportCompletionShape).toMatchObject({
		body: 'complete',
		xml: 'result',
		xmlParser: 'accepted',
		sdkParser: 'resolved',
		entityTagPresent: true,
		bucketPresent: true,
		keyPresent: true,
		identityUnique: true,
	});
	expect(f.handle).toHaveBeenCalledTimes(1);
});
test.each([
	'InvalidPart',
	'InvalidPartOrder',
	'EntityTooSmall',
	'OperationAborted',
	'PreconditionFailed',
	'private-error-code',
])('200 Error is explicit failure, never normalized to a conflict: %s', async code => {
	const f = fixture(
		`<?xml version="1.0"?><s:Error xmlns:s="http://s3.amazonaws.com/doc/2020-09-01/"><s:Code>${code}</s:Code><s:Message>private-body</s:Message></s:Error> \r\n`
	);
	const error = await f.run().catch(error => error);
	expect(error).toMatchObject({
		wireHttpStatus: 200,
		$metadata: { httpStatusCode: 200 },
		responseKind: 'embedded-error',
		providerCode: code === 'private-error-code' ? 'unrecognized' : code,
		completionShape: {
			body: 'complete',
			xml: 'error',
			namespace: 'hcp',
			xmlParser: 'accepted',
			sdkParser: 'not-run',
		},
	});
	const d = publicExportDiagnostic(
		exportDiagnostic(error, {} as ExportJob, 'preflight', 'concurrent-publication')
	);
	expect(JSON.stringify(d)).not.toMatch(/private-|Message|xmlns|disposable|example-exports/);
	expect(f.handle).toHaveBeenCalledTimes(1);
});
test.each([
	['absent', undefined, 'unavailable', 'not-parsed'],
	['empty', '', 'empty', 'not-parsed'],
	['whitespace', ' \r\n', 'complete', 'malformed'],
	['truncated XML', '<CompleteMultipartUploadResult><ETag>', 'complete', 'malformed'],
	['trailing junk', xml() + 'private-tail', 'complete', 'malformed'],
	['wrong root with identity', `<Other>${identity}</Other>`, 'complete', 'other'],
	[
		'Error inside result',
		xml(identity + '<Error><Code>InvalidPart</Code></Error>'),
		'complete',
		'malformed',
	],
	[
		'foreign identity namespace',
		xml('<Bucket xmlns="https://example.invalid/">private</Bucket>'),
		'complete',
		'malformed',
	],
	[
		'DTD',
		'<!DOCTYPE CompleteMultipartUploadResult [<!ENTITY secret "private">]>' + xml(),
		'complete',
		'malformed',
	],
	['nested identity', xml('<Bucket><Nested>private</Nested></Bucket>'), 'complete', 'malformed'],
	['duplicate identity', xml(identity + '<ETag>&quot;another&quot;</ETag>'), 'complete', 'result'],
	[
		'unsupported namespace',
		xml(identity, ' xmlns="https://example.invalid/private"'),
		'complete',
		'result',
	],
	['invalid UTF8', Buffer.from([0xff]), 'complete', 'malformed'],
	['size cap', Buffer.alloc(COMPLETION_BODY_LIMIT + 1, 32), 'too-large', 'not-parsed'],
	['depth cap', '<Other>'.repeat(17) + '</Other>'.repeat(17), 'complete', 'malformed'],
	['element cap', xml('<Other/>'.repeat(257)), 'complete', 'malformed'],
] as const)('fails closed without exposing body for %s', async (_name, body, state, kind) => {
	const f = fixture(body);
	await expect(f.run()).rejects.toMatchObject({
		wireHttpStatus: 200,
		responseKind: 'body-invalid',
		completionShape: { body: state, xml: kind, sdkParser: 'not-run' },
	});
});
test.each(['ETag', 'Bucket', 'Key'])(
	'valid XML missing %s never supplies missing identity from the request',
	async field => {
		const result = await fixture(
			xml(identity.replace(new RegExp(`<${field}>.*?</${field}>`), ''))
		).run();
		expect(publicationValidation(result, bucket, key, true).valid).toBe(false);
		expect(result[field]).toBeUndefined();
		expect(result.exportCompletionShape).toMatchObject({ xml: 'result', sdkParser: 'resolved' });
	}
);
test.each(['ETag', 'Bucket', 'Key'])(
	'archive completion refuses missing %s before ownership recording',
	async field => {
		const f = fixture(xml(identity.replace(new RegExp(`<${field}>.*?</${field}>`), '')));
		const storage = new HcpWriteOnceStorage(
			f.client,
			{ bucket } as ExportConfig,
			() => ({ Bucket: bucket, Key: key }),
			() => ({}),
			() => false,
			async () => {}
		);
		await expect(
			storage.completeUpload(f.command, new AbortController().signal, true)
		).rejects.toMatchObject({
			responseKind: 'invalid-response',
			detail: 'identity-mismatch',
			wireHttpStatus: 200,
			completionShape: { body: 'complete', xml: 'result', sdkParser: 'resolved' },
		});
	}
);
test('HCP wrapper preserves the original sanitized body failure detail', async () => {
	const f = fixture('<CompleteMultipartUploadResult><ETag>');
	const storage = new HcpWriteOnceStorage(
		f.client,
		{ bucket } as ExportConfig,
		() => ({ Bucket: bucket, Key: key }),
		() => ({}),
		() => false,
		async () => {}
	);
	await expect(
		storage.completeUpload(f.command, new AbortController().signal, true)
	).rejects.toMatchObject({
		detail: 'completion-body-invalid',
		responseKind: 'body-invalid',
		wireHttpStatus: 200,
		completionShape: {
			body: 'complete',
			xml: 'malformed',
			xmlParser: 'rejected',
			sdkParser: 'not-run',
		},
	});
});
test.each(['1', '99999', 'private-length'])(
	'HTTP content length mismatch is incomplete, never success: %s',
	async length => {
		await expect(fixture(xml(), { 'content-length': length }).run()).rejects.toMatchObject({
			completionShape: { body: 'incomplete', xml: 'not-parsed', sdkParser: 'not-run' },
		});
	}
);
test('clean chunked EOF validates; parser disagreement cannot fill missing SDK fields', async () => {
	const body = xml();
	const f = fixture(Readable.from([body.slice(0, 10), body.slice(10)]));
	const result = await checkedCompletion(f.command, new AbortController().signal, async () => {
		const output = await f.client.send(f.command);
		return { ...output, ETag: undefined }; // controlled SDK schema difference
	});
	expect(result.exportCompletionShape.entityTagPresent).toBe(true);
	expect(publicationValidation(result, bucket, key, true).valid).toBe(false);
});
test('SDK deserialization failure remains distinct from accepted XML grammar', async () => {
	// Nested XML where the SDK expects a scalar checksum fails its deserializer.
	const f = fixture(xml(identity + '<ChecksumCRC32><Nested>private</Nested></ChecksumCRC32>'));
	await expect(f.run()).rejects.toMatchObject({
		responseKind: 'sdk-parsing-error',
		completionShape: {
			body: 'complete',
			xml: 'result',
			xmlParser: 'accepted',
			sdkParser: 'rejected',
		},
	});
});
test('body reset and cancellation stop collection and destroy the stream', async () => {
	const reset = new Readable({
		read() {
			this.destroy(Object.assign(new Error('private-body'), { code: 'ECONNRESET' }));
		},
	});
	await expect(fixture(reset).run()).rejects.toMatchObject({
		providerCategory: 'network',
		completionShape: { body: 'incomplete', sdkParser: 'not-run' },
	});
	expect(reset.destroyed).toBe(true);
	const controller = new AbortController();
	const pending = new Readable({
		read() {
			queueMicrotask(() => controller.abort());
		},
	});
	await expect(fixture(pending).run(controller.signal)).rejects.toMatchObject({
		providerCategory: 'aborted',
		completionShape: { body: 'incomplete', sdkParser: 'not-run' },
	});
	expect(pending.destroyed).toBe(true);
});
test('public diagnostic shape is an exact enum/boolean projection and old evidence is absent', () => {
	expect(publicCompletionShape(undefined)).toBeUndefined();
	const safe = {
		body: 'complete',
		xml: 'result',
		namespace: 'hcp',
		xmlParser: 'accepted',
		sdkParser: 'resolved',
		entityTagPresent: true,
		bucketPresent: true,
		keyPresent: true,
		identityUnique: true,
	} as const;
	expect(publicCompletionShape({ ...safe, raw: 'private-body' } as any)).toEqual(safe);
	for (const field of Object.keys(safe))
		expect(publicCompletionShape({ ...safe, [field]: 'private-body' } as any)).toBeUndefined();
});
test.each([
	['<Error><Code>OperationAborted</Code></Error>', true],
	['<Error><Code>OperationAborted</Code><Code>OperationAborted</Code></Error>', false],
	['<Error><Code>InternalError</Code><Code>OperationAborted</Code></Error>', false],
	['<Error><Code xmlns="https://example.invalid/">OperationAborted</Code></Error>', false],
	['<Error><Code value="private">OperationAborted</Code></Error>', false],
	['<Error><Code> OperationAborted </Code></Error>', false],
	['<Error><Code>OperationAborted</Code><Key>private</Key></Error>', false],
	['<Error><Code>OperationAborted</Code><CompleteMultipartUploadResult/></Error>', false],
	['<Error xmlns="https://example.invalid/"><Code>OperationAborted</Code></Error>', false],
] as const)(
	'only an unequivocal final error carries semantic rejection evidence: %#',
	async (body, verified) => {
		await expect(fixture(body).run()).rejects.toMatchObject({
			responseKind: 'embedded-error',
			completionShape: {
				operationAbortedVerified: verified,
				requestAttempts: 1,
				replayBlocked: false,
			},
		});
	}
);
test('SDK retry middleware cannot dispatch a duplicate completion even if a retry strategy regresses', async () => {
	const f = fixture('<Error><Code>ServiceUnavailable</Code></Error>', {}, 503);
	// Controlled zero-delay strategy exercised through the real SDK retry plugin.
	// Production retains maxAttempts:1. The second next() must stop before HTTP.
	f.client.config.retryStrategy = async () => ({
		mode: 'standard',
		retry: async (next: any, args: any) => {
			try {
				return await next(args);
			} catch {
				return next(args);
			}
		},
	});
	await expect(f.run()).rejects.toMatchObject({
		detail: 'completion-replay-blocked',
		completionShape: { requestAttempts: 1, replayBlocked: true },
	});
	expect(f.handle).toHaveBeenCalledTimes(1);
});
test('the pinned SDK standard V2 retry strategy is stopped before a second wire attempt', async () => {
	const sdkRequire = createRequire(require.resolve('@aws-sdk/client-s3'));
	const { ConfiguredRetryStrategy } = sdkRequire('@smithy/core/retry');
	const f = fixture('<Error><Code>ServiceUnavailable</Code></Error>', {}, 503);
	f.client.config.maxAttempts = async () => 3;
	f.client.config.retryStrategy = async () => new ConfiguredRetryStrategy(3, () => 0);
	await expect(f.run()).rejects.toMatchObject({
		detail: 'completion-replay-blocked',
		completionShape: { requestAttempts: 1, replayBlocked: true },
	});
	expect(f.handle).toHaveBeenCalledTimes(1);
});

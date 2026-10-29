/** Protocol reference fixture, NOT an HCP implementation or production claim.
 * Negative tests deliberately violate each property required from the real API. */
import crypto from 'crypto';
import { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { CompleteMultipartUploadCommand } from '@aws-sdk/client-s3';
import { S3ExportStorage } from '../../src/utils/managedExport/S3ExportStorage';
import {
	exportConfiguration,
	exportCapabilityBinding,
	bindingDigest,
	type ExportJob,
} from '../../src/utils/managedExport/ExportPolicy';

jest.mock('../../src/utils/logger', () => ({ planLogger: () => ({ info: jest.fn() }) }));
const digest = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const fail = (status: number) =>
	Object.assign(new Error('synthetic provider contents must stay private'), {
		$metadata: { httpStatusCode: status },
	});
function fixture() {
	const config = exportConfiguration({
		MANAGED_EXPORT_ENABLED: 'true',
		MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE: 'true',
		MANAGED_EXPORT_ENDPOINT: 'https://s3.example.internal',
		MANAGED_EXPORT_BUCKET: 'example-backup',
		MANAGED_EXPORT_ACCESS_KEY_ID: crypto.randomBytes(16).toString('hex'),
		MANAGED_EXPORT_SECRET_ACCESS_KEY: crypto.randomBytes(32).toString('hex'),
	})!;
	const id = crypto.randomUUID();
	const job: ExportJob = {
		id,
		kind: 'preflight',
		owner: 'owner',
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
		uploadedBytes: 0,
		processedBytes: 0,
		reservedBytes: 0,
		cleaned: false,
		cleanupAttempts: 0,
	};
	const storage = new S3ExportStorage(config);
	const objects = new Map<string, any>(),
		uploads = new Map<string, any>(),
		calls: any[] = [];
	let fault = '',
		clock = 0;
	const update = (fields: Partial<ExportJob>) => Object.assign(job, structuredClone(fields));
	const store = (input: any, body: Buffer) => {
		if (
			objects.has(input.Key) &&
			fault !== 'overwrite' &&
			!(fault === 'concurrent-multipart-overwrite' && input.Key.endsWith('.probe-race'))
		)
			throw fail(409);
		const etag = '"' + digest(body) + '"';
		objects.set(input.Key, {
			body: Buffer.from(body),
			ETag: etag,
			ContentLength: body.length,
			LastModified: new Date(1000 * ++clock),
			Metadata: { ...input.Metadata },
			ServerSideEncryption: 'AES256',
		});
		return { ETag: etag, $metadata: { httpStatusCode: 200 } };
	};
	const privacy = jest.spyOn(storage as any, 'assertPrivate').mockResolvedValue(undefined);
	const send = jest.spyOn(storage.client, 'send') as jest.Mock;
	send.mockImplementation(async (command: any) => {
		const p = command.input,
			name = command.constructor.name;
		calls.push({ name, ...p });
		await new Promise<void>(resolve => setImmediate(resolve)); // real async ordering
		if (name === 'GetBucketVersioningCommand')
			return fault === 'versioning-changed' ? { Status: 'Enabled' } : {};
		if (name === 'HeadObjectCommand' || name === 'GetObjectCommand') {
			const object = objects.get(p.Key);
			if (!object) throw fail(404);
			if (p.IfMatch && p.IfMatch !== object.ETag && fault !== 'ignored-if-match') throw fail(412);
			if (name === 'HeadObjectCommand')
				return { ...object, body: undefined, $metadata: { httpStatusCode: 200 } };
			const match = p.Range && /^bytes=(\d+)-(\d+)$/.exec(p.Range);
			const start = match ? Number(match[1]) : 0,
				end = match ? Number(match[2]) : object.body.length - 1;
			return {
				...object,
				body: undefined,
				Body: Readable.from([
					fault === 'wrong-content'
						? Buffer.alloc(end - start + 1)
						: object.body.subarray(start, end + 1),
				]),
				ContentLength: end - start + 1,
				ContentRange: match ? `bytes ${start}-${end}/${object.body.length}` : undefined,
				$metadata: { httpStatusCode: match && fault !== 'range-200' ? 206 : 200 },
			};
		}
		if (name === 'PutObjectCommand') return store(p, p.Body);
		if (name === 'GetObjectAclCommand')
			return {
				Owner: { ID: 'fixture-owner' },
				Grants: [
					{ Grantee: { Type: 'CanonicalUser', ID: 'fixture-owner' }, Permission: 'FULL_CONTROL' },
				],
			};
		if (name === 'CreateMultipartUploadCommand') {
			const id = crypto.randomUUID();
			uploads.set(id, { ...p, parts: new Map() });
			return { UploadId: id };
		}
		if (name === 'UploadPartCommand') {
			if (fault === 'part-failure') throw fail(503);
			const upload = uploads.get(p.UploadId);
			if (!upload) throw fail(404);
			upload.parts.set(p.PartNumber, Buffer.from(p.Body));
			return { ETag: '"part-' + p.PartNumber + '"' };
		}
		if (name === 'CompleteMultipartUploadCommand') {
			expect(p.IfNoneMatch).toBeUndefined();
			if (fault === 'embedded-error') return { $metadata: { httpStatusCode: 200 } };
			const upload = uploads.get(p.UploadId);
			if (!upload) throw fail(404);
			const result = store(
				upload,
				Buffer.concat(p.MultipartUpload.Parts.map((part: any) => upload.parts.get(part.PartNumber)))
			);
			uploads.delete(p.UploadId);
			if (fault === 'lost-completion') throw fail(503);
			return result;
		}
		if (name === 'ListObjectsV2Command')
			return {
				Contents: [...objects]
					.filter(([key]) => key.startsWith(p.Prefix))
					.map(([Key]) => ({ Key })),
			};
		if (name === 'ListMultipartUploadsCommand')
			return {
				Uploads: [...uploads]
					.filter(([, u]) => u.Key.startsWith(p.Prefix))
					.map(([UploadId, u]) => ({ Key: u.Key, UploadId })),
			};
		if (name === 'AbortMultipartUploadCommand') {
			if (fault === 'abort-failure') throw fail(503);
			uploads.delete(p.UploadId);
			return {};
		}
		if (name === 'ListPartsCommand') {
			if (!uploads.has(p.UploadId)) throw fail(404);
			return {};
		}
		if (name === 'DeleteObjectCommand') {
			if (fault === 'retention') throw fail(403);
			const o = objects.get(p.Key);
			if (o && p.IfMatch && p.IfMatch !== o.ETag && fault !== 'ignored-delete-condition')
				throw fail(412);
			objects.delete(p.Key);
			return {};
		}
		throw new Error('Unexpected reference fixture request: ' + name);
	});
	return {
		config,
		job,
		storage,
		objects,
		uploads,
		calls,
		update,
		privacy,
		send,
		fault: (value: string) => {
			fault = value;
		},
		store,
	};
}
async function prepare(f: ReturnType<typeof fixture>) {
	await f.storage.preflight(f.job, AbortSignal.timeout(10_000), f.update);
	expect(f.job.providerEvidence).toMatchObject({
		mode: 'hcp-write-once',
		versioning: 'disabled-or-unavailable',
		writeOnce: true,
		collisionStatus: 409,
		concurrentPublication: true,
		transport: 'authenticated-proxy',
	});
	expect(f.job.preflightChecks).not.toContain('versioning');
	expect(f.objects.size).toBe(0);
	expect(f.uploads.size).toBe(0);
}
async function publish(f: ReturnType<typeof fixture>, bytes = 2048) {
	await prepare(f);
	const data = crypto.randomBytes(bytes);
	f.job.summary = {
		version: 1,
		binding: {
			backupId: f.job.binding.backupId,
			repositoryId: f.job.binding.repositoryId,
			snapshotId: f.job.binding.snapshotId,
		},
		mode: 'full',
		includedEntries: 1,
		excludedEntries: 0,
		includedByType: { file: 1 },
		excludedByType: {},
		manifestSha256: 'b'.repeat(64),
		archiveSha256: digest(data),
		archiveBytes: data.length,
	};
	const archive = {
		fileName: 'fixture.tar',
		export: f.job.summary,
		streamTo: async (dest: Writable, signal: AbortSignal) =>
			pipeline(Readable.from([data]), dest, { end: false, signal }),
	};
	await f.storage.upload(f.job, archive as any, AbortSignal.timeout(10_000), f.update);
	await f.storage.verify(f.job, AbortSignal.timeout(10_000));
	return { data, archive };
}
describe('nonversioned write-once capability contract', () => {
	test('a preexisting final key is never adopted or overwritten by a fresh export', async () => {
		const f = fixture();
		try {
			await prepare(f);
			const data = crypto.randomBytes(2048);
			f.store({ Key: f.job.key, Metadata: { 'pluton-export-job': f.job.id } }, data);
			const before = f.objects.get(f.job.key);
			f.job.summary = {
				version: 1,
				binding: {
					backupId: f.job.binding.backupId,
					repositoryId: f.job.binding.repositoryId,
					snapshotId: f.job.binding.snapshotId,
				},
				mode: 'full',
				includedEntries: 1,
				excludedEntries: 0,
				includedByType: { file: 1 },
				excludedByType: {},
				manifestSha256: 'b'.repeat(64),
				archiveSha256: digest(data),
				archiveBytes: data.length,
			};
			f.calls.length = 0;
			const streamTo = jest.fn();
			await expect(
				f.storage.upload(
					f.job,
					{ export: f.job.summary, streamTo } as any,
					AbortSignal.timeout(1000),
					f.update
				)
			).rejects.toThrow('object-mismatch');
			expect(streamTo).not.toHaveBeenCalled();
			expect(
				f.calls.some(
					c =>
						c.Key === f.job.key &&
						/CreateMultipart|PutObject|CompleteMultipart|DeleteObject/.test(c.name)
				)
			).toBe(false);
			expect(f.objects.get(f.job.key)).toBe(before);
			await expect(f.storage.cleanup(f.job, AbortSignal.timeout(1000))).rejects.toThrow();
			expect(f.objects.get(f.job.key)).toBe(before);
		} finally {
			f.storage.close();
		}
	});
	test('changing namespace versioning cannot turn cleanup into a hidden delete marker', async () => {
		const f = fixture();
		try {
			await publish(f);
			f.fault('versioning-changed');
			f.calls.length = 0;
			await expect(f.storage.cleanup(f.job, AbortSignal.timeout(1000))).rejects.toThrow(
				'cleanup-pending'
			);
			expect(f.calls.some(c => c.name === 'DeleteObjectCommand')).toBe(false);
			expect(f.objects.has(f.job.key)).toBe(true);
		} finally {
			f.storage.close();
		}
	});
	test.each(['conditional-etag', 'exclusive-prefix-bounded'])(
		'real async collision probes, independent readback and exact cleanup: %s',
		async kind => {
			const f = fixture();
			if (kind === 'exclusive-prefix-bounded') f.fault('ignored-delete-condition');
			try {
				await prepare(f);
				expect(f.job.providerEvidence?.cleanup).toBe(kind);
				expect(f.job.capabilityBinding).toBe(exportCapabilityBinding(f.config));
				expect(f.privacy).toHaveBeenCalled();
				expect(
					f.calls.filter(c => c.name === 'CompleteMultipartUploadCommand').length
				).toBeGreaterThanOrEqual(5);
				expect(
					f.calls.every(
						c =>
							![
								'PutBucketVersioningCommand',
								'PutBucketPolicyCommand',
								'ListObjectVersionsCommand',
							].includes(c.name)
					)
				).toBe(true);
			} finally {
				f.storage.close();
			}
		}
	);
	test.each([
		'overwrite',
		'concurrent-multipart-overwrite',
		'ignored-if-match',
		'range-200',
		'wrong-content',
		'embedded-error',
		'part-failure',
	])('unsafe contract is NO-GO: %s', async fault => {
		const f = fixture();
		f.fault(fault);
		try {
			await expect(
				f.storage.preflight(f.job, AbortSignal.timeout(10_000), f.update)
			).rejects.toThrow();
			expect(f.job.providerEvidence).toBeUndefined();
		} finally {
			f.storage.close();
		}
	});
	test('complete durable identity, interrupted Range reconstruction and retry never republishes', async () => {
		const f = fixture();
		try {
			const { data, archive } = await publish(f);
			expect(f.job.versionId).toBeUndefined();
			expect(f.job.identity).toMatchObject({
				mode: 'hcp-write-once',
				key: f.job.key,
				bytes: data.length,
				sha256: digest(data),
				binding: bindingDigest(f.job.binding),
			});
			const chunks: Buffer[] = [];
			for (const [start, end] of [
				[0, 1023],
				[1024, 2047],
			]) {
				const result = await f.storage.get(
					f.job,
					AbortSignal.timeout(1000),
					`bytes=${start}-${end}`
				);
				for await (const chunk of result.Body as Readable) chunks.push(chunk);
			}
			expect(digest(Buffer.concat(chunks))).toBe(digest(data));
			const completes = f.calls.filter(c => c.name === 'CompleteMultipartUploadCommand').length;
			await expect(
				f.storage.upload(f.job, archive as any, AbortSignal.timeout(1000), f.update)
			).rejects.toThrow('object-mismatch');
			expect(f.calls.filter(c => c.name === 'CompleteMultipartUploadCommand')).toHaveLength(
				completes
			);
			await expect(f.storage.authorize(f.job, 60)).rejects.toThrow('security-capability-missing');
			await f.storage.cleanup(f.job, AbortSignal.timeout(1000));
			expect(f.objects.size).toBe(0);
			expect(f.uploads.size).toBe(0);
		} finally {
			f.storage.close();
		}
	});
	test.each([
		'etag',
		'foreign-metadata',
		'deleted-recreated',
		'range-200',
		'wrong-content',
		'retention',
	])('changed or protected objects cannot be served/adopted/deleted: %s', async fault => {
		const f = fixture();
		try {
			await publish(f);
			const stored = f.objects.get(f.job.key);
			if (fault === 'etag') stored.ETag = '"replacement"';
			else if (fault === 'foreign-metadata') stored.Metadata['pluton-export-nonce'] = 'foreign';
			else if (fault === 'deleted-recreated') stored.LastModified = new Date(1234567);
			else f.fault(fault);
			const operation =
				fault === 'range-200'
					? f.storage.get(f.job, AbortSignal.timeout(1000), 'bytes=2-7')
					: fault === 'retention'
						? f.storage.cleanup(f.job, AbortSignal.timeout(1000))
						: f.storage.verify(f.job, AbortSignal.timeout(1000));
			await expect(operation).rejects.toThrow();
			if (fault !== 'range-200')
				await expect(f.storage.cleanup(f.job, AbortSignal.timeout(1000))).rejects.toThrow();
			expect(f.objects.has(f.job.key)).toBe(true);
		} finally {
			f.storage.close();
		}
	});
	test('read-only inventory rejects a foreign object/upload without reading its contents or deleting it', async () => {
		const f = fixture();
		try {
			await prepare(f);
			f.calls.length = 0;
			const foreign = f.config.prefix + '/foreign-object';
			f.store({ Key: foreign, Metadata: {} }, Buffer.alloc(16));
			await expect(f.storage.inventory([f.job], AbortSignal.timeout(1000))).rejects.toThrow();
			expect(
				f.calls.every(c => ['GetBucketVersioningCommand', 'ListObjectsV2Command'].includes(c.name))
			).toBe(true);
			expect(f.objects.has(foreign)).toBe(true);
			f.objects.clear();
			f.uploads.set('unknown', { Key: f.job.key });
			f.calls.length = 0;
			await expect(f.storage.inventory([f.job], AbortSignal.timeout(1000))).rejects.toThrow();
			await expect(f.storage.cleanup(f.job, AbortSignal.timeout(1000))).rejects.toThrow();
			expect(f.uploads.has('unknown')).toBe(true);
			expect(f.calls.some(c => /Delete|Abort/.test(c.name))).toBe(false);
		} finally {
			f.storage.close();
		}
	});
	test('a lost completion response is never adopted, retried or deleted after restart', async () => {
		const f = fixture();
		try {
			await prepare(f);
			f.fault('lost-completion');
			// The first probe's successful server commit is deliberately uncertain.
			await expect(
				f.storage.preflight(f.job, AbortSignal.timeout(10_000), f.update)
			).rejects.toThrow();
			expect(f.job.identity).toBeUndefined();
			const restarted = structuredClone(f.job);
			f.fault('');
			await expect(f.storage.cleanup(restarted, AbortSignal.timeout(1000))).rejects.toThrow();
			expect(f.objects.has(f.job.key)).toBe(true);
		} finally {
			f.storage.close();
		}
	});
	test('SDK recognizes an actual HTTP 200 XML Error response; no resolved success is inferred', async () => {
		const f = fixture();
		f.send.mockRestore();
		const handler = jest.spyOn(f.storage.client.config.requestHandler, 'handle') as jest.Mock;
		handler.mockResolvedValue({
			response: {
				statusCode: 200,
				headers: { 'content-type': 'application/xml' },
				body: Readable.from([
					'<Error><Code>InvalidPart</Code><Message>synthetic-private-body</Message></Error>',
				]),
			},
		});
		try {
			await expect(
				f.storage.client.send(
					new CompleteMultipartUploadCommand({
						Bucket: f.config.bucket,
						Key: f.job.key,
						UploadId: 'fixture',
						MultipartUpload: { Parts: [{ PartNumber: 1, ETag: '"part"' }] },
					})
				)
			).rejects.toMatchObject({ name: 'InvalidPart' });
			expect(f.job.identity).toBeUndefined();
		} finally {
			handler.mockRestore();
			f.storage.close();
		}
	});
});

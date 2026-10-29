import crypto from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { S3ExportStorage } from '../../src/utils/managedExport/S3ExportStorage';
import {
	EXPORT_LIMITS,
	bindingDigest,
	exportConfiguration,
	type ExportJob,
} from '../../src/utils/managedExport/ExportPolicy';

function fixture(size = 2048) {
	const config = exportConfiguration({
		MANAGED_EXPORT_ENABLED: 'true',
		MANAGED_EXPORT_ENDPOINT: 'https://s3.example.internal',
		MANAGED_EXPORT_BUCKET: 'example-private-exports',
		MANAGED_EXPORT_ACCESS_KEY_ID: crypto.randomBytes(12).toString('hex'),
		MANAGED_EXPORT_SECRET_ACCESS_KEY: crypto.randomBytes(32).toString('hex'),
	})!;
	const id = crypto.randomUUID();
	const job: ExportJob = {
		id,
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
		state: 'exporting',
		createdAt: 1,
		updatedAt: 1,
		uploadedBytes: 0,
		processedBytes: 0,
		reservedBytes: size,
		cleaned: false,
		cleanupAttempts: 0,
	};
	const block = Buffer.alloc(Math.min(size, 1024 * 1024), 42),
		digest = crypto.createHash('sha256');
	for (let n = 0; n < size; n += block.length)
		digest.update(block.subarray(0, Math.min(block.length, size - n)));
	job.summary = {
		version: 1,
		binding: {
			backupId: job.binding.backupId,
			repositoryId: job.binding.repositoryId,
			snapshotId: job.binding.snapshotId,
		},
		mode: 'full',
		includedEntries: 1,
		excludedEntries: 0,
		includedByType: { file: 1 },
		excludedByType: {},
		archiveBytes: size,
		archiveSha256: digest.digest('hex'),
		manifestSha256: 'b'.repeat(64),
	};
	const storage = new S3ExportStorage(config);
	const chunks = async function* () {
		for (let n = 0; n < size; n += block.length)
			yield block.subarray(0, Math.min(block.length, size - n));
	};
	const archive = {
		fileName: 'backup.tar',
		export: job.summary,
		streamTo: async (destination: any, signal: AbortSignal, ready: () => void) => {
			ready();
			await pipeline(Readable.from(chunks()), destination, { end: false, signal });
		},
	};
	return { config, job, storage, archive, block };
}
const notFound = () =>
	Object.assign(new Error('synthetic missing'), { $metadata: { httpStatusCode: 404 } });
describe('bounded multipart publication', () => {
	test('one connection-reset retry is allowed for reads; writes are never replayed', async () => {
		const f = fixture(),
			handler = jest.spyOn(f.storage.client.config.requestHandler, 'handle') as jest.Mock;
		handler
			.mockRejectedValueOnce(
				Object.assign(new Error('synthetic socket reset'), { code: 'ECONNRESET' })
			)
			.mockResolvedValue({
				response: {
					statusCode: 200,
					headers: { 'content-length': '2048', 'etag': '"tag"', 'x-amz-version-id': 'version' },
					body: Readable.from([]),
				},
			});
		try {
			const result = await f.storage.client.send(
				new HeadObjectCommand({ Bucket: f.config.bucket, Key: f.job.key })
			);
			expect(result.ContentLength).toBe(2048);
			expect(handler).toHaveBeenCalledTimes(2);
			expect(f.storage.diagnostics().readConnectionRetries).toBe(1);
			handler
				.mockReset()
				.mockRejectedValue(
					Object.assign(new Error('synthetic socket reset'), { code: 'ECONNRESET' })
				);
			await expect(
				f.storage.client.send(
					new PutObjectCommand({
						Bucket: f.config.bucket,
						Key: f.job.key,
						Body: Buffer.from('synthetic'),
					})
				)
			).rejects.toThrow();
			expect(handler).toHaveBeenCalledTimes(1);
		} finally {
			f.storage.close();
		}
	});
	test('one fixed part buffer, sequential requests, MD5, exact byte count and conditional publication', async () => {
		const f = fixture(40 * 1024 ** 2 + 512);
		const parts: { bytes: number; body: ArrayBufferLike }[] = [];
		let active = 0,
			maxActive = 0,
			completed = false;
		const send = jest.spyOn(f.storage.client, 'send') as jest.Mock;
		send.mockImplementation(async (command: any) => {
			const { input } = command;
			switch (command.constructor.name) {
				case 'HeadObjectCommand':
					throw notFound();
				case 'CreateMultipartUploadCommand':
					expect(input.ServerSideEncryption).toBe('AES256');
					return { UploadId: 'upload' };
				case 'UploadPartCommand':
					active++;
					maxActive = Math.max(maxActive, active);
					await new Promise(r => setImmediate(r));
					expect(input.ContentMD5).toBe(
						crypto.createHash('md5').update(input.Body).digest('base64')
					);
					parts.push({ bytes: input.Body.length, body: input.Body.buffer });
					active--;
					return { ETag: `"part-${input.PartNumber}"` };
				case 'CompleteMultipartUploadCommand':
					expect(input.IfNoneMatch).toBe('*');
					expect(input.MultipartUpload.Parts).toHaveLength(3);
					completed = true;
					return { VersionId: 'immutable-version', ETag: '"multipart-etag"' };
				default:
					throw new Error('Unexpected command');
			}
		});
		try {
			await f.storage.upload(f.job, f.archive, new AbortController().signal, fields =>
				Object.assign(f.job, fields)
			);
			expect(parts.map(p => p.bytes)).toEqual([
				EXPORT_LIMITS.partBytes,
				EXPORT_LIMITS.partBytes,
				8 * 1024 ** 2 + 512,
			]);
			expect(new Set(parts.map(p => p.body)).size).toBe(1);
			expect(maxActive).toBe(1);
			expect(completed).toBe(true);
			expect(f.job.uploadedBytes).toBe(f.job.summary!.archiveBytes);
			expect(f.job.versionId).toBe('immutable-version');
		} finally {
			f.storage.close();
		}
	});
	for (const failure of ['source-fails', 'wrong-size', 'part-fails', 'missing-version'])
		test(`never publishes readiness after ${failure}`, async () => {
			const f = fixture();
			let completes = 0;
			const send = jest.spyOn(f.storage.client, 'send') as jest.Mock;
			send.mockImplementation(async (command: any) => {
				switch (command.constructor.name) {
					case 'HeadObjectCommand':
						throw notFound();
					case 'CreateMultipartUploadCommand':
						return { UploadId: 'upload' };
					case 'UploadPartCommand':
						if (failure === 'part-fails') throw new Error('synthetic provider failure');
						return { ETag: '"part"' };
					case 'CompleteMultipartUploadCommand':
						completes++;
						return { ETag: '"tag"' };
					default:
						throw new Error('Unexpected command');
				}
			});
			if (failure === 'source-fails')
				f.archive.streamTo = async () => {
					throw new Error('source exit nonzero');
				};
			if (failure === 'wrong-size') f.archive.export.archiveBytes += 512;
			try {
				await expect(
					f.storage.upload(f.job, f.archive, new AbortController().signal, fields =>
						Object.assign(f.job, fields)
					)
				).rejects.toThrow();
				expect(completes).toBe(failure === 'missing-version' ? 1 : 0);
				expect(f.job.versionId).toBeUndefined();
				expect(f.job.uploadId).toBe('upload');
			} finally {
				f.storage.close();
			}
		});
	test('preexisting object and arbitrary durable key refuse all writes', async () => {
		const f = fixture();
		const send = jest.spyOn(f.storage.client, 'send') as jest.Mock;
		send.mockResolvedValue({});
		try {
			await expect(
				f.storage.upload(f.job, f.archive, new AbortController().signal, () => {})
			).rejects.toThrow('object-mismatch');
			expect(send).toHaveBeenCalledTimes(1);
			f.job.key = 'foreign/key';
			await expect(
				f.storage.upload(f.job, f.archive, new AbortController().signal, () => {})
			).rejects.toThrow('binding-changed');
			expect(send).toHaveBeenCalledTimes(1);
		} finally {
			f.storage.close();
		}
	});
});
describe('immutable object integrity and exact orphan cleanup', () => {
	for (const failure of ['wrong-length', 'oversized-body', 'truncated-body'])
		test(`capability probe refuses ${failure} with a fixed six-byte buffer`, async () => {
			const f = fixture();
			let puts = 0;
			const send = jest.spyOn(f.storage.client, 'send') as jest.Mock;
			jest.spyOn(f.storage as any, 'assertPrivate').mockResolvedValue(undefined);
			const cleanup = jest.spyOn(f.storage, 'cleanup').mockResolvedValue(undefined);
			send.mockImplementation(async (command: any) => {
				switch (command.constructor.name) {
					case 'GetBucketVersioningCommand':
						return { Status: 'Enabled' };
					case 'PutObjectCommand':
						return { VersionId: `version-${++puts}` };
					case 'HeadObjectCommand':
						return {
							VersionId: 'version-1',
							ServerSideEncryption: 'AES256',
							ContentLength: 32,
							Metadata: {
								'pluton-export-job': f.job.id,
								'pluton-export-binding': bindingDigest(f.job.binding),
							},
						};
					case 'GetObjectAclCommand':
						return { Grants: [{ Grantee: { Type: 'CanonicalUser' } }] };
					case 'GetObjectCommand':
						return {
							$metadata: { httpStatusCode: 206 },
							ContentRange: 'bytes 2-7/32',
							ContentLength: failure === 'wrong-length' ? 7 : 6,
							Body: Readable.from([Buffer.alloc(failure === 'oversized-body' ? 7 : 5)]),
						};
					default:
						throw new Error('Unexpected probe operation');
				}
			});
			try {
				await expect(f.storage.preflight(f.job, new AbortController().signal)).rejects.toThrow(
					'security-capability-missing'
				);
				expect(cleanup).toHaveBeenCalledTimes(1);
				expect(
					send.mock.calls.some(([c]: any) => c.constructor.name === 'CreateMultipartUploadCommand')
				).toBe(false);
			} finally {
				f.storage.close();
			}
		});
	for (const failure of ['encryption', 'version', 'etag', 'binding', 'checksum', 'size'])
		test(`independent readback rejects ${failure}`, async () => {
			const f = fixture();
			f.job.versionId = 'version';
			f.job.etag = '"tag"';
			jest.spyOn(f.storage as any, 'assertPrivate').mockResolvedValue(undefined);
			const head: any = {
				VersionId: 'version',
				ETag: '"tag"',
				ContentLength: 2048,
				ServerSideEncryption: 'AES256',
				Metadata: {
					'pluton-export-job': f.job.id,
					'pluton-export-binding': bindingDigest(f.job.binding),
					'archive-sha256': f.job.summary!.archiveSha256,
				},
			};
			if (failure === 'encryption') delete head.ServerSideEncryption;
			if (failure === 'version') head.VersionId = 'other';
			if (failure === 'etag') head.ETag = '"changed"';
			if (failure === 'binding') head.Metadata['pluton-export-binding'] = 'other';
			if (failure === 'size') head.ContentLength++;
			const send = jest.spyOn(f.storage.client, 'send') as jest.Mock;
			send.mockImplementation(async (command: any) =>
				command.constructor.name === 'HeadObjectCommand'
					? head
					: {
							Body: Readable.from([Buffer.alloc(2048, 0)]),
							VersionId: 'version',
							ETag: '"tag"',
							ServerSideEncryption: 'AES256',
						}
			);
			try {
				await expect(f.storage.verify(f.job, new AbortController().signal)).rejects.toThrow(
					'object-mismatch'
				);
			} finally {
				f.storage.close();
			}
		});
	test('restart discovers an upload missed before persistence and deletes hidden owned versions only', async () => {
		const f = fixture();
		const deleted = new Set<string>(),
			aborted: string[] = [];
		const metadata = {
			'pluton-export-job': f.job.id,
			'pluton-export-binding': bindingDigest(f.job.binding),
		};
		const send = jest.spyOn(f.storage.client, 'send') as jest.Mock;
		send.mockImplementation(async (command: any) => {
			const i = command.input;
			switch (command.constructor.name) {
				case 'ListMultipartUploadsCommand':
					return {
						Uploads: [
							{ Key: f.job.key, UploadId: 'unpersisted' },
							{ Key: f.job.key + '.probe', UploadId: 'probe-upload' },
							{ Key: f.job.key + '-foreign', UploadId: 'foreign' },
						].filter(upload => !aborted.includes(upload.UploadId)),
					};
				case 'AbortMultipartUploadCommand':
					aborted.push(i.UploadId);
					return {};
				case 'ListPartsCommand':
					throw notFound();
				case 'ListObjectVersionsCommand':
					return {
						Versions:
							i.Prefix === f.job.key && !deleted.has('archive')
								? [{ Key: f.job.key, VersionId: 'archive' }]
								: [],
						DeleteMarkers:
							i.Prefix === f.job.key && !deleted.has('marker')
								? [{ Key: f.job.key, VersionId: 'marker' }]
								: [],
					};
				case 'HeadObjectCommand':
					if (!i.VersionId || deleted.has(i.VersionId)) throw notFound();
					return { Metadata: metadata };
				case 'DeleteObjectCommand':
					deleted.add(i.VersionId);
					return {};
				default:
					throw new Error('Unexpected command');
			}
		});
		try {
			await f.storage.cleanup(f.job, new AbortController().signal);
			expect(aborted).toEqual(['unpersisted', 'probe-upload']);
			expect([...deleted]).toEqual(['archive', 'marker']);
		} finally {
			f.storage.close();
		}
	});
	test('foreign metadata is never deleted, and retains cleanup failure', async () => {
		const f = fixture();
		const send = jest.spyOn(f.storage.client, 'send') as jest.Mock;
		send.mockImplementation(async (command: any) => {
			switch (command.constructor.name) {
				case 'ListMultipartUploadsCommand':
					return {};
				case 'ListObjectVersionsCommand':
					return command.input.Prefix === f.job.key
						? { Versions: [{ Key: f.job.key, VersionId: 'foreign' }] }
						: {};
				case 'HeadObjectCommand':
					if (command.input.Key.endsWith('.probe')) throw notFound();
					return { Metadata: { 'pluton-export-job': 'someone-else' } };
				case 'DeleteObjectCommand':
					throw new Error('Must never delete foreign object');
				default:
					throw new Error('Unexpected command');
			}
		});
		try {
			await expect(f.storage.cleanup(f.job, new AbortController().signal)).rejects.toThrow(
				'cleanup-pending'
			);
			expect(send.mock.calls.some(([c]: any) => c.constructor.name === 'DeleteObjectCommand')).toBe(
				false
			);
		} finally {
			f.storage.close();
		}
	});
	test('versioning capability is mandatory before source bytes are read', async () => {
		const f = fixture();
		const send = jest.spyOn(f.storage.client, 'send') as jest.Mock;
		send.mockResolvedValue({ Status: 'Suspended' });
		try {
			await expect(f.storage.preflight(f.job, new AbortController().signal)).rejects.toThrow(
				'security-capability-missing'
			);
			expect(send).toHaveBeenCalledTimes(1);
		} finally {
			f.storage.close();
		}
	});
});

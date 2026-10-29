import crypto from 'crypto';
import https from 'https';
import { Writable, Readable } from 'stream';
import { finished } from 'stream/promises';
import {
	S3Client,
	GetBucketVersioningCommand,
	PutObjectCommand,
	HeadObjectCommand,
	GetObjectAclCommand,
	GetObjectCommand,
	DeleteObjectCommand,
	CreateMultipartUploadCommand,
	UploadPartCommand,
	CompleteMultipartUploadCommand,
	AbortMultipartUploadCommand,
	ListMultipartUploadsCommand,
	ListObjectVersionsCommand,
	ListPartsCommand,
	type CompletedPart,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
	EXPORT_LIMITS,
	TemporaryExportError,
	bindingDigest,
	exportFileName,
	type ExportConfig,
	type ExportJob,
} from './ExportPolicy';
import type { ManagedArchiveDownload } from '../../services/RemoteRepositoryRecoveryService';
import { planLogger } from '../logger';

const missing = (e: unknown) =>
	(e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;
export class S3ExportStorage {
	readonly client: S3Client;
	private readonly recent: { operation: string; status: number; kind?: string }[] = [];
	private readonly counters = {
		readConnectionRetries: 0,
		requests: 0,
		failures: 0,
		headerLatencyMs: 0,
		maxHeaderLatencyMs: 0,
		lastFailureOperation: 'none',
		lastFailureStatus: 0,
		firstUnexpectedOperation: 'none',
		firstUnexpectedStatus: 0,
	};
	diagnostics() {
		return { ...this.counters, recent: this.recent };
	}
	constructor(readonly config: ExportConfig) {
		this.client = new S3Client({
			endpoint: config.endpoint,
			region: config.region,
			forcePathStyle: true,
			credentials: {
				accessKeyId: config.accessKeyId,
				secretAccessKey: config.secretAccessKey,
				sessionToken: config.sessionToken,
			},
			maxAttempts: 1,
			requestChecksumCalculation: 'WHEN_REQUIRED',
			responseChecksumValidation: 'WHEN_REQUIRED',
			requestHandler: new NodeHttpHandler({
				connectionTimeout: 5000,
				// Inactivity bound: a healthy multi-hour GET must keep streaming.
				socketTimeout: 10 * 60_000,
				httpsAgent: new https.Agent({
					ca: config.ca,
					rejectUnauthorized: true,
					keepAlive: true,
					maxSockets: 4,
				}),
			}),
		});
		this.client.middlewareStack.add(
			(next, context) => async args => {
				for (let attempt = 0; ; attempt++) {
					const started = Date.now();
					this.counters.requests++;
					try {
						const result = await next(args);
						this.recent.push({
							operation: context.commandName || 'unknown',
							status: (result.response as { statusCode?: number })?.statusCode || 0,
						});
						if (this.recent.length > 20) this.recent.shift();
						return result;
					} catch (error) {
						this.counters.failures++;
						this.counters.lastFailureOperation = context.commandName || 'unknown';
						const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
							?.httpStatusCode;
						this.counters.lastFailureStatus = Number.isSafeInteger(status) ? status! : 0;
						const e = error as { code?: string; name?: string };
						const kind =
							[
								'ECONNRESET',
								'EPIPE',
								'ETIMEDOUT',
								'ENOTFOUND',
								'AbortError',
								'TimeoutError',
								'TypeError',
							].find(value => value === e.code || value === e.name) || 'service-error';
						this.recent.push({
							operation: context.commandName || 'unknown',
							status: this.counters.lastFailureStatus,
							kind,
						});
						if (this.recent.length > 20) this.recent.shift();
						if (
							![404, 412].includes(status || 0) &&
							this.counters.firstUnexpectedOperation === 'none'
						) {
							this.counters.firstUnexpectedOperation = context.commandName || 'unknown';
							this.counters.firstUnexpectedStatus = this.counters.lastFailureStatus;
						}
						// Some S3-compatible servers close a keep-alive connection after
						// conditional 412. Reusing that socket can race its FIN. Retry ONE
						// metadata/read request on reset, never upload/publication or bodies.
						if (
							attempt === 0 &&
							e.code === 'ECONNRESET' &&
							[
								'GetBucketVersioningCommand',
								'GetObjectAclCommand',
								'HeadObjectCommand',
								'GetObjectCommand',
								'ListMultipartUploadsCommand',
								'ListObjectVersionsCommand',
								'ListPartsCommand',
							].includes(context.commandName || '')
						) {
							this.counters.readConnectionRetries++;
							continue;
						}
						throw error;
					} finally {
						const elapsed = Date.now() - started;
						this.counters.headerLatencyMs += elapsed;
						this.counters.maxHeaderLatencyMs = Math.max(this.counters.maxHeaderLatencyMs, elapsed);
					}
				}
			},
			{ step: 'initialize', name: 'boundedExportDiagnostics' }
		);
	}
	private scope(job: ExportJob, key = job.key) {
		if (
			job.destination !== this.config.fingerprint ||
			job.key !== `${this.config.prefix}/${job.id}.tar` ||
			!/^[a-f0-9-]{36}$/.test(job.id) ||
			![job.key, job.key + '.probe'].includes(key)
		)
			throw new TemporaryExportError('binding-changed');
		return { Bucket: this.config.bucket, Key: key };
	}
	private metadata(job: ExportJob) {
		return {
			'pluton-export-job': job.id,
			'pluton-export-binding': bindingDigest(job.binding),
			...(job.summary ? { 'archive-sha256': job.summary.archiveSha256 } : {}),
		};
	}
	private owns(job: ExportJob, head: { Metadata?: Record<string, string> }) {
		return (
			head.Metadata?.['pluton-export-job'] === job.id &&
			head.Metadata?.['pluton-export-binding'] === bindingDigest(job.binding)
		);
	}
	async absent(job: ExportJob, signal: AbortSignal) {
		try {
			await this.client.send(new HeadObjectCommand(this.scope(job)), { abortSignal: signal });
			throw new TemporaryExportError('object-mismatch');
		} catch (error) {
			if (!missing(error)) throw error;
		}
	}
	async preflight(
		job: ExportJob,
		signal: AbortSignal,
		update: (fields: Partial<ExportJob>) => void = () => {}
	) {
		if (
			(
				await this.client.send(new GetBucketVersioningCommand({ Bucket: this.config.bucket }), {
					abortSignal: signal,
				})
			).Status !== 'Enabled'
		)
			throw new TemporaryExportError('security-capability-missing');
		const key = job.key + '.probe',
			data = crypto.randomBytes(32),
			params = this.scope(job, key);
		try {
			await this.client.send(
				new PutObjectCommand({
					...params,
					Body: data,
					IfNoneMatch: '*',
					ServerSideEncryption: 'AES256',
					Metadata: this.metadata(job),
				}),
				{ abortSignal: signal }
			);
			const head = await this.client.send(new HeadObjectCommand(params), { abortSignal: signal });
			if (
				!head.VersionId ||
				head.VersionId === 'null' ||
				head.ServerSideEncryption !== 'AES256' ||
				head.ContentLength !== data.length ||
				!this.owns(job, head)
			)
				throw new TemporaryExportError('security-capability-missing');
			const acl = await this.client.send(
				new GetObjectAclCommand({ ...params, VersionId: head.VersionId }),
				{ abortSignal: signal }
			);
			if (
				!acl.Grants?.length ||
				acl.Grants.some(g => g.Grantee?.URI || g.Grantee?.Type !== 'CanonicalUser')
			)
				throw new TemporaryExportError('security-capability-missing');
			await this.assertPrivate(key, head.VersionId, signal);
			// Prove old-version reads remain byte-stable after a newer generation.
			const newer = await this.client.send(
				new PutObjectCommand({
					...params,
					Body: crypto.randomBytes(32),
					ServerSideEncryption: 'AES256',
					Metadata: this.metadata(job),
				}),
				{ abortSignal: signal }
			);
			if (!newer.VersionId || newer.VersionId === head.VersionId)
				throw new TemporaryExportError('security-capability-missing');
			const get = await this.client.send(
				new GetObjectCommand({
					...params,
					VersionId: head.VersionId,
					Range: 'bytes=2-7',
					IfMatch: head.ETag,
				}),
				{ abortSignal: signal }
			);
			if (
				get.$metadata.httpStatusCode !== 206 ||
				get.ContentRange !== 'bytes 2-7/32' ||
				get.ContentLength !== 6 ||
				!get.Body
			) {
				(get.Body as Readable)?.destroy();
				throw new TemporaryExportError('security-capability-missing');
			}
			const bytes = Buffer.alloc(6);
			let received = 0;
			try {
				for await (const chunk of get.Body as Readable) {
					if (received + chunk.length > bytes.length)
						throw new TemporaryExportError('security-capability-missing');
					chunk.copy(bytes, received);
					received += chunk.length;
				}
			} finally {
				(get.Body as Readable).destroy();
			}
			if (received !== bytes.length) throw new TemporaryExportError('security-capability-missing');
			if (!bytes.equals(data.subarray(2, 8)))
				throw new TemporaryExportError('security-capability-missing');
			const versions = await this.client.send(
				new ListObjectVersionsCommand({ Bucket: params.Bucket, Prefix: key, MaxKeys: 10 }),
				{ abortSignal: signal }
			);
			if (
				![head.VersionId, newer.VersionId].every(id =>
					versions.Versions?.some(v => v.Key === key && v.VersionId === id)
				)
			)
				throw new TemporaryExportError('security-capability-missing');
			// Probe the SAME conditional multipart publication operation used for TARs.
			const mp = await this.client.send(
				new CreateMultipartUploadCommand({
					...params,
					ServerSideEncryption: 'AES256',
					Metadata: this.metadata(job),
				}),
				{ abortSignal: signal }
			);
			if (!mp.UploadId) throw new TemporaryExportError('security-capability-missing');
			job.probeUploadId = mp.UploadId;
			update({ probeUploadId: mp.UploadId });
			const part = await this.client.send(
				new UploadPartCommand({
					...params,
					UploadId: mp.UploadId,
					PartNumber: 1,
					Body: data,
					ContentLength: data.length,
					ContentMD5: crypto.createHash('md5').update(data).digest('base64'),
				}),
				{ abortSignal: signal }
			);
			const pending = await this.client.send(
				new ListMultipartUploadsCommand({ Bucket: params.Bucket, Prefix: key, MaxUploads: 10 }),
				{ abortSignal: signal }
			);
			if (!pending.Uploads?.some(u => u.Key === key && u.UploadId === mp.UploadId))
				throw new TemporaryExportError('security-capability-missing');
			let refused = false;
			try {
				await this.client.send(
					new CompleteMultipartUploadCommand({
						...params,
						UploadId: mp.UploadId,
						MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part.ETag }] },
						IfNoneMatch: '*',
					}),
					{ abortSignal: signal }
				);
			} catch (error) {
				refused =
					(error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 412;
			}
			if (!refused) throw new TemporaryExportError('security-capability-missing');
		} finally {
			await this.cleanup(job, AbortSignal.timeout(30_000));
			job.probeUploadId = undefined;
			update({ probeUploadId: undefined });
		}
	}
	private assertPrivate(key: string, version: string, signal: AbortSignal) {
		const url = new URL(
			`${this.config.endpoint}/${encodeURIComponent(this.config.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`
		);
		url.searchParams.set('versionId', version);
		return new Promise<void>((resolve, reject) => {
			const request = https.request(
				url,
				{
					method: 'GET',
					headers: { range: 'bytes=0-0' },
					ca: this.config.ca,
					rejectUnauthorized: true,
					signal,
				},
				response => {
					response.destroy(); // privacy requires headers only; never consume provider contents
					if ([403, 404].includes(response.statusCode || 0)) resolve();
					else reject(new TemporaryExportError('security-capability-missing'));
				}
			);
			request.once('error', () => reject(new TemporaryExportError('storage-unavailable')));
			request.end();
		});
	}
	async upload(
		job: ExportJob,
		archive: ManagedArchiveDownload,
		signal: AbortSignal,
		update: (fields: Partial<ExportJob>) => void
	) {
		await this.absent(job, signal);
		const created = await this.client.send(
			new CreateMultipartUploadCommand({
				...this.scope(job),
				ServerSideEncryption: 'AES256',
				ContentType: 'application/x-tar',
				Metadata: this.metadata(job),
			}),
			{ abortSignal: signal }
		);
		if (!created.UploadId) throw new TemporaryExportError('storage-unavailable');
		job.uploadId = created.UploadId;
		update({ uploadId: created.UploadId, state: 'uploading', uploadStartedAt: Date.now() });
		const parts: CompletedPart[] = [];
		const buffer = Buffer.allocUnsafe(EXPORT_LIMITS.partBytes);
		let used = 0,
			processed = 0,
			uploaded = 0,
			lastUpdate = 0;
		const part = async () => {
			if (!used) return;
			signal.throwIfAborted();
			const body = buffer.subarray(0, used);
			const result = await this.client.send(
				new UploadPartCommand({
					...this.scope(job),
					UploadId: job.uploadId,
					PartNumber: parts.length + 1,
					ContentLength: used,
					ContentMD5: crypto.createHash('md5').update(body).digest('base64'),
					Body: body,
				}),
				{ abortSignal: signal }
			);
			if (!result.ETag) throw new TemporaryExportError('storage-unavailable');
			parts.push({ PartNumber: parts.length + 1, ETag: result.ETag });
			uploaded += used;
			used = 0;
			update({ uploadedBytes: uploaded, processedBytes: processed });
		};
		const output = new Writable({
			highWaterMark: 64 * 1024,
			write(chunk: Buffer, _encoding, done) {
				void (async () => {
					let offset = 0;
					processed += chunk.length;
					if (processed > archive.export.archiveBytes || processed > EXPORT_LIMITS.maxObjectBytes)
						throw new TemporaryExportError('quota-exceeded');
					while (offset < chunk.length) {
						const n = Math.min(buffer.length - used, chunk.length - offset);
						chunk.copy(buffer, used, offset, offset + n);
						used += n;
						offset += n;
						if (used === buffer.length) await part();
					}
					if (Date.now() - lastUpdate > 1000) {
						update({ processedBytes: processed });
						lastUpdate = Date.now();
					}
				})().then(() => done(), done);
			},
			final(done) {
				part().then(() => done(), done);
			},
		});
		output.on('error', () => undefined);
		try {
			await archive.streamTo(output, signal, () => {});
			output.end();
			await finished(output);
			if (processed !== archive.export.archiveBytes || uploaded !== processed || !parts.length)
				throw new TemporaryExportError('object-mismatch');
			// Completion is the ONLY publication point; SDK detects embedded 200 errors.
			const result = await this.client.send(
				new CompleteMultipartUploadCommand({
					...this.scope(job),
					UploadId: job.uploadId,
					MultipartUpload: { Parts: parts },
					IfNoneMatch: '*',
				}),
				{ abortSignal: signal }
			);
			if (!result.VersionId || result.VersionId === 'null' || !result.ETag)
				throw new TemporaryExportError('security-capability-missing');
			job.versionId = result.VersionId;
			job.etag = result.ETag;
			update({
				versionId: result.VersionId,
				etag: result.ETag,
				uploadId: undefined,
				state: 'verifying',
				uploadFinishedAt: Date.now(),
			});
		} catch (error) {
			output.destroy();
			throw error;
		}
	}
	async verify(job: ExportJob, signal: AbortSignal) {
		await this.identity(job, signal);
		const object = await this.get(job, signal);
		const hash = crypto.createHash('sha256');
		let bytes = 0;
		try {
			for await (const chunk of object.Body as Readable) {
				bytes += chunk.length;
				if (bytes > job.summary!.archiveBytes) throw new TemporaryExportError('object-mismatch');
				hash.update(chunk);
			}
		} finally {
			(object.Body as Readable)?.destroy();
		}
		if (bytes !== job.summary!.archiveBytes || hash.digest('hex') !== job.summary!.archiveSha256)
			throw new TemporaryExportError('object-mismatch');
		await this.assertPrivate(job.key, job.versionId!, signal);
	}
	async identity(job: ExportJob, signal: AbortSignal) {
		const head = await this.head(job, signal);
		if (
			!job.versionId ||
			!job.etag ||
			head.VersionId !== job.versionId ||
			head.ETag !== job.etag ||
			head.ContentLength !== job.summary!.archiveBytes ||
			head.ServerSideEncryption !== 'AES256' ||
			!this.owns(job, head) ||
			head.Metadata?.['archive-sha256'] !== job.summary!.archiveSha256
		)
			throw new TemporaryExportError('object-mismatch');
		await this.assertPrivate(job.key, job.versionId, signal);
		return head;
	}
	head(job: ExportJob, signal: AbortSignal) {
		return this.client.send(
			new HeadObjectCommand({ ...this.scope(job), VersionId: job.versionId, IfMatch: job.etag }),
			{ abortSignal: signal }
		);
	}
	async get(job: ExportJob, signal: AbortSignal, range?: string) {
		const result = await this.client.send(
			new GetObjectCommand({
				...this.scope(job),
				VersionId: job.versionId,
				IfMatch: job.etag,
				Range: range,
			}),
			{ abortSignal: signal }
		);
		if (
			result.VersionId !== job.versionId ||
			result.ETag !== job.etag ||
			result.ServerSideEncryption !== 'AES256'
		) {
			(result.Body as Readable)?.destroy();
			throw new TemporaryExportError('object-mismatch');
		}
		return result;
	}
	async authorize(job: ExportJob, seconds: number) {
		return getSignedUrl(
			this.client,
			new GetObjectCommand({
				...this.scope(job),
				VersionId: job.versionId,
				ResponseContentType: 'application/x-tar',
				ResponseContentDisposition: `attachment; filename="${exportFileName(job)}"`,
				ResponseCacheControl: 'private, no-store',
			}),
			{ expiresIn: Math.max(1, Math.min(EXPORT_LIMITS.authorizationSeconds, seconds)) }
		);
	}
	async cleanup(job: ExportJob, signal: AbortSignal) {
		const params = this.scope(job);
		const aborted = new Set<string>();
		const abort = async (key: string, id: string) => {
			if (aborted.has(id)) return;
			try {
				await this.client.send(
					new AbortMultipartUploadCommand({ ...this.scope(job, key), UploadId: id }),
					{ abortSignal: signal }
				);
			} catch (error) {
				if (!missing(error)) throw error;
			}
			aborted.add(id);
			try {
				await this.client.send(
					new ListPartsCommand({ ...this.scope(job, key), UploadId: id, MaxParts: 1 }),
					{ abortSignal: signal }
				);
				throw new TemporaryExportError('cleanup-pending');
			} catch (error) {
				if (!missing(error)) throw error;
			}
		};
		let keyMarker: string | undefined, uploadIdMarker: string | undefined;
		for (let page = 0; page < 4; page++) {
			const uploads = await this.client.send(
				new ListMultipartUploadsCommand({
					Bucket: params.Bucket,
					Prefix: params.Key,
					KeyMarker: keyMarker,
					UploadIdMarker: uploadIdMarker,
					MaxUploads: 100,
				}),
				{ abortSignal: signal }
			);
			for (const upload of uploads.Uploads || [])
				if ([job.key, job.key + '.probe'].includes(upload.Key || '') && upload.UploadId)
					await abort(upload.Key!, upload.UploadId);
			if (!uploads.IsTruncated) break;
			if (page === 3) throw new TemporaryExportError('cleanup-pending');
			keyMarker = uploads.NextKeyMarker;
			uploadIdMarker = uploads.NextUploadIdMarker;
		}
		if (job.uploadId) await abort(job.key, job.uploadId);
		if (job.probeUploadId) await abort(job.key + '.probe', job.probeUploadId);
		const pending = await this.client.send(
			new ListMultipartUploadsCommand({
				Bucket: params.Bucket,
				Prefix: params.Key,
				MaxUploads: 100,
			}),
			{ abortSignal: signal }
		);
		if (
			pending.IsTruncated ||
			pending.Uploads?.some(u => [job.key, job.key + '.probe'].includes(u.Key || ''))
		)
			throw new TemporaryExportError('cleanup-pending');
		// A delete marker can hide a completed archive after a crash. Enumerate
		// versions for our TWO exact generated keys; HEAD(current) is insufficient.
		for (const key of [job.key + '.probe', job.key]) {
			let marker: string | undefined, versionMarker: string | undefined;
			const markers: { Key: string; VersionId: string }[] = [];
			let owned = false,
				foreign = false;
			for (let page = 0; page < 4; page++) {
				const versions = await this.client.send(
					new ListObjectVersionsCommand({
						Bucket: params.Bucket,
						Prefix: key,
						MaxKeys: 100,
						KeyMarker: marker,
						VersionIdMarker: versionMarker,
					}),
					{ abortSignal: signal }
				);
				for (const item of versions.Versions || [])
					if (item.Key === key && item.VersionId) {
						const head = await this.client.send(
							new HeadObjectCommand({ ...this.scope(job, key), VersionId: item.VersionId }),
							{ abortSignal: signal }
						);
						if (!this.owns(job, head)) {
							foreign = true;
							continue;
						}
						owned = true;
						await this.client.send(
							new DeleteObjectCommand({ ...this.scope(job, key), VersionId: item.VersionId }),
							{ abortSignal: signal }
						);
						try {
							await this.client.send(
								new HeadObjectCommand({ ...this.scope(job, key), VersionId: item.VersionId }),
								{ abortSignal: signal }
							);
							throw new TemporaryExportError('cleanup-pending');
						} catch (error) {
							if (!missing(error)) throw error;
						}
					}
				for (const item of versions.DeleteMarkers || [])
					if (item.Key === key && item.VersionId)
						markers.push({ Key: key, VersionId: item.VersionId });
				if (!versions.IsTruncated) break;
				if (page === 3) throw new TemporaryExportError('cleanup-pending');
				marker = versions.NextKeyMarker;
				versionMarker = versions.NextVersionIdMarker;
			}
			if (foreign || (markers.length && !owned && !(key === job.key && job.versionId)))
				throw new TemporaryExportError('cleanup-pending');
			for (const item of markers)
				await this.client.send(new DeleteObjectCommand({ Bucket: params.Bucket, ...item }), {
					abortSignal: signal,
				});
			const remaining = await this.client.send(
				new ListObjectVersionsCommand({ Bucket: params.Bucket, Prefix: key, MaxKeys: 100 }),
				{ abortSignal: signal }
			);
			if (
				remaining.IsTruncated ||
				[...(remaining.Versions || []), ...(remaining.DeleteMarkers || [])].some(
					item => item.Key === key
				)
			)
				throw new TemporaryExportError('cleanup-pending');
			for (const version of [
				undefined,
				...(key === job.key && job.versionId ? [job.versionId] : []),
			]) {
				try {
					await this.client.send(
						new HeadObjectCommand({ ...this.scope(job, key), VersionId: version }),
						{ abortSignal: signal }
					);
					throw new TemporaryExportError('cleanup-pending');
				} catch (error) {
					if (!missing(error)) throw error;
				}
			}
		}
	}
	close() {
		this.client.destroy();
		try {
			planLogger('temporary-export').info(
				{ event: 'temporary_storage', ...this.counters },
				'Temporary export storage requests completed.'
			);
		} catch {
			/* No URLs, headers, provider output or credentials. */
		}
	}
}

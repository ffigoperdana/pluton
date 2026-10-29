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
	type HeadObjectCommandOutput,
	type ListMultipartUploadsCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import {
	EXPORT_LIMITS,
	TemporaryExportError,
	ExportPreflightError,
	type ExportCapability,
	bindingDigest,
	exportFileName,
	type ExportConfig,
	type ExportJob,
	exportCapabilityBinding,
} from './ExportPolicy';
import { HcpWriteOnceStorage, writeOnceKeys } from './HcpWriteOnceStorage';
import type { ManagedArchiveDownload } from '../../services/RemoteRepositoryRecoveryService';
import { planLogger } from '../logger';

const missing = (e: unknown) =>
	(e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;
export class S3ExportStorage {
	readonly client: S3Client;
	private readonly writeOnce: HcpWriteOnceStorage;
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
		this.writeOnce = new HcpWriteOnceStorage(
			this.client,
			config,
			(job, key) => this.scope(job, key),
			job => this.metadata(job),
			(job, head) => this.owns(job, head),
			(key, version, signal) => this.assertPrivate(key, version, signal)
		);
	}
	async mode(signal: AbortSignal) {
		try {
			const response = await this.client.send(
				new GetBucketVersioningCommand({ Bucket: this.config.bucket }),
				{ abortSignal: signal }
			);
			if (response.Status === 'Enabled') return 'versioned' as const;
			// Suspended versioning can hide old versions and is not this contract.
			if (response.Status === 'Suspended' || !this.config.allowSharedNamespace)
				throw new ExportPreflightError('versioning', 'unexpected-response');
		} catch (error) {
			if (!this.config.allowSharedNamespace || (error as any)?.$metadata?.httpStatusCode !== 501)
				throw error;
		}
		return 'hcp-write-once' as const;
	}
	private scope(job: ExportJob, key = job.key) {
		if (
			job.destination !== this.config.fingerprint ||
			job.key !== `${this.config.prefix}/${job.id}.tar` ||
			!/^[a-f0-9-]{36}$/.test(job.id) ||
			!(
				job.integrityMode === 'hcp-write-once' ? writeOnceKeys(job) : [job.key, job.key + '.probe']
			).includes(key)
		)
			throw new TemporaryExportError('binding-changed');
		return { Bucket: this.config.bucket, Key: key };
	}
	private metadata(job: ExportJob) {
		return {
			'pluton-export-job': job.id,
			'pluton-export-binding': bindingDigest(job.binding),
			...(job.ownershipNonce ? { 'pluton-export-nonce': job.ownershipNonce } : {}),
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
		try {
			if ((await this.mode(signal)) === 'hcp-write-once') {
				if (job.kind === 'preflight') return await this.writeOnce.preflight(job, signal, update);
				job.integrityMode = 'hcp-write-once';
				update({ integrityMode: job.integrityMode });
				// Never reuse an archive key after a synthetic object. One bounded
				// child probe is persisted before its first request, including all
				// uncertain ownership/cleanup metadata needed after a restart.
				if (job.capabilityProbe) throw new TemporaryExportError('object-mismatch');
				const id = crypto.randomUUID();
				const probe: ExportJob = {
					...job,
					kind: 'preflight',
					id,
					key: `${this.config.prefix}/${id}.tar`,
					capabilityProbe: undefined,
					summary: undefined,
					identity: undefined,
					publicationAttempted: undefined,
					ownedObjects: undefined,
					ownedUploads: undefined,
					preflightChecks: job.preflightChecks,
				};
				job.capabilityProbe = probe;
				update({ capabilityProbe: probe });
				await this.writeOnce.preflight(probe, signal, fields => {
					Object.assign(probe, fields);
					update({ capabilityProbe: probe });
				});
				probe.cleaned = true;
				job.integrityMode = 'hcp-write-once';
				job.ownershipNonce = crypto.randomBytes(32).toString('hex');
				job.providerEvidence = probe.providerEvidence;
				job.capabilityBinding = probe.capabilityBinding;
				update({
					capabilityProbe: probe,
					integrityMode: job.integrityMode,
					ownershipNonce: job.ownershipNonce,
					providerEvidence: job.providerEvidence,
					capabilityBinding: job.capabilityBinding,
					preflightChecks: probe.preflightChecks,
				});
				return;
			}
			job.integrityMode = 'versioned';
			update({ integrityMode: 'versioned' });
		} catch (error) {
			this.capabilityFailure(error, 'versioning');
		}
		let capability: ExportCapability = 'versioning';
		const passed = (step: ExportCapability) => {
			job.preflightChecks = [...new Set([...(job.preflightChecks || []), step])];
			update({ preflightChecks: job.preflightChecks });
		};
		const remember = (
			key: string,
			result: { VersionId?: string; ETag?: string },
			bytes: number
		) => {
			if (!this.config.allowSharedNamespace) return;
			if (!result.VersionId || result.VersionId === 'null')
				throw new TemporaryExportError('security-capability-missing');
			job.ownedVersions = [
				...(job.ownedVersions || []),
				{ key, versionId: result.VersionId, etag: result.ETag, bytes },
			];
			update({ ownedVersions: job.ownedVersions });
		};
		try {
			if (
				(
					await this.client.send(new GetBucketVersioningCommand({ Bucket: this.config.bucket }), {
						abortSignal: signal,
					})
				).Status !== 'Enabled'
			)
				throw new TemporaryExportError('security-capability-missing');
			passed('https');
			passed('versioning');
			capability = 'sse-s3';
			const key = job.key + '.probe',
				data = crypto.randomBytes(32),
				params = this.scope(job, key);
			let probeFailure: unknown;
			try {
				const initial = await this.client.send(
					new PutObjectCommand({
						...params,
						Body: data,
						IfNoneMatch: '*',
						ServerSideEncryption: 'AES256',
						Metadata: this.metadata(job),
					}),
					{ abortSignal: signal }
				);
				remember(key, initial, data.length);
				const head = await this.client.send(new HeadObjectCommand(params), { abortSignal: signal });
				if (
					!head.VersionId ||
					head.VersionId === 'null' ||
					head.ServerSideEncryption !== 'AES256' ||
					head.ContentLength !== data.length ||
					!this.owns(job, head)
				)
					throw new TemporaryExportError('security-capability-missing');
				passed('sse-s3');
				capability = 'private-acl';
				const acl = await this.client.send(
					new GetObjectAclCommand({ ...params, VersionId: head.VersionId }),
					{ abortSignal: signal }
				);
				if (
					!acl.Grants?.length ||
					acl.Grants.some(g => g.Grantee?.URI || g.Grantee?.Type !== 'CanonicalUser')
				)
					throw new TemporaryExportError('security-capability-missing');
				passed('private-acl');
				capability = 'anonymous-denial';
				await this.assertPrivate(key, head.VersionId, signal);
				passed('anonymous-denial');
				capability = 'immutable-version';
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
				remember(key, newer, data.length);
				if (!newer.VersionId || newer.VersionId === head.VersionId)
					throw new TemporaryExportError('security-capability-missing');
				capability = 'range-resume';
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
				if (received !== bytes.length)
					throw new TemporaryExportError('security-capability-missing');
				if (!bytes.equals(data.subarray(2, 8)))
					throw new TemporaryExportError('security-capability-missing');
				passed('range-resume');
				passed('immutable-version');
				capability = 'version-enumeration';
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
				passed('version-enumeration');
				capability = 'presigned-get';
				const signed = await getSignedUrl(
					this.client,
					new GetObjectCommand({ ...params, VersionId: head.VersionId }),
					{ expiresIn: 60 }
				);
				const first = await this.probeRange(signed, 0, 15, signal),
					second = await this.probeRange(signed, 16, 31, signal);
				if (!Buffer.concat([first, second]).equals(data))
					throw new TemporaryExportError('security-capability-missing');
				passed('presigned-get');
				capability = 'multipart-upload';
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
				passed('multipart-upload');
				capability = 'multipart-enumeration';
				const pending = await this.client.send(
					new ListMultipartUploadsCommand({ Bucket: params.Bucket, Prefix: key, MaxUploads: 10 }),
					{ abortSignal: signal }
				);
				if (!pending.Uploads?.some(u => u.Key === key && u.UploadId === mp.UploadId))
					throw new TemporaryExportError('security-capability-missing');
				passed('multipart-enumeration');
				capability = 'conditional-completion';
				let refused = false;
				try {
					const unexpected = await this.client.send(
						new CompleteMultipartUploadCommand({
							...params,
							UploadId: mp.UploadId,
							MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part.ETag }] },
							IfNoneMatch: '*',
						}),
						{ abortSignal: signal }
					);
					remember(key, unexpected, data.length);
				} catch (error) {
					if (
						(error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode !==
						412
					)
						throw error;
					refused = true;
				}
				if (!refused) throw new TemporaryExportError('security-capability-missing');
				passed('conditional-completion');
				// Complete a real TWO-part random object before reading backup data.
				// The first part meets S3's minimum; only 5 MiB is retained in memory.
				capability = 'multipart-completion';
				await this.absent(job, signal);
				const full = this.scope(job),
					random = crypto.randomBytes(5 * 1024 ** 2);
				const multipart = await this.client.send(
					new CreateMultipartUploadCommand({
						...full,
						ServerSideEncryption: 'AES256',
						Metadata: this.metadata(job),
					}),
					{ abortSignal: signal }
				);
				if (!multipart.UploadId) throw new TemporaryExportError('security-capability-missing');
				job.uploadId = multipart.UploadId;
				update({ uploadId: multipart.UploadId });
				const parts: CompletedPart[] = [];
				for (const [index, body] of [random, data].entries()) {
					const part = await this.client.send(
						new UploadPartCommand({
							...full,
							UploadId: multipart.UploadId,
							PartNumber: index + 1,
							Body: body,
							ContentLength: body.length,
							ContentMD5: crypto.createHash('md5').update(body).digest('base64'),
						}),
						{ abortSignal: signal }
					);
					if (!part.ETag) throw new TemporaryExportError('security-capability-missing');
					parts.push({ PartNumber: index + 1, ETag: part.ETag });
				}
				const completed = await this.client.send(
					new CompleteMultipartUploadCommand({
						...full,
						UploadId: multipart.UploadId,
						MultipartUpload: { Parts: parts },
						IfNoneMatch: '*',
					}),
					{ abortSignal: signal }
				);
				remember(job.key, completed, random.length + data.length);
				if (!completed.VersionId || completed.VersionId === 'null')
					throw new TemporaryExportError('security-capability-missing');
				const stored = await this.client.send(
					new HeadObjectCommand({ ...full, VersionId: completed.VersionId }),
					{ abortSignal: signal }
				);
				if (
					stored.ContentLength !== random.length + data.length ||
					stored.ServerSideEncryption !== 'AES256' ||
					!this.owns(job, stored)
				)
					throw new TemporaryExportError('security-capability-missing');
				const readback = await this.client.send(
					new GetObjectCommand({ ...full, VersionId: completed.VersionId, IfMatch: stored.ETag }),
					{ abortSignal: signal }
				);
				let readBytes = 0;
				const digest = crypto.createHash('sha256');
				try {
					if (
						!readback.Body ||
						readback.VersionId !== completed.VersionId ||
						readback.ContentLength !== random.length + data.length
					)
						throw new TemporaryExportError('security-capability-missing');
					for await (const chunk of readback.Body as Readable) {
						readBytes += chunk.length;
						if (readBytes > random.length + data.length)
							throw new TemporaryExportError('security-capability-missing');
						digest.update(chunk);
					}
					if (
						readBytes !== random.length + data.length ||
						digest.digest('hex') !==
							crypto.createHash('sha256').update(random).update(data).digest('hex')
					)
						throw new TemporaryExportError('security-capability-missing');
				} finally {
					(readback.Body as Readable)?.destroy();
				}
				passed('multipart-completion');
			} catch (error) {
				probeFailure = error;
			}
			try {
				await this.cleanup(job, AbortSignal.timeout(30_000));
				passed('cleanup');
			} catch {
				throw new ExportPreflightError('cleanup', 'cleanup-failed');
			}
			job.probeUploadId = undefined;
			job.uploadId = undefined;
			job.ownedVersions = undefined;
			update({ probeUploadId: undefined, uploadId: undefined, ownedVersions: undefined });
			if (probeFailure) throw probeFailure;
			job.capabilityBinding = exportCapabilityBinding(this.config);
			job.providerEvidence = {
				mode: 'versioned',
				versioning: 'enabled',
				writeOnce: false,
				conditionalRange: true,
				cleanup: 'version-specific',
				transport: 'versioned-presigned-and-proxy',
				verifiedAt: Date.now(),
			};
			update({ capabilityBinding: job.capabilityBinding, providerEvidence: job.providerEvidence });
		} catch (error) {
			this.capabilityFailure(error, capability);
		}
	}
	private capabilityFailure(error: unknown, capability: ExportCapability): never {
		if (error instanceof ExportPreflightError) throw error;
		const e = error as { code?: string; name?: string; $metadata?: { httpStatusCode?: number } };
		const status = e.$metadata?.httpStatusCode;
		const tls = [
			'DEPTH_ZERO_SELF_SIGNED_CERT',
			'SELF_SIGNED_CERT_IN_CHAIN',
			'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
			'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
			'ERR_TLS_CERT_ALTNAME_INVALID',
			'CERT_HAS_EXPIRED',
		].includes(e.code || '');
		const category = tls
			? 'tls-validation'
			: status === 401 || status === 403
				? 'access-denied'
				: status === 405 || status === 501
					? 'unsupported-api'
					: error instanceof TemporaryExportError || status
						? 'unexpected-response'
						: 'network-or-deadline';
		throw new ExportPreflightError(
			tls ? 'https' : capability,
			category,
			Number.isInteger(status) ? status : undefined
		);
	}
	/** Read only names/version headers within the reserved prefix. Never inspect
	 * repository contents, return keys, or adopt a foreign object/upload. */
	async inventory(jobs: ExportJob[], signal: AbortSignal) {
		jobs = jobs.flatMap(j => [j, ...(j.capabilityProbe ? [j.capabilityProbe] : [])]);
		try {
			if ((await this.mode(signal)) === 'hcp-write-once')
				return await this.writeOnce.inventory(jobs, signal);
		} catch (error) {
			this.capabilityFailure(error, 'destination-isolation');
		}
		const known = new Map(
			jobs
				.filter(job => !job.cleaned && job.destination === this.config.fingerprint)
				.map(job => [job.key, job])
		);
		let capability: ExportCapability = 'versioning';
		let objects = 0,
			uploads = 0;
		let keyMarker: string | undefined, versionMarker: string | undefined;
		try {
			const versioning = await this.client.send(
				new GetBucketVersioningCommand({ Bucket: this.config.bucket }),
				{ abortSignal: signal }
			);
			if (versioning.Status !== 'Enabled')
				throw new ExportPreflightError('versioning', 'unexpected-response');
			capability = 'destination-isolation';
			for (let page = 0; page < 8; page++) {
				const result = await this.client.send(
					new ListObjectVersionsCommand({
						Bucket: this.config.bucket,
						Prefix: this.config.prefix + '/',
						MaxKeys: 100,
						KeyMarker: keyMarker,
						VersionIdMarker: versionMarker,
					}),
					{ abortSignal: signal }
				);
				if (result.DeleteMarkers?.length) throw new Error();
				for (const object of result.Versions || []) {
					const job =
						known.get(object.Key || '') || known.get((object.Key || '').replace(/\.probe$/, ''));
					if (
						!job ||
						![job.key, job.key + '.probe'].includes(object.Key || '') ||
						!object.VersionId ||
						!this.versionProof(job, object.Key!, object.VersionId)
					)
						throw new Error();
					const head = await this.client.send(
						new HeadObjectCommand({ ...this.scope(job, object.Key), VersionId: object.VersionId }),
						{ abortSignal: signal }
					);
					if (!this.matchesVersionProof(job, object.Key!, object.VersionId, head))
						throw new Error();
					objects++;
				}
				if (!result.IsTruncated) break;
				if (
					page === 7 ||
					!result.NextKeyMarker ||
					(result.NextKeyMarker === keyMarker && result.NextVersionIdMarker === versionMarker)
				)
					throw new Error();
				keyMarker = result.NextKeyMarker;
				versionMarker = result.NextVersionIdMarker;
			}
			let uploadMarker: string | undefined;
			keyMarker = undefined;
			capability = 'destination-isolation';
			for (let page = 0; page < 8; page++) {
				const result: ListMultipartUploadsCommandOutput = await this.client.send(
					new ListMultipartUploadsCommand({
						Bucket: this.config.bucket,
						Prefix: this.config.prefix + '/',
						MaxUploads: 100,
						KeyMarker: keyMarker,
						UploadIdMarker: uploadMarker,
					}),
					{ abortSignal: signal }
				);
				for (const upload of result.Uploads || []) {
					const job =
						known.get(upload.Key || '') || known.get((upload.Key || '').replace(/\.probe$/, ''));
					if (!job || !upload.UploadId || !this.ownsUpload(job, upload.Key!, upload.UploadId))
						throw new Error();
					uploads++;
				}
				if (!result.IsTruncated) break;
				if (
					page === 7 ||
					!result.NextKeyMarker ||
					(result.NextKeyMarker === keyMarker && result.NextUploadIdMarker === uploadMarker)
				)
					throw new Error();
				keyMarker = result.NextKeyMarker;
				uploadMarker = result.NextUploadIdMarker;
			}
			return { objects, uploads, exclusive: true as const };
		} catch (error) {
			this.capabilityFailure(error, capability);
		}
	}
	private ownsUpload(job: ExportJob, key: string, id: string): boolean {
		return (
			(key === job.key && job.uploadId === id) ||
			(key === job.key + '.probe' && job.probeUploadId === id)
		);
	}
	private versionProof(job: ExportJob, key: string, version: string) {
		return (
			job.ownedVersions?.find(item => item.key === key && item.versionId === version) ||
			(key === job.key && version === job.versionId && job.summary
				? { key, versionId: version, etag: job.etag, bytes: job.summary.archiveBytes }
				: undefined)
		);
	}
	private matchesVersionProof(
		job: ExportJob,
		key: string,
		version: string,
		head: HeadObjectCommandOutput
	) {
		const proof = this.versionProof(job, key, version);
		return (
			!!proof &&
			this.owns(job, head) &&
			head.VersionId === version &&
			head.ContentLength === proof.bytes &&
			head.ServerSideEncryption === 'AES256' &&
			(!proof.etag || proof.etag === head.ETag) &&
			(version !== job.versionId ||
				head.Metadata?.['archive-sha256'] === job.summary?.archiveSha256)
		);
	}
	/** Two authenticated requests prove the private URL can resume the SAME random
	 * version. No URL, header, provider body or permanent key enters diagnostics. */
	private probeRange(
		url: string,
		start: number,
		end: number,
		signal: AbortSignal
	): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const request = https.get(
				url,
				{
					headers: { Range: `bytes=${start}-${end}` },
					ca: this.config.ca,
					rejectUnauthorized: true,
					signal,
				},
				response => {
					const output = Buffer.alloc(end - start + 1);
					let bytes = 0;
					response.on('error', () => reject(new TemporaryExportError('storage-unavailable')));
					if (
						response.statusCode !== 206 ||
						response.headers['content-range'] !== `bytes ${start}-${end}/32` ||
						Number(response.headers['content-length']) !== output.length
					) {
						response.destroy();
						reject(
							Object.assign(new TemporaryExportError('security-capability-missing'), {
								$metadata: { httpStatusCode: response.statusCode },
							})
						);
						return;
					}
					response.on('data', (chunk: Buffer) => {
						if (bytes + chunk.length > output.length) {
							response.destroy();
							reject(new TemporaryExportError('security-capability-missing'));
							return;
						}
						chunk.copy(output, bytes);
						bytes += chunk.length;
					});
					response.on('end', () =>
						bytes === output.length
							? resolve(output)
							: reject(new TemporaryExportError('security-capability-missing'))
					);
				}
			);
			request.on('error', reject); // Caller reduces transport errors to bounded diagnostics.
		});
	}
	private async assertPrivate(key: string, version: string | undefined, signal: AbortSignal) {
		const url = new URL(
			`${this.config.endpoint}/${encodeURIComponent(this.config.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`
		);
		if (version) url.searchParams.set('versionId', version);
		await this.assertAnonymousDenied(url, signal);
		const listing = new URL(`${this.config.endpoint}/${encodeURIComponent(this.config.bucket)}`);
		listing.searchParams.set('list-type', '2');
		listing.searchParams.set('prefix', `${this.config.prefix}/`);
		listing.searchParams.set('max-keys', '1');
		await this.assertAnonymousDenied(listing, signal);
	}
	private assertAnonymousDenied(url: URL, signal: AbortSignal) {
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
					else
						reject(
							Object.assign(new TemporaryExportError('security-capability-missing'), {
								$metadata: { httpStatusCode: response.statusCode },
							})
						);
				}
			);
			request.once('error', reject);
			request.end();
		});
	}
	async upload(
		job: ExportJob,
		archive: ManagedArchiveDownload,
		signal: AbortSignal,
		update: (fields: Partial<ExportJob>) => void
	) {
		if (job.publicationAttempted || job.identity) throw new TemporaryExportError('object-mismatch');
		if (
			job.integrityMode === 'hcp-write-once' &&
			(!job.capabilityBinding || !job.providerEvidence?.writeOnce)
		)
			throw new TemporaryExportError('security-capability-missing');
		if (job.integrityMode === 'hcp-write-once') {
			if (
				(await this.mode(signal)) !== 'hcp-write-once' ||
				job.capabilityBinding !== exportCapabilityBinding(this.config)
			)
				throw new TemporaryExportError('security-capability-missing');
			await this.writeOnce.publicationGuard(job, signal, update);
		}
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
		if (job.integrityMode === 'hcp-write-once')
			job.ownedUploads = [
				...(job.ownedUploads || []),
				{ key: job.key, uploadId: created.UploadId },
			];
		update({
			uploadId: created.UploadId,
			ownedUploads: job.ownedUploads,
			state: 'uploading',
			uploadStartedAt: Date.now(),
		});
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
			if (job.integrityMode === 'hcp-write-once') {
				if ((await this.mode(signal)) !== 'hcp-write-once')
					throw new TemporaryExportError('security-capability-missing');
				await this.writeOnce.publicationGuard(job, signal, update);
			}
			job.publicationAttempted = true;
			update({ publicationAttempted: true });
			const result = await this.client.send(
				new CompleteMultipartUploadCommand({
					...this.scope(job),
					UploadId: job.uploadId,
					MultipartUpload: { Parts: parts },
					...(job.integrityMode === 'hcp-write-once' ? {} : { IfNoneMatch: '*' }),
				}),
				{ abortSignal: signal }
			);
			if (job.integrityMode === 'hcp-write-once') {
				await this.writeOnce.record(
					job,
					job.key,
					result,
					archive.export.archiveBytes,
					archive.export.archiveSha256,
					signal,
					update,
					false
				);
				const proof = job.ownedObjects!.find(p => p.key === job.key)!;
				job.identity = {
					mode: 'hcp-write-once',
					key: job.key,
					etag: proof.etag,
					bytes: proof.bytes,
					sha256: proof.sha256,
					binding: bindingDigest(job.binding),
					created: proof.created,
					capability: job.capabilityBinding!,
				};
				job.etag = proof.etag;
				update({
					identity: job.identity,
					etag: job.etag,
					uploadId: undefined,
					state: 'verifying',
					uploadFinishedAt: Date.now(),
				});
				return;
			}
			if (!result.VersionId || result.VersionId === 'null' || !result.ETag)
				throw new TemporaryExportError('security-capability-missing');
			job.versionId = result.VersionId;
			job.etag = result.ETag;
			update({
				identity: { mode: 'versioned', versionId: result.VersionId, etag: result.ETag },
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
		if (job.integrityMode === 'hcp-write-once') return this.writeOnce.identity(job, signal);
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
		if (job.integrityMode === 'hcp-write-once') return this.writeOnce.head(job, signal);
		return this.client.send(
			new HeadObjectCommand({ ...this.scope(job), VersionId: job.versionId, IfMatch: job.etag }),
			{ abortSignal: signal }
		);
	}
	async get(job: ExportJob, signal: AbortSignal, range?: string) {
		if (job.integrityMode === 'hcp-write-once') return this.writeOnce.get(job, signal, range);
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
		if (job.integrityMode === 'hcp-write-once')
			throw new TemporaryExportError('security-capability-missing');
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
		if (job.capabilityProbe && !job.capabilityProbe.cleaned)
			await this.writeOnce.cleanup(job.capabilityProbe, signal);
		if (job.integrityMode === 'hcp-write-once') return this.writeOnce.cleanup(job, signal);
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
				if ([job.key, job.key + '.probe'].includes(upload.Key || '') && upload.UploadId) {
					if (
						this.config.allowSharedNamespace &&
						!this.ownsUpload(job, upload.Key!, upload.UploadId)
					)
						throw new TemporaryExportError('cleanup-pending');
					await abort(upload.Key!, upload.UploadId);
				}
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
						if (
							!this.owns(job, head) ||
							(this.config.allowSharedNamespace &&
								!this.matchesVersionProof(job, key, item.VersionId, head))
						) {
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
					if (item.Key === key && item.VersionId) {
						if (this.config.allowSharedNamespace) throw new TemporaryExportError('cleanup-pending');
						markers.push({ Key: key, VersionId: item.VersionId });
					}
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

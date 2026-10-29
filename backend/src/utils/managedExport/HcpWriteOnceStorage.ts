import crypto from 'crypto';
import { Readable } from 'stream';
import {
	S3Client,
	GetBucketVersioningCommand,
	PutObjectCommand,
	HeadObjectCommand,
	GetObjectCommand,
	GetObjectAclCommand,
	CreateMultipartUploadCommand,
	UploadPartCommand,
	CompleteMultipartUploadCommand,
	AbortMultipartUploadCommand,
	ListPartsCommand,
	ListObjectsV2Command,
	ListMultipartUploadsCommand,
	DeleteObjectCommand,
	type CompletedPart,
	type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import {
	TemporaryExportError,
	ExportPreflightError,
	bindingDigest,
	exportCapabilityBinding,
	type ExportConfig,
	type ExportJob,
	type ExportCapability,
} from './ExportPolicy';

const status = (e: unknown) =>
	(e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
const absent = (e: unknown) => status(e) === 404;
const sha = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');
export const writeOnceKeys = (job: ExportJob) => [
	job.key,
	job.key + '.probe',
	job.key + '.probe-race',
	job.key + '.probe-put-race',
];
type Update = (fields: Partial<ExportJob>) => void;

/** Observed protocol properties, never a vendor-name allowlist. Local reference
 * fixtures exercise this contract; only the destination's own preflight admits it.
 * All mutations are confined to durable, exact random job keys and upload IDs. */
export class HcpWriteOnceStorage {
	constructor(
		private readonly client: S3Client,
		private readonly config: ExportConfig,
		private readonly scope: (job: ExportJob, key?: string) => { Bucket: string; Key: string },
		private readonly metadata: (job: ExportJob) => Record<string, string>,
		private readonly owns: (job: ExportJob, head: { Metadata?: Record<string, string> }) => boolean,
		private readonly privacy: (
			key: string,
			version: string | undefined,
			signal: AbortSignal
		) => Promise<void>
	) {}
	private send(
		command:
			| GetBucketVersioningCommand
			| HeadObjectCommand
			| PutObjectCommand
			| GetObjectCommand
			| GetObjectAclCommand
			| CreateMultipartUploadCommand
			| UploadPartCommand
			| CompleteMultipartUploadCommand
			| AbortMultipartUploadCommand
			| ListPartsCommand
			| ListObjectsV2Command
			| ListMultipartUploadsCommand
			| DeleteObjectCommand,
		signal: AbortSignal
	): Promise<any> {
		return this.client.send(command as HeadObjectCommand, { abortSignal: signal });
	}
	private matches(job: ExportJob, key: string, head: HeadObjectCommandOutput) {
		const proof = job.ownedObjects?.find(p => p.key === key);
		return (
			!!proof &&
			(!head.VersionId || head.VersionId === 'null') &&
			this.owns(job, head) &&
			head.Metadata?.['pluton-export-nonce'] === job.ownershipNonce &&
			head.ServerSideEncryption === 'AES256' &&
			head.ContentLength === proof.bytes &&
			head.ETag === proof.etag &&
			head.LastModified?.toISOString() === proof.created
		);
	}
	async head(job: ExportJob, signal: AbortSignal, key = job.key) {
		const proof = job.ownedObjects?.find(p => p.key === key);
		const head = await this.send(
			new HeadObjectCommand({ ...this.scope(job, key), IfMatch: proof?.etag }),
			signal
		).catch(e => {
			if ([404, 412].includes(status(e) || 0)) throw new TemporaryExportError('object-mismatch');
			throw e;
		});
		if (!this.matches(job, key, head)) throw new TemporaryExportError('object-mismatch');
		return head as HeadObjectCommandOutput;
	}
	async get(job: ExportJob, signal: AbortSignal, range?: string, key = job.key) {
		const proof = job.ownedObjects?.find(p => p.key === key);
		if (!proof) throw new TemporaryExportError('object-mismatch');
		const result = await this.send(
			new GetObjectCommand({ ...this.scope(job, key), IfMatch: proof.etag, Range: range }),
			signal
		).catch(e => {
			if ([404, 412].includes(status(e) || 0)) throw new TemporaryExportError('object-mismatch');
			throw e;
		});
		const match = range && /^bytes=(\d+)-(\d+)$/.exec(range);
		const start = match ? Number(match[1]) : 0,
			end = match ? Number(match[2]) : proof.bytes - 1;
		if (
			!result.Body ||
			!this.matches(job, key, { ...result, ContentLength: proof.bytes }) ||
			result.ContentLength !== end - start + 1 ||
			(range
				? !match ||
					result.$metadata?.httpStatusCode !== 206 ||
					result.ContentRange !== `bytes ${start}-${end}/${proof.bytes}`
				: result.$metadata?.httpStatusCode !== 200)
		) {
			(result.Body as Readable)?.destroy();
			throw new TemporaryExportError('object-mismatch');
		}
		return result;
	}
	private async readback(job: ExportJob, key: string, signal: AbortSignal) {
		await this.head(job, signal, key);
		const proof = job.ownedObjects!.find(p => p.key === key)!;
		const result = await this.get(job, signal, undefined, key);
		const hash = crypto.createHash('sha256');
		let bytes = 0;
		try {
			for await (const chunk of result.Body as Readable) {
				bytes += chunk.length;
				if (bytes > proof.bytes) throw new TemporaryExportError('object-mismatch');
				hash.update(chunk);
			}
		} finally {
			(result.Body as Readable).destroy();
		}
		if (bytes !== proof.bytes || hash.digest('hex') !== proof.sha256)
			throw new TemporaryExportError('object-mismatch');
	}
	async record(
		job: ExportJob,
		key: string,
		result: { ETag?: string; VersionId?: string },
		bytes: number,
		digest: string,
		signal: AbortSignal,
		update: Update,
		verify = true
	) {
		// Never adopt an object from HEAD alone after a lost completion response.
		if (!result.ETag || (result.VersionId && result.VersionId !== 'null'))
			throw new TemporaryExportError('object-mismatch');
		const head = await this.send(
			new HeadObjectCommand({ ...this.scope(job, key), IfMatch: result.ETag }),
			signal
		);
		if (
			head.ETag !== result.ETag ||
			head.ContentLength !== bytes ||
			!head.LastModified ||
			(head.VersionId && head.VersionId !== 'null') ||
			head.ServerSideEncryption !== 'AES256' ||
			!this.owns(job, head) ||
			head.Metadata?.['pluton-export-nonce'] !== job.ownershipNonce
		)
			throw new TemporaryExportError('object-mismatch');
		job.ownedObjects = [
			...(job.ownedObjects || []).filter(p => p.key !== key),
			{ key, etag: result.ETag, bytes, sha256: digest, created: head.LastModified.toISOString() },
		];
		update({ ownedObjects: job.ownedObjects });
		if (verify) await this.readback(job, key, signal);
	}
	async identity(job: ExportJob, signal: AbortSignal) {
		const identity = job.identity;
		if (
			identity?.mode !== 'hcp-write-once' ||
			identity.key !== job.key ||
			identity.binding !== bindingDigest(job.binding) ||
			identity.bytes !== job.summary?.archiveBytes ||
			identity.sha256 !== job.summary?.archiveSha256 ||
			identity.etag !== job.etag ||
			identity.capability !== job.capabilityBinding
		)
			throw new TemporaryExportError('object-mismatch');
		const head = await this.head(job, signal);
		if (
			head.Metadata?.['archive-sha256'] !== identity.sha256 ||
			head.LastModified?.toISOString() !== identity.created
		)
			throw new TemporaryExportError('object-mismatch');
		await this.privacy(job.key, undefined, signal);
		return head;
	}
	async inventory(jobs: ExportJob[], signal: AbortSignal, prefix = this.config.prefix + '/') {
		const known = jobs.filter(j => !j.cleaned && j.destination === this.config.fingerprint);
		let objects = 0,
			uploads = 0,
			token: string | undefined;
		for (let page = 0; page < 8; page++) {
			const listing = await this.send(
				new ListObjectsV2Command({
					Bucket: this.config.bucket,
					Prefix: prefix,
					MaxKeys: 100,
					ContinuationToken: token,
				}),
				signal
			);
			for (const object of listing.Contents || []) {
				const job = known.find(j => writeOnceKeys(j).includes(object.Key || ''));
				if (!job || job.integrityMode !== 'hcp-write-once')
					throw new ExportPreflightError('destination-isolation', 'unexpected-response');
				await this.head(job, signal, object.Key);
				objects++;
			}
			if (!listing.IsTruncated) break;
			if (page === 7 || !listing.NextContinuationToken || token === listing.NextContinuationToken)
				throw new ExportPreflightError('destination-isolation', 'unexpected-response');
			token = listing.NextContinuationToken;
		}
		let keyMarker: string | undefined, uploadMarker: string | undefined;
		for (let page = 0; page < 8; page++) {
			const listing = await this.send(
				new ListMultipartUploadsCommand({
					Bucket: this.config.bucket,
					Prefix: prefix,
					MaxUploads: 100,
					KeyMarker: keyMarker,
					UploadIdMarker: uploadMarker,
				}),
				signal
			);
			for (const upload of listing.Uploads || []) {
				if (
					!known.some(j =>
						j.ownedUploads?.some(u => u.key === upload.Key && u.uploadId === upload.UploadId)
					)
				)
					throw new ExportPreflightError('destination-isolation', 'unexpected-response');
				uploads++;
			}
			if (!listing.IsTruncated) break;
			if (
				page === 7 ||
				!listing.NextKeyMarker ||
				(listing.NextKeyMarker === keyMarker && listing.NextUploadIdMarker === uploadMarker)
			)
				throw new ExportPreflightError('destination-isolation', 'unexpected-response');
			keyMarker = listing.NextKeyMarker;
			uploadMarker = listing.NextUploadIdMarker;
		}
		return { objects, uploads, exclusive: true as const };
	}
	private async absent(job: ExportJob, key: string, signal: AbortSignal) {
		try {
			await this.send(new HeadObjectCommand(this.scope(job, key)), signal);
		} catch (e) {
			if (absent(e)) return;
			throw e;
		}
		throw new TemporaryExportError('object-mismatch');
	}
	private async multipart(
		job: ExportJob,
		key: string,
		bodies: Buffer[],
		signal: AbortSignal,
		update: Update
	) {
		const params = this.scope(job, key);
		const created = await this.send(
			new CreateMultipartUploadCommand({
				...params,
				ServerSideEncryption: 'AES256',
				Metadata: this.metadata(job),
			}),
			signal
		);
		if (!created.UploadId || (job.ownedUploads?.length || 0) >= 8)
			throw new TemporaryExportError('security-capability-missing');
		job.ownedUploads = [...(job.ownedUploads || []), { key, uploadId: created.UploadId }];
		update({ ownedUploads: job.ownedUploads });
		const parts: CompletedPart[] = [];
		for (const [index, body] of bodies.entries()) {
			const part = await this.send(
				new UploadPartCommand({
					...params,
					UploadId: created.UploadId,
					PartNumber: index + 1,
					Body: body,
					ContentLength: body.length,
					ContentMD5: crypto.createHash('md5').update(body).digest('base64'),
				}),
				signal
			);
			if (!part.ETag) throw new TemporaryExportError('security-capability-missing');
			parts.push({ PartNumber: index + 1, ETag: part.ETag });
		}
		return { params, id: created.UploadId as string, parts };
	}
	private complete(
		upload: Awaited<ReturnType<HcpWriteOnceStorage['multipart']>>,
		signal: AbortSignal
	) {
		// Deliberately NO AWS conditional header: the provider's namespace policy
		// must reject collisions even when those headers are ignored/unsupported.
		return this.send(
			new CompleteMultipartUploadCommand({
				...upload.params,
				UploadId: upload.id,
				MultipartUpload: { Parts: upload.parts },
			}),
			signal
		);
	}
	private async rejected(operation: () => Promise<unknown>) {
		try {
			await operation();
		} catch (e) {
			// HCP documents 409 for write-once collisions. An arbitrary SDK error,
			// permission failure, timeout or 200 XML error is NOT collision evidence.
			if (status(e) === 409) return 409;
			throw e;
		}
		throw new TemporaryExportError('security-capability-missing');
	}
	/** Recheck the namespace policy immediately before streaming/publication;
	 * a previous GO must not mask an operator changing overwrite/versioning. */
	async publicationGuard(job: ExportJob, signal: AbortSignal, update: Update) {
		const key = job.key + '.probe';
		let proof = job.ownedObjects?.find(p => p.key === key);
		if (!proof) {
			await this.absent(job, key, signal);
			const data = crypto.randomBytes(32);
			const created = await this.send(
				new PutObjectCommand({
					...this.scope(job, key),
					Body: data,
					ContentLength: data.length,
					ServerSideEncryption: 'AES256',
					Metadata: this.metadata(job),
				}),
				signal
			);
			await this.record(job, key, created, data.length, sha(data), signal, update);
			proof = job.ownedObjects!.find(p => p.key === key)!;
		}
		const other = crypto.randomBytes(32);
		await this.rejected(() =>
			this.send(
				new PutObjectCommand({
					...this.scope(job, key),
					Body: other,
					ContentLength: other.length,
					ServerSideEncryption: 'AES256',
					Metadata: this.metadata(job),
				}),
				signal
			)
		);
		const attempt = await this.multipart(job, key, [other], signal, update);
		await this.rejected(() => this.complete(attempt, signal));
		await this.readback(job, key, signal);
	}
	async preflight(job: ExportJob, signal: AbortSignal, update: Update) {
		let capability: ExportCapability = 'write-once-creation';
		const passed = (step: ExportCapability) => {
			job.preflightChecks = [...new Set([...(job.preflightChecks || []), step])];
			update({ preflightChecks: job.preflightChecks });
		};
		job.integrityMode = 'hcp-write-once';
		job.ownershipNonce ||= crypto.randomBytes(32).toString('hex');
		job.capabilityBinding = exportCapabilityBinding(this.config);
		update({
			integrityMode: job.integrityMode,
			ownershipNonce: job.ownershipNonce,
			capabilityBinding: job.capabilityBinding,
		});
		const data = crypto.randomBytes(32),
			other = crypto.randomBytes(32),
			key = job.key + '.probe';
		let failure: unknown;
		try {
			passed('https');
			await this.absent(job, key, signal);
			const params = this.scope(job, key);
			const initial = await this.send(
				new PutObjectCommand({
					...params,
					Body: data,
					ContentLength: data.length,
					ServerSideEncryption: 'AES256',
					Metadata: this.metadata(job),
				}),
				signal
			);
			await this.record(job, key, initial, data.length, sha(data), signal, update);
			passed('sse-s3');
			capability = 'collision-rejection';
			await this.rejected(() =>
				this.send(
					new PutObjectCommand({
						...params,
						Body: other,
						ContentLength: other.length,
						ServerSideEncryption: 'AES256',
						Metadata: this.metadata(job),
					}),
					signal
				)
			);
			await this.readback(job, key, signal);
			passed('write-once-creation');
			passed('collision-rejection');
			capability = 'private-acl';
			const acl = await this.send(new GetObjectAclCommand(params), signal);
			if (
				!acl.Grants?.length ||
				acl.Grants.some((g: any) => g.Grantee?.URI || g.Grantee?.Type !== 'CanonicalUser')
			)
				throw new TemporaryExportError('security-capability-missing');
			passed('private-acl');
			capability = 'anonymous-denial';
			await this.privacy(key, undefined, signal);
			passed('anonymous-denial');
			capability = 'conditional-range';
			for (const command of [
				new HeadObjectCommand({ ...params, IfMatch: '"pluton-deliberately-wrong-etag"' }),
				new GetObjectCommand({
					...params,
					IfMatch: '"pluton-deliberately-wrong-etag"',
					Range: 'bytes=2-7',
				}),
			]) {
				let refused = false;
				try {
					const r = await this.send(command, signal);
					r.Body?.destroy();
				} catch (e) {
					if (status(e) !== 412) throw e;
					refused = true;
				}
				if (!refused) throw new TemporaryExportError('security-capability-missing');
			}
			const range = await this.get(job, signal, 'bytes=2-7', key);
			const chunks: Buffer[] = [];
			let length = 0;
			try {
				for await (const chunk of range.Body as Readable) {
					length += chunk.length;
					if (length > 6) throw new TemporaryExportError('object-mismatch');
					chunks.push(chunk);
				}
			} finally {
				(range.Body as Readable).destroy();
			}
			if (!Buffer.concat(chunks).equals(data.subarray(2, 8)))
				throw new TemporaryExportError('object-mismatch');
			passed('conditional-range');
			passed('range-resume');
			capability = 'multipart-completion';
			await this.absent(job, job.key, signal);
			const body = crypto.randomBytes(5 * 1024 ** 2),
				tail = crypto.randomBytes(32);
			const first = await this.multipart(job, job.key, [body, tail], signal, update);
			const second = await this.multipart(job, job.key, [other], signal, update);
			passed('multipart-upload');
			const completed = await this.complete(first, signal);
			await this.record(
				job,
				job.key,
				completed,
				body.length + tail.length,
				crypto.createHash('sha256').update(body).update(tail).digest('hex'),
				signal,
				update
			);
			await this.rejected(() => this.complete(second, signal));
			await this.readback(job, job.key, signal);
			passed('multipart-completion');
			passed('full-readback');
			capability = 'concurrent-publication';
			for (const includePut of [false, true]) {
				const raceKey = job.key + (includePut ? '.probe-put-race' : '.probe-race');
				await this.absent(job, raceKey, signal);
				const a = await this.multipart(job, raceKey, [data], signal, update);
				const b = await this.multipart(job, raceKey, [other], signal, update);
				// Prove MP/MP on its own: a normal PUT winning a three-way race
				// must not conceal a broken concurrent multipart publication path.
				const requests = [this.complete(a, signal), this.complete(b, signal)];
				if (includePut)
					requests.push(
						this.send(
							new PutObjectCommand({
								...this.scope(job, raceKey),
								Body: tail,
								ContentLength: tail.length,
								ServerSideEncryption: 'AES256',
								Metadata: this.metadata(job),
							}),
							signal
						)
					);
				const results = await Promise.allSettled(requests);
				const winners = results.flatMap((r, i) => (r.status === 'fulfilled' ? [i] : []));
				if (
					winners.length !== 1 ||
					results.some(r => r.status === 'rejected' && status(r.reason) !== 409)
				)
					throw new TemporaryExportError('security-capability-missing');
				const win = winners[0],
					bytes = [data, other, tail][win];
				await this.record(
					job,
					raceKey,
					(results[win] as PromiseFulfilledResult<any>).value,
					bytes.length,
					sha(bytes),
					signal,
					update
				);
			}
			// Normal PUT also races a completion against an already committed key.
			await Promise.all([
				this.rejected(() => this.complete(second, signal)),
				this.rejected(() =>
					this.send(
						new PutObjectCommand({
							...this.scope(job),
							Body: other,
							ContentLength: other.length,
							ServerSideEncryption: 'AES256',
							Metadata: this.metadata(job),
						}),
						signal
					)
				),
			]);
			await this.readback(job, job.key, signal);
			passed('concurrent-publication');
			capability = 'object-enumeration';
			await this.inventory([job], signal, job.key);
			passed('object-enumeration');
			passed('multipart-enumeration');
			capability = 'ownership-cleanup';
			// Probe conditional deletion ONLY on our disposable random object.
			// A server that ignores If-Match deletes it: this is reported honestly.
			let conditional = false;
			try {
				await this.send(
					new DeleteObjectCommand({ ...params, IfMatch: '"pluton-deliberately-wrong-etag"' }),
					signal
				);
			} catch (e) {
				if (status(e) === 412) conditional = true;
				else if (![400, 405, 501].includes(status(e) || 0)) throw e;
			}
			if (conditional) await this.readback(job, key, signal);
			// Bounded cleanup is allowed only with the explicit shared-prefix
			// contract. It cannot revoke another credential holder's delete rights.
			if (!conditional && !this.config.allowSharedNamespace)
				throw new TemporaryExportError('security-capability-missing');
			job.providerEvidence = {
				mode: 'hcp-write-once',
				versioning: 'disabled-or-unavailable',
				writeOnce: true,
				collisionStatus: 409,
				concurrentPublication: true,
				conditionalRange: true,
				cleanup: conditional ? 'conditional-etag' : 'exclusive-prefix-bounded',
				transport: 'authenticated-proxy',
				verifiedAt: Date.now(),
			};
			update({ providerEvidence: job.providerEvidence });
		} catch (e) {
			failure = e;
			job.probeFailure = { capability, category: 'unexpected-response', httpStatus: status(e) };
			update({ probeFailure: job.probeFailure });
		}
		try {
			await this.cleanup(job, AbortSignal.timeout(30_000));
			passed('ownership-cleanup');
			passed('cleanup');
			job.ownedObjects = [];
			job.ownedUploads = [];
			update({ ownedObjects: [], ownedUploads: [] });
		} catch {
			throw new ExportPreflightError('cleanup', 'cleanup-failed');
		}
		if (failure) {
			if (failure instanceof ExportPreflightError) throw failure;
			const httpStatus = status(failure);
			throw new ExportPreflightError(
				capability,
				httpStatus === 403
					? 'access-denied'
					: httpStatus === 501
						? 'unsupported-api'
						: 'unexpected-response',
				httpStatus
			);
		}
	}
	private async unversioned(signal: AbortSignal) {
		// Enabling/suspending versioning after publication changes DELETE into a
		// marker operation. Never mark an archive cleaned while hidden bytes remain.
		try {
			const versioning = await this.send(
				new GetBucketVersioningCommand({ Bucket: this.config.bucket }),
				signal
			);
			if (['Enabled', 'Suspended'].includes(versioning.Status))
				throw new TemporaryExportError('cleanup-pending');
		} catch (e) {
			if (status(e) !== 501) throw e;
		}
	}
	async cleanup(job: ExportJob, signal: AbortSignal) {
		await this.unversioned(signal);
		const keys = writeOnceKeys(job);
		const pending = await this.send(
			new ListMultipartUploadsCommand({
				Bucket: this.config.bucket,
				Prefix: job.key,
				MaxUploads: 100,
			}),
			signal
		);
		if (
			pending.IsTruncated ||
			pending.Uploads?.some(
				(u: any) =>
					keys.includes(u.Key) &&
					!job.ownedUploads?.some(p => p.key === u.Key && p.uploadId === u.UploadId)
			)
		)
			throw new TemporaryExportError('cleanup-pending');
		for (const upload of job.ownedUploads || []) {
			if (!keys.includes(upload.key)) throw new TemporaryExportError('cleanup-pending');
			try {
				await this.send(
					new AbortMultipartUploadCommand({
						...this.scope(job, upload.key),
						UploadId: upload.uploadId,
					}),
					signal
				);
			} catch (e) {
				if (!absent(e)) throw e;
			}
			try {
				await this.send(
					new ListPartsCommand({
						...this.scope(job, upload.key),
						UploadId: upload.uploadId,
						MaxParts: 1,
					}),
					signal
				);
			} catch (e) {
				if (absent(e)) continue;
				throw e;
			}
			throw new TemporaryExportError('cleanup-pending');
		}
		for (const key of keys) {
			try {
				await this.send(new HeadObjectCommand(this.scope(job, key)), signal);
			} catch (e) {
				if (absent(e)) continue;
				throw e;
			}
			// No durable successful response proof => no adoption, even with a
			// matching public marker. A crash/lost response requires operator review.
			const proof = job.ownedObjects?.find(p => p.key === key);
			if (!proof || !job.ownershipNonce) throw new TemporaryExportError('cleanup-pending');
			await this.readback(job, key, signal);
			await this.head(job, signal, key); // detect change during checksum readback
			await this.unversioned(signal);
			await this.send(
				new DeleteObjectCommand({
					...this.scope(job, key),
					...(job.providerEvidence?.cleanup === 'conditional-etag' ? { IfMatch: proof.etag } : {}),
				}),
				signal
			);
			await this.absent(job, key, signal); // HTTP success alone is insufficient
		}
		const remaining = await this.send(
			new ListMultipartUploadsCommand({
				Bucket: this.config.bucket,
				Prefix: job.key,
				MaxUploads: 100,
			}),
			signal
		);
		if (remaining.IsTruncated || remaining.Uploads?.some((u: any) => keys.includes(u.Key)))
			throw new TemporaryExportError('cleanup-pending');
		await this.unversioned(signal);
	}
}

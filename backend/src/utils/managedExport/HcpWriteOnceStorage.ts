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
	type _Object,
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
import {
	ExportCleanupError,
	ExportOperationError,
	exportDiagnostic,
	exportHttpStatus,
	exportTarget,
	type ExportOperation,
} from './ExportDiagnostics';
import {
	applicationEncrypted,
	ExportCipher,
	isWriteOnce,
	storedExportBytes,
	storedExportSha,
} from './ExportEncryption';

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
	private sse(job: ExportJob): { ServerSideEncryption?: 'AES256' } {
		return applicationEncrypted(job) ? {} : { ServerSideEncryption: 'AES256' };
	}
	private async send(
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
		try {
			return await this.client.send(command as HeadObjectCommand, { abortSignal: signal });
		} catch (error) {
			throw new ExportOperationError(
				command.constructor.name.replace(/Command$/, '') as ExportOperation,
				error,
				'provider-error',
				'storage-unavailable',
				exportTarget((command.input as { Key?: string }).Key)
			);
		}
	}
	private receipt(job: ExportJob, key: string, acknowledged: boolean, update: Update) {
		job.creationReceipts = [
			...(job.creationReceipts || []).filter(r => r.key !== key),
			{ key, acknowledged },
		];
		update({ creationReceipts: job.creationReceipts });
	}
	private matches(job: ExportJob, key: string, head: HeadObjectCommandOutput) {
		const proof = job.ownedObjects?.find(p => p.key === key);
		return (
			!!proof &&
			(!head.VersionId || head.VersionId === 'null') &&
			this.owns(job, head) &&
			head.Metadata?.['pluton-export-nonce'] === job.ownershipNonce &&
			(applicationEncrypted(job) || head.ServerSideEncryption === 'AES256') &&
			head.ContentLength === proof.bytes &&
			head.ETag === proof.etag &&
			head.LastModified instanceof Date &&
			Number.isFinite(head.LastModified.getTime()) &&
			head.LastModified.toISOString() === proof.created
		);
	}
	async head(job: ExportJob, signal: AbortSignal, key = job.key) {
		const proof = job.ownedObjects?.find(p => p.key === key);
		const head = await this.send(
			new HeadObjectCommand({ ...this.scope(job, key), IfMatch: proof?.etag }),
			signal
		).catch(e => {
			if ([404, 412].includes(status(e) || 0))
				throw new ExportOperationError(
					'HeadObject',
					e,
					'provider-error',
					'object-mismatch',
					exportTarget(key)
				);
			throw e;
		});
		if (!this.matches(job, key, head))
			throw new ExportOperationError(
				'HeadObject',
				head,
				'identity-mismatch',
				'object-mismatch',
				exportTarget(key)
			);
		return head as HeadObjectCommandOutput;
	}
	async get(job: ExportJob, signal: AbortSignal, range?: string, key = job.key) {
		const proof = job.ownedObjects?.find(p => p.key === key);
		if (!proof) throw new TemporaryExportError('object-mismatch');
		const result = await this.send(
			new GetObjectCommand({ ...this.scope(job, key), IfMatch: proof.etag, Range: range }),
			signal
		).catch(e => {
			if ([404, 412].includes(status(e) || 0))
				throw new ExportOperationError(
					'GetObject',
					e,
					'provider-error',
					'object-mismatch',
					exportTarget(key)
				);
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
			throw new ExportOperationError(
				'GetObject',
				result,
				'identity-mismatch',
				'object-mismatch',
				exportTarget(key)
			);
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
			throw new ExportOperationError(
				'GetObject',
				result,
				'checksum-mismatch',
				'object-mismatch',
				exportTarget(key)
			);
	}
	async record(
		job: ExportJob,
		key: string,
		result: { ETag?: string; VersionId?: string; $metadata?: { httpStatusCode?: number } },
		bytes: number,
		digest: string,
		signal: AbortSignal,
		update: Update,
		verify = true
	) {
		// Never adopt an object from HEAD alone after a lost completion response.
		// Journal the acknowledgement BEFORE validation. This is diagnostic evidence
		// only; only the independently checked complete proof below permits cleanup.
		this.receipt(job, key, true, update);
		if (
			!result.ETag ||
			exportHttpStatus(result) !== 200 ||
			(result.VersionId && result.VersionId !== 'null')
		)
			throw new ExportOperationError(
				'creation-response',
				result,
				!result.ETag
					? 'missing-etag'
					: exportHttpStatus(result) !== 200
						? 'unexpected-creation-status'
						: 'version-present',
				'object-mismatch',
				exportTarget(key)
			);
		const head = await this.send(
			new HeadObjectCommand({ ...this.scope(job, key), IfMatch: result.ETag }),
			signal
		);
		const detail =
			exportHttpStatus(head) !== 200
				? 'unexpected-head-status'
				: head.ETag !== result.ETag
					? 'etag-mismatch'
					: head.ContentLength !== bytes
						? 'length-mismatch'
						: !(head.LastModified instanceof Date) || !Number.isFinite(head.LastModified.getTime())
							? 'missing-last-modified'
							: head.VersionId && head.VersionId !== 'null'
								? 'version-present'
								: !applicationEncrypted(job) && head.ServerSideEncryption !== 'AES256'
									? 'sse-s3-unverified'
									: !this.owns(job, head) ||
										  head.Metadata?.['pluton-export-nonce'] !== job.ownershipNonce
										? 'ownership-marker-mismatch'
										: undefined;
		if (detail)
			throw new ExportOperationError(
				'HeadObject',
				head,
				detail,
				'object-mismatch',
				exportTarget(key)
			);
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
			!identity ||
			identity.mode === 'versioned' ||
			identity.mode !== job.integrityMode ||
			identity.key !== job.key ||
			identity.binding !== bindingDigest(job.binding) ||
			identity.bytes !== storedExportBytes(job) ||
			identity.sha256 !== storedExportSha(job) ||
			identity.etag !== job.etag ||
			identity.capability !== job.capabilityBinding
		)
			throw new TemporaryExportError('object-mismatch');
		const head = await this.head(job, signal);
		if (
			(applicationEncrypted(job)
				? head.Metadata?.['pluton-export-manifest'] !== job.encryption?.mac ||
					head.Metadata?.['pluton-export-format'] !== 'aead-v1' ||
					head.Metadata?.['pluton-export-purpose'] !== 'archive'
				: head.Metadata?.['archive-sha256'] !== identity.sha256) ||
			head.LastModified?.toISOString() !== identity.created
		)
			throw new TemporaryExportError('object-mismatch');
		await this.privacy(job.key, undefined, signal);
		return head;
	}
	/** Only the exact structural root can be exempted. Pin HEAD to the listed
	 * identity and require independent, consistent zero-byte evidence. No job,
	 * ownership receipt, body read or mutation is involved. */
	private async directoryMarker(object: _Object, signal: AbortSignal, listing: unknown) {
		if (object.Size !== 0)
			throw new ExportOperationError(
				'ListObjectsV2',
				listing,
				typeof object.Size === 'number' && object.Size > 0
					? 'directory-marker-nonzero'
					: 'directory-marker-unverified',
				'object-mismatch',
				'namespace'
			);
		if (
			typeof object.ETag !== 'string' ||
			!/^"[^"\r\n]{1,1022}"$/.test(object.ETag) ||
			!(object.LastModified instanceof Date) ||
			!Number.isFinite(object.LastModified.getTime())
		)
			throw new ExportOperationError(
				'ListObjectsV2',
				listing,
				'directory-marker-unverified',
				'object-mismatch',
				'namespace'
			);
		const head = await this.send(
			new HeadObjectCommand({
				Bucket: this.config.bucket,
				Key: this.config.prefix + '/',
				IfMatch: object.ETag,
			}),
			signal
		).catch(error => {
			throw new ExportOperationError(
				'HeadObject',
				error,
				'provider-error',
				'storage-unavailable',
				'namespace'
			);
		});
		if (
			exportHttpStatus(head) !== 200 ||
			head.ContentLength !== 0 ||
			head.ContentRange !== undefined ||
			head.ETag !== object.ETag ||
			head.DeleteMarker ||
			(head.VersionId && head.VersionId !== 'null') ||
			!(head.LastModified instanceof Date) ||
			!Number.isFinite(head.LastModified.getTime()) ||
			// HTTP Last-Modified has second precision; LIST XML can include fractions.
			Math.floor(head.LastModified.getTime() / 1000) !==
				Math.floor(object.LastModified.getTime() / 1000)
		)
			throw new ExportOperationError(
				'HeadObject',
				head,
				typeof head.ContentLength === 'number' && head.ContentLength > 0
					? 'directory-marker-nonzero'
					: 'directory-marker-unverified',
				'object-mismatch',
				'namespace'
			);
	}
	async inventory(jobs: ExportJob[], signal: AbortSignal, prefix = this.config.prefix + '/') {
		const known = jobs.filter(j => !j.cleaned && j.destination === this.config.fingerprint);
		let directoryMarker: 'verified-empty' | undefined;
		const seenKeys = new Set<string>(),
			tokens = new Set<string>();
		const listingError = (
			operation: 'ListObjectsV2' | 'ListMultipartUploads',
			listing: unknown,
			detail: 'listing-invalid' | 'listing-incomplete' | 'foreign-object' | 'unknown-multipart'
		) => new ExportOperationError(operation, listing, detail, 'object-mismatch', 'namespace');
		const validToken = (value: unknown): value is string =>
			typeof value === 'string' &&
			value.length > 0 &&
			value.length <= 2048 &&
			value.trim() === value &&
			Array.from(value).every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
		let objects = 0,
			uploads = 0,
			token: string | undefined;
		for (let page = 0; page < 8; page++) {
			signal.throwIfAborted();
			const listing = await this.send(
				new ListObjectsV2Command({
					Bucket: this.config.bucket,
					Prefix: prefix,
					MaxKeys: 100,
					ContinuationToken: token,
				}),
				signal
			);
			if (
				exportHttpStatus(listing) !== 200 ||
				typeof listing.IsTruncated !== 'boolean' ||
				(listing.Contents !== undefined && !Array.isArray(listing.Contents)) ||
				(listing.CommonPrefixes !== undefined &&
					(!Array.isArray(listing.CommonPrefixes) || listing.CommonPrefixes.length)) ||
				(listing.Prefix !== undefined && listing.Prefix !== prefix) ||
				(listing.Contents?.length || 0) > 100 ||
				(listing.KeyCount !== undefined && listing.KeyCount !== (listing.Contents?.length || 0))
			)
				throw listingError('ListObjectsV2', listing, 'listing-invalid');
			for (const object of listing.Contents || []) {
				if (
					!object ||
					typeof object.Key !== 'string' ||
					!object.Key.startsWith(prefix) ||
					seenKeys.has(object.Key)
				)
					throw listingError('ListObjectsV2', listing, 'listing-invalid');
				seenKeys.add(object.Key);
				if (object.Key === this.config.prefix + '/' && prefix === this.config.prefix + '/') {
					await this.directoryMarker(object, signal, listing);
					directoryMarker = 'verified-empty';
					continue;
				}
				const job = known.find(j => writeOnceKeys(j).includes(object.Key || ''));
				if (!job || !isWriteOnce(job.integrityMode))
					throw listingError('ListObjectsV2', listing, 'foreign-object');
				await this.head(job, signal, object.Key);
				objects++;
			}
			if (!listing.IsTruncated) {
				if (listing.NextContinuationToken)
					throw listingError('ListObjectsV2', listing, 'listing-incomplete');
				break;
			}
			if (
				page === 7 ||
				!validToken(listing.NextContinuationToken) ||
				tokens.has(listing.NextContinuationToken)
			)
				throw listingError('ListObjectsV2', listing, 'listing-incomplete');
			token = listing.NextContinuationToken;
			tokens.add(token!);
		}
		let keyMarker: string | undefined, uploadMarker: string | undefined;
		const uploadTokens = new Set<string>();
		for (let page = 0; page < 8; page++) {
			signal.throwIfAborted();
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
			if (
				exportHttpStatus(listing) !== 200 ||
				typeof listing.IsTruncated !== 'boolean' ||
				(listing.Uploads !== undefined && !Array.isArray(listing.Uploads)) ||
				(listing.CommonPrefixes !== undefined &&
					(!Array.isArray(listing.CommonPrefixes) || listing.CommonPrefixes.length)) ||
				(listing.Uploads?.length || 0) > 100 ||
				(listing.Prefix !== undefined && listing.Prefix !== prefix)
			)
				throw listingError('ListMultipartUploads', listing, 'listing-invalid');
			for (const upload of listing.Uploads || []) {
				if (
					!upload ||
					typeof upload.Key !== 'string' ||
					!upload.Key.startsWith(prefix) ||
					!validToken(upload.UploadId) ||
					!known.some(
						j =>
							isWriteOnce(j.integrityMode) &&
							writeOnceKeys(j).includes(upload.Key) &&
							j.ownedUploads?.some(u => u.key === upload.Key && u.uploadId === upload.UploadId)
					)
				)
					throw listingError('ListMultipartUploads', listing, 'unknown-multipart');
				uploads++;
			}
			if (!listing.IsTruncated) {
				if (listing.NextKeyMarker || listing.NextUploadIdMarker)
					throw listingError('ListMultipartUploads', listing, 'listing-incomplete');
				break;
			}
			const next = JSON.stringify([listing.NextKeyMarker, listing.NextUploadIdMarker]);
			if (
				page === 7 ||
				!validToken(listing.NextKeyMarker) ||
				!listing.NextKeyMarker.startsWith(prefix) ||
				!validToken(listing.NextUploadIdMarker) ||
				uploadTokens.has(next)
			)
				throw listingError('ListMultipartUploads', listing, 'listing-incomplete');
			uploadTokens.add(next);
			keyMarker = listing.NextKeyMarker;
			uploadMarker = listing.NextUploadIdMarker;
		}
		signal.throwIfAborted();
		return {
			objects,
			uploads,
			exclusive: true as const,
			...(directoryMarker ? { directoryMarker } : {}),
		};
	}
	private async absent(job: ExportJob, key: string, signal: AbortSignal) {
		let head: unknown;
		try {
			head = await this.send(new HeadObjectCommand(this.scope(job, key)), signal);
		} catch (e) {
			if (absent(e)) return;
			throw e;
		}
		throw new ExportOperationError(
			'HeadObject',
			head,
			'object-remains',
			'object-mismatch',
			exportTarget(key)
		);
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
				...this.sse(job),
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
			this.receipt(job, key, false, update);
			const created = await this.send(
				new PutObjectCommand({
					...this.scope(job, key),
					Body: data,
					ContentLength: data.length,
					...this.sse(job),
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
					...this.sse(job),
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
		job.integrityMode = this.config.exportMode || 'hcp-write-once';
		job.ownershipNonce ||= crypto.randomBytes(32).toString('hex');
		job.capabilityBinding = exportCapabilityBinding(this.config);
		update({
			integrityMode: job.integrityMode,
			ownershipNonce: job.ownershipNonce,
			capabilityBinding: job.capabilityBinding,
		});
		let data = crypto.randomBytes(32);
		const original = data,
			other = crypto.randomBytes(32),
			key = job.key + '.probe';
		let failure: unknown;
		try {
			passed('https');
			if (applicationEncrypted(job)) {
				capability = 'application-encryption';
				const cipher = ExportCipher.create(job, this.config, original.length, sha(original));
				try {
					job.encryption = cipher.value;
					update({ encryption: job.encryption });
					data = cipher.seal(0, original);
				} finally {
					cipher.close();
				}
			}
			await this.absent(job, key, signal);
			const params = this.scope(job, key);
			capability = 'write-once-creation';
			this.receipt(job, key, false, update);
			const initial = await this.send(
				new PutObjectCommand({
					...params,
					Body: data,
					ContentLength: data.length,
					...this.sse(job),
					Metadata: this.metadata(job),
				}),
				signal
			);
			await this.record(job, key, initial, data.length, sha(data), signal, update);
			if (applicationEncrypted(job)) {
				capability = 'authenticated-readback';
				const cipher = ExportCipher.open(job, this.config);
				let object: any;
				try {
					object = await this.get(job, signal, undefined, key);
					let received = 0;
					for await (const bytes of cipher.decrypt(
						object.Body as Readable,
						0,
						original.length - 1,
						signal
					)) {
						if (!bytes.equals(original.subarray(received, received + bytes.length)))
							throw new TemporaryExportError('object-mismatch');
						received += bytes.length;
					}
					if (received !== original.length) throw new TemporaryExportError('object-mismatch');
				} finally {
					cipher.close();
					(object?.Body as Readable)?.destroy();
				}
				passed('application-encryption');
				passed('authenticated-readback');
			} else passed('sse-s3');
			capability = 'collision-rejection';
			await this.rejected(() =>
				this.send(
					new PutObjectCommand({
						...params,
						Body: other,
						ContentLength: other.length,
						...this.sse(job),
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
								...this.sse(job),
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
							...this.sse(job),
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
				mode: job.integrityMode!,
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
			const operations: Partial<Record<ExportCapability, ExportOperation>> = {
				'write-once-creation': 'PutObject',
				'collision-rejection': 'PutObject',
				'private-acl': 'GetObjectAcl',
				'anonymous-denial': 'GetObject',
				'conditional-range': 'GetObject',
				'multipart-completion': 'CompleteMultipartUpload',
				'concurrent-publication': 'CompleteMultipartUpload',
				'object-enumeration': 'ListObjectsV2',
				'ownership-cleanup': 'DeleteObject',
				'application-encryption': 'creation-response',
				'authenticated-readback': 'GetObject',
			};
			const diagnostic = exportDiagnostic(e, job, 'preflight', capability, operations[capability]);
			job.preflightFailure ||= diagnostic;
			job.probeFailure ||= {
				capability,
				category: diagnostic.category,
				httpStatus: diagnostic.httpStatus,
			};
			update({ probeFailure: job.probeFailure, preflightFailure: job.preflightFailure });
		}
		await this.cleanup(job, AbortSignal.timeout(30_000), update);
		passed('ownership-cleanup');
		passed('cleanup');
		job.ownedObjects = [];
		job.ownedUploads = [];
		update({ ownedObjects: [], ownedUploads: [] });
		if (failure) {
			if (failure instanceof ExportPreflightError) throw failure;
			const diagnostic = job.preflightFailure!;
			throw new ExportPreflightError(capability, diagnostic.category, diagnostic.httpStatus);
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
				throw new ExportOperationError(
					'GetBucketVersioning',
					versioning,
					'versioning-changed',
					'cleanup-pending'
				);
			return {
				versioningInspection: 'disabled' as const,
				httpStatus: exportHttpStatus(versioning),
			};
		} catch (e) {
			if (status(e) !== 501) throw e;
			return { versioningInspection: 'unsupported-api' as const, httpStatus: 501 };
		}
	}
	/** Observations only. Never records/adopts ownership, reads bodies or repairs
	 * state. Unknown/malformed replies remain explicit failures, never GO. */
	async inspect(job: ExportJob, signal: AbortSignal) {
		const observations: {
			operation: ExportOperation;
			target: 'namespace' | 'archive' | 'probe' | 'race' | 'put-race' | 'upload';
			present?: boolean;
			creationAcknowledged?: boolean;
			durableOwnershipProof?: boolean;
			metadataMatchesProof?: boolean;
			sseS3Verified?: boolean;
			etagPresent?: boolean;
			lastModifiedPresent?: boolean;
			contentLengthValid?: boolean;
			ownershipMarkersMatch?: boolean;
			versioningInspection?: 'disabled' | 'unsupported-api';
			httpStatus?: number;
			failure?: ReturnType<typeof exportDiagnostic>;
		}[] = [];
		try {
			const result = await this.unversioned(signal);
			observations.push({ operation: 'GetBucketVersioning', target: 'namespace', ...result });
		} catch (e) {
			observations.push({
				operation: 'GetBucketVersioning',
				target: 'namespace',
				failure: exportDiagnostic(e, job, 'read-only', 'versioning'),
			});
		}
		for (const [index, key] of writeOnceKeys(job).entries()) {
			const observation: (typeof observations)[number] = {
				operation: 'HeadObject',
				target: (['archive', 'probe', 'race', 'put-race'] as const)[index],
				creationAcknowledged:
					job.creationReceipts?.some(r => r.key === key && r.acknowledged) === true,
				durableOwnershipProof: job.ownedObjects?.some(p => p.key === key) === true,
			};
			try {
				const head = await this.send(new HeadObjectCommand(this.scope(job, key)), signal);
				observation.present = true;
				observation.metadataMatchesProof = this.matches(job, key, head);
				observation.sseS3Verified = head.ServerSideEncryption === 'AES256';
				observation.httpStatus = exportHttpStatus(head);
				observation.etagPresent = typeof head.ETag === 'string' && !!head.ETag;
				observation.lastModifiedPresent =
					head.LastModified instanceof Date && Number.isFinite(head.LastModified.getTime());
				observation.contentLengthValid =
					Number.isSafeInteger(head.ContentLength) && head.ContentLength >= 0;
				observation.ownershipMarkersMatch =
					this.owns(job, head) &&
					!!job.ownershipNonce &&
					head.Metadata?.['pluton-export-nonce'] === job.ownershipNonce;
				if (exportHttpStatus(head) !== 200)
					throw new ExportOperationError('HeadObject', head, 'unexpected-head-status');
			} catch (e) {
				if (absent(e)) observation.present = false;
				else observation.failure = exportDiagnostic(e, job, 'read-only', 'ownership-cleanup');
			}
			observations.push(observation);
		}
		try {
			const listing = await this.send(
				new ListMultipartUploadsCommand({
					Bucket: this.config.bucket,
					Prefix: job.key,
					MaxUploads: 100,
				}),
				signal
			);
			if (
				listing.IsTruncated ||
				listing.Uploads?.some(
					(u: any) =>
						writeOnceKeys(job).includes(u.Key) &&
						!job.ownedUploads?.some(p => p.key === u.Key && p.uploadId === u.UploadId)
				)
			)
				throw new ExportOperationError(
					'ListMultipartUploads',
					listing,
					listing.IsTruncated ? 'listing-incomplete' : 'unknown-multipart'
				);
			observations.push({
				operation: 'ListMultipartUploads',
				target: 'namespace',
				present: !!listing.Uploads?.some((u: any) => writeOnceKeys(job).includes(u.Key)),
			});
		} catch (e) {
			observations.push({
				operation: 'ListMultipartUploads',
				target: 'namespace',
				failure: exportDiagnostic(e, job, 'read-only', 'multipart-enumeration'),
			});
		}
		for (const upload of (job.ownedUploads || []).slice(0, 8)) {
			if (!writeOnceKeys(job).includes(upload.key)) continue;
			try {
				await this.send(
					new ListPartsCommand({
						...this.scope(job, upload.key),
						UploadId: upload.uploadId,
						MaxParts: 1,
					}),
					signal
				);
				observations.push({ operation: 'ListParts', target: 'upload', present: true });
			} catch (e) {
				observations.push({
					operation: 'ListParts',
					target: 'upload',
					...(absent(e)
						? { present: false }
						: {
								failure: exportDiagnostic(e, job, 'read-only', 'multipart-enumeration'),
							}),
				});
			}
		}
		return { readOnly: true as const, ownershipAdopted: false as const, observations };
	}
	async cleanup(job: ExportJob, signal: AbortSignal, update: Update = () => {}) {
		job.cleanupState = { objects: 'unverified', multipart: 'unverified' };
		try {
			await this.performCleanup(job, signal, update);
		} catch (error) {
			const diagnostic = exportDiagnostic(error, job, 'cleanup', 'cleanup');
			job.cleanupFailure ||= diagnostic;
			job.lastCleanupFailure = diagnostic;
			update({
				cleanupFailure: job.cleanupFailure,
				lastCleanupFailure: diagnostic,
				cleanupState: job.cleanupState,
			});
			throw new ExportCleanupError(diagnostic);
		}
	}
	private async performCleanup(job: ExportJob, signal: AbortSignal, update: Update) {
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
			throw new ExportOperationError(
				'ListMultipartUploads',
				pending,
				pending.IsTruncated ? 'listing-incomplete' : 'unknown-multipart',
				'cleanup-pending'
			);
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
			throw new ExportOperationError(
				'ListParts',
				undefined,
				'multipart-remains',
				'cleanup-pending'
			);
		}
		job.cleanupState!.multipart = 'verified-absent';
		update({ cleanupState: job.cleanupState });
		for (const key of keys) {
			let observed: unknown;
			try {
				observed = await this.send(new HeadObjectCommand(this.scope(job, key)), signal);
			} catch (e) {
				if (absent(e)) continue;
				throw e;
			}
			// No durable successful response proof => no adoption, even with a
			// matching public marker. A crash/lost response requires operator review.
			const proof = job.ownedObjects?.find(p => p.key === key);
			if (!proof || !job.ownershipNonce)
				throw new ExportOperationError(
					'ownership-proof',
					observed,
					'ownership-proof-missing',
					'cleanup-pending',
					exportTarget(key)
				);
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
		if (remaining.IsTruncated || remaining.Uploads?.some((u: any) => keys.includes(u.Key))) {
			job.cleanupState!.multipart = 'unverified';
			throw new ExportOperationError(
				'ListMultipartUploads',
				remaining,
				'multipart-remains',
				'cleanup-pending'
			);
		}
		await this.unversioned(signal);
		job.cleanupState = { objects: 'verified-absent', multipart: 'verified-absent' };
		update({ cleanupState: job.cleanupState });
	}
}

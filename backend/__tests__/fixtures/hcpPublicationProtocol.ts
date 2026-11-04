/** Isolated HTTP-shaped protocol reference, not HCP. Real pinned SDK parsing;
 * privacy is independently exercised by the native TLS/MinIO acceptance lab. */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { S3ExportStorage } from '../../src/utils/managedExport/S3ExportStorage';
import { exportConfiguration, type ExportJob } from '../../src/utils/managedExport/ExportPolicy';

export function hcpPublicationProtocol(
	fault = '',
	encrypted = false,
	routing: 'same-node' | 'different-nodes' = 'same-node',
	keyringSeed?: string
) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pluton-publication-'));
	const keyring = path.join(root, 'keyring.json');
	if (encrypted && keyringSeed) fs.copyFileSync(keyringSeed, keyring);
	else if (encrypted)
		fs.writeFileSync(
			keyring,
			JSON.stringify({
				version: 1,
				active: 'fixture-key',
				keys: { 'fixture-key': crypto.randomBytes(32).toString('base64') },
			}),
			{ mode: 0o600 }
		);
	const config = exportConfiguration({
		MANAGED_EXPORT_ENABLED: 'true',
		MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE: 'true',
		MANAGED_EXPORT_ENDPOINT: 'https://s3.example.internal',
		MANAGED_EXPORT_BUCKET: 'example-exports',
		MANAGED_EXPORT_ACCESS_KEY_ID: crypto.randomBytes(16).toString('hex'),
		MANAGED_EXPORT_SECRET_ACCESS_KEY: crypto.randomBytes(32).toString('hex'),
		...(encrypted
			? { MANAGED_EXPORT_MODE: 'application-encrypted-hcp', MANAGED_EXPORT_KEYRING_FILE: keyring }
			: {}),
	})!;
	const id = crypto.randomUUID();
	const job: ExportJob = {
		id,
		kind: 'preflight',
		owner: 'fixture-owner',
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
	// No network/anonymous request in this parser fixture; native acceptance keeps
	// the real anonymity/TLS gates, encryption, replica invariance and downloads.
	Object.defineProperty(storage, 'assertPrivate', { value: async () => {} });
	type ObjectValue = {
		body: Buffer;
		etag: string;
		modified: Date;
		metadata: Record<string, string>;
		sse?: string;
	};
	const objects = new Map<string, ObjectValue>();
	const uploads = new Map<
		string,
		{ key: string; metadata: Record<string, string>; sse?: string; parts: Map<number, Buffer> }
	>();
	const calls: { method: string; key: string; query: Record<string, string> }[] = [];
	const commits: { key: string; route: string; sha256: string }[] = [];
	const completionRoutes: string[] = [];
	let raceCompletions = 0,
		clock = 0;
	const putCommitted = Promise.withResolvers<void>();
	const digest = (body: Buffer) => crypto.createHash('sha256').update(body).digest('hex');
	const metadata = (headers: Record<string, string>) =>
		Object.fromEntries(
			Object.entries(headers)
				.filter(([k]) => k.startsWith('x-amz-meta-'))
				.map(([k, v]) => [k.slice(11), v])
		);
	const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
	const reply = (statusCode: number, body = '', headers: Record<string, string> = {}) => ({
		response: {
			statusCode,
			headers: { 'content-type': 'application/xml;charset=UTF-8', ...headers },
			body: Readable.from([body]),
		},
	});
	const error = (status: number, code: string) =>
		reply(status, `<Error><Code>${code}</Code><Message>private-provider-body</Message></Error>`);
	const store = (key: string, body: Buffer, meta: Record<string, string>, sse?: string) => {
		const object = {
			body,
			metadata: meta,
			sse,
			etag: '"' + digest(body) + '"',
			modified: new Date(1000 * ++clock),
		};
		objects.set(key, object);
		return object;
	};
	const handle = async (request: any) => {
		const q = request.query || {},
			key = decodeURIComponent(request.path).slice(config.bucket.length + 2);
		calls.push({ method: request.method, key, query: { ...q } });
		let object = objects.get(key);
		if ('versioning' in q) return reply(200, '<VersioningConfiguration/>');
		if ('list-type' in q)
			return reply(
				200,
				`<ListBucketResult><IsTruncated>false</IsTruncated>${[...objects]
					.filter(([k]) => k.startsWith(q.prefix))
					.map(
						([k, o]) =>
							`<Contents><Key>${xml(k)}</Key><Size>${o.body.length}</Size><ETag>${xml(o.etag)}</ETag><LastModified>${o.modified.toISOString()}</LastModified></Contents>`
					)
					.join('')}</ListBucketResult>`
			);
		if ('uploads' in q && request.method === 'GET')
			return reply(
				200,
				`<ListMultipartUploadsResult><IsTruncated>false</IsTruncated>${[...uploads]
					.filter(([, u]) => u.key.startsWith(q.prefix))
					.map(([id, u]) => `<Upload><Key>${xml(u.key)}</Key><UploadId>${id}</UploadId></Upload>`)
					.join('')}</ListMultipartUploadsResult>`
			);
		if ('uploads' in q && request.method === 'POST') {
			const uploadId = crypto.randomUUID();
			uploads.set(uploadId, {
				key,
				metadata: metadata(request.headers),
				sse: request.headers['x-amz-server-side-encryption'],
				parts: new Map(),
			});
			return reply(
				200,
				`<InitiateMultipartUploadResult><Bucket>${config.bucket}</Bucket><Key>${xml(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`
			);
		}
		if (q.uploadId) {
			const upload = uploads.get(q.uploadId);
			if (request.method === 'DELETE') {
				if (!upload) return error(404, 'NoSuchUpload');
				uploads.delete(q.uploadId);
				return reply(204);
			}
			if (!upload) return error(404, 'NoSuchUpload');
			if (request.method === 'GET') return reply(200, '<ListPartsResult/>');
			if (request.method === 'PUT') {
				upload.parts.set(Number(q.partNumber), Buffer.from(request.body));
				return reply(200, '', { etag: '"part-' + q.partNumber + '"' });
			}
			if (request.method === 'POST') {
				if (key.endsWith('.probe-put-race') && ['put-winner', 'put-lost-ack'].includes(fault)) {
					await putCommitted.promise;
					object = objects.get(key);
				}
				if (
					!/^application\/xml/.test(request.headers['content-type']) ||
					Object.keys(request.headers).some(h => h.startsWith('x-amz-meta-'))
				)
					return error(400, 'InvalidRequest');
				const racing = key.endsWith('.probe-race') || key.endsWith('.probe-put-race');
				const index = racing ? ++raceCompletions : 0;
				const route =
					racing && routing === 'different-nodes' && index % 2 === 0 ? 'node-b' : 'node-a';
				if (racing) completionRoutes.push(route);
				if (racing && index === 1 && fault === 'operation-aborted-a')
					return error(200, 'OperationAborted');
				if (racing && index === 2 && fault === 'operation-aborted-b')
					return error(200, 'OperationAborted');
				if (racing && index === 2 && fault.startsWith('race-error-'))
					return error(200, fault.slice('race-error-'.length));
				if (racing && index === 2 && fault.startsWith('competitor-'))
					return error(Number(fault.slice(11)), 'OperationAborted');
				if (racing && index === 2 && fault === 'embedded-error') return error(200, 'InvalidPart');
				if (racing && index === 2 && fault === 'second-embedded-whitespace')
					return reply(
						200,
						'<Error><Code>InvalidPart</Code><Message>private-provider-body</Message></Error> \r\n'
					);
				if (racing && index === 2 && fault === 'second-malformed')
					return reply(200, '<CompleteMultipartUploadResult><ETag>');
				if (racing && index === 2 && fault === 'second-body-reset') {
					return {
						response: {
							statusCode: 200,
							headers: { 'content-type': 'application/xml' },
							body: new Readable({
								read() {
									this.destroy(
										Object.assign(new Error('private-body-error'), { code: 'ECONNRESET' })
									);
								},
							}),
						},
					};
				}
				if (racing && index === 2 && fault === 'second-duplicate-etag')
					return reply(
						200,
						`<CompleteMultipartUploadResult><Bucket>${config.bucket}</Bucket><Key>${xml(key)}</Key><ETag>&quot;first&quot;</ETag><ETag>&quot;second&quot;</ETag></CompleteMultipartUploadResult>`
					);
				if (
					racing &&
					index === 2 &&
					(fault.startsWith('second-') || fault === 'schema-only-success')
				) {
					// This synthetic reply does not commit the second payload. It models
					// an invalid response after a different request already committed.
					const body =
						`<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2020-09-01/">` +
						(fault === 'second-missing-bucket'
							? ''
							: `<Bucket>${fault === 'second-wrong-bucket' ? 'foreign-bucket' : config.bucket}</Bucket>`) +
						(fault === 'second-missing-key'
							? ''
							: `<Key>${fault === 'second-wrong-key' ? 'foreign-key' : xml(key)}</Key>`) +
						(fault === 'second-missing-etag'
							? ''
							: `<ETag>${fault === 'second-unquoted-etag' ? 'unquoted-tag' : xml(object!.etag)}</ETag>`) +
						'</CompleteMultipartUploadResult>';
					return reply(
						200,
						body,
						fault === 'second-version' ? { 'x-amz-version-id': 'foreign-version' } : {}
					);
				}
				const nodeLocalOverwrite =
					racing && fault === 'node-local-overwrite' && routing === 'different-nodes';
				if (object && !(racing && fault === 'two-successes') && !nodeLocalOverwrite) {
					if (racing && fault === 'inconsistent-conflict') object.body[0] ^= 1;
					return error(409, 'OperationAborted');
				}
				const numbers = [...String(request.body).matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map(
					m => Number(m[1])
				);
				const body = Buffer.concat(numbers.map(n => upload.parts.get(n)!));
				const created = store(key, body, upload.metadata, upload.sse);
				if (racing) commits.push({ key, route, sha256: digest(body) });
				uploads.delete(q.uploadId);
				if (racing && fault === 'lost-ack')
					throw Object.assign(new Error('private-provider-body'), { code: 'ECONNRESET' });
				if (racing && fault === 'malformed')
					return reply(200, '<CompleteMultipartUploadResult><ETag>');
				if (racing && fault === 'empty') return reply(200);
				return reply(
					200,
					`<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2020-09-01/"><Bucket>${config.bucket}</Bucket><Key>${racing && fault === 'wrong-key' ? 'foreign-key' : xml(key)}</Key>${racing && fault === 'missing-etag' ? '' : `<ETag>${xml(created.etag)}</ETag>`}</CompleteMultipartUploadResult>`
				);
			}
		}
		if (request.method === 'HEAD' || request.method === 'GET') {
			if (!object) return error(404, 'NoSuchKey');
			if (request.headers['if-match'] && request.headers['if-match'] !== object.etag)
				return error(412, 'PreconditionFailed');
			if ('acl' in q)
				return reply(
					200,
					'<AccessControlPolicy><Owner><ID>fixture-owner</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>fixture-owner</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>'
				);
			const range = request.headers.range && /^bytes=(\d+)-(\d+)$/.exec(request.headers.range);
			const start = range ? Number(range[1]) : 0,
				end = range ? Number(range[2]) : object.body.length - 1;
			const headers = {
				'etag': object.etag,
				'last-modified': object.modified.toUTCString(),
				'content-length': String(end - start + 1),
				...(object.sse ? { 'x-amz-server-side-encryption': object.sse } : {}),
				...Object.fromEntries(
					Object.entries(object.metadata).map(([k, v]) => ['x-amz-meta-' + k, v])
				),
				...(range ? { 'content-range': `bytes ${start}-${end}/${object.body.length}` } : {}),
			};
			if (key.endsWith('.probe-race') && fault === 'head-incomplete')
				delete (headers as any)['last-modified'];
			if (key.endsWith('.probe-race') && fault === 'hash-mismatch') object.body[0] ^= 1;
			return {
				response: {
					statusCode: range ? 206 : 200,
					headers,
					body: Readable.from(
						request.method === 'HEAD' ? [] : [object.body.subarray(start, end + 1)]
					),
				},
			};
		}
		if (request.method === 'PUT') {
			if (object) return error(409, 'OperationAborted');
			const created = store(
				key,
				Buffer.from(request.body),
				metadata(request.headers),
				request.headers['x-amz-server-side-encryption']
			);
			if (key.endsWith('.probe-put-race')) {
				putCommitted.resolve();
				if (fault === 'put-lost-ack')
					throw Object.assign(new Error('private-provider-body'), { code: 'ECONNRESET' });
			}
			return reply(200, '', { etag: created.etag });
		}
		if (request.method === 'DELETE') {
			if (object && request.headers['if-match'] && request.headers['if-match'] !== object.etag)
				return error(412, 'PreconditionFailed');
			objects.delete(key);
			return reply(204);
		}
		throw new Error('Unhandled disposable protocol request');
	};
	storage.client.config.requestHandler.handle = handle;
	return {
		root,
		config,
		job,
		storage,
		objects,
		uploads,
		calls,
		commits,
		completionRoutes,
		store,
		setFault: (value: string) => {
			fault = value;
		},
		update: (fields: Partial<ExportJob>) => Object.assign(job, structuredClone(fields)),
		close: () => {
			storage.close();
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

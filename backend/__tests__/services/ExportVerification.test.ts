import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { S3ExportStorage } from '../../src/utils/managedExport/S3ExportStorage';
import { ExportCipher } from '../../src/utils/managedExport/ExportEncryption';
import {
	bindingDigest,
	exportCapabilityBinding,
	exportConfiguration,
	type ExportJob,
} from '../../src/utils/managedExport/ExportPolicy';
import {
	publicVerificationDiagnostic,
	VerificationTrace,
} from '../../src/utils/managedExport/ExportVerification';

const hash = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
jest.mock('../../src/utils/logger', () => ({ planLogger: () => ({ info: jest.fn() }) }));
function fixture(plaintextMismatch = false) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pluton-verification-'));
	const keyring = path.join(root, 'keys.json');
	fs.writeFileSync(
		keyring,
		JSON.stringify({
			version: 1,
			active: 'fixture',
			keys: { fixture: crypto.randomBytes(32).toString('base64') },
		}),
		{ mode: 0o600 }
	);
	const config = exportConfiguration({
		MANAGED_EXPORT_ENABLED: 'true',
		MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE: 'true',
		MANAGED_EXPORT_MODE: 'application-encrypted-hcp',
		MANAGED_EXPORT_KEYRING_FILE: keyring,
		MANAGED_EXPORT_ENDPOINT: 'https://storage.example.internal',
		MANAGED_EXPORT_BUCKET: 'fixture-exports',
		MANAGED_EXPORT_ACCESS_KEY_ID: crypto.randomBytes(16).toString('hex'),
		MANAGED_EXPORT_SECRET_ACCESS_KEY: crypto.randomBytes(32).toString('hex'),
	})!;
	const id = crypto.randomUUID(),
		plain = Buffer.alloc(2048, 42);
	const job = {
		id,
		kind: 'archive',
		owner: 'fixture-owner',
		key: config.prefix + '/' + id + '.tar',
		destination: config.fingerprint,
		integrityMode: 'application-encrypted-hcp',
		binding: {
			backupId: 'backup-01',
			planId: 'plan-01',
			sourceId: 'app-01',
			repositoryId: 'repository-01',
			snapshotId: 'a'.repeat(64),
			mode: 'full',
		},
		summary: {
			version: 1,
			binding: { backupId: 'backup-01', repositoryId: 'repository-01', snapshotId: 'a'.repeat(64) },
			mode: 'full',
			archiveBytes: plain.length,
			archiveSha256: hash(plain),
			manifestSha256: 'b'.repeat(64),
			includedEntries: 1,
			excludedEntries: 0,
			includedByType: { file: 1 },
			excludedByType: {},
		},
		createdAt: Date.now(),
		updatedAt: Date.now(),
		state: 'verifying',
		cleaned: false,
		cleanupAttempts: 0,
		uploadedBytes: plain.length,
		processedBytes: plain.length,
		reservedBytes: plain.length,
	} as ExportJob;
	const cipher = ExportCipher.create(job, config, plain.length, hash(plain)),
		encrypted = cipher.seal(0, plaintextMismatch ? Buffer.alloc(plain.length, 43) : plain);
	job.encryption = cipher.value;
	job.encryption.ciphertextSha256 = hash(encrypted);
	cipher.close();
	job.ownershipNonce = crypto.randomBytes(32).toString('hex');
	job.capabilityBinding = exportCapabilityBinding(config);
	job.etag = '"fixture-etag"';
	job.ownedObjects = [
		{
			key: job.key,
			etag: job.etag,
			bytes: encrypted.length,
			sha256: hash(encrypted),
			created: new Date(1000).toISOString(),
		},
	];
	job.identity = {
		mode: 'application-encrypted-hcp',
		...job.ownedObjects[0],
		binding: bindingDigest(job.binding),
		capability: job.capabilityBinding,
	};
	const storage = new S3ExportStorage(config),
		calls: { method: string; range: boolean; conditional: boolean }[] = [];
	const privacy = jest.spyOn(storage as any, 'assertAnonymousDenied').mockResolvedValue(undefined);
	let fault = '';
	const handler = jest.spyOn(storage.client.config.requestHandler, 'handle') as jest.Mock;
	handler.mockImplementation(async (request: any, options: any) => {
		const head = request.method === 'HEAD';
		calls.push({
			method: request.method,
			range: request.headers.range === 'bytes=0-2063',
			conditional: request.headers['if-match'] === job.etag,
		});
		if (!head && fault === 'reset-once-frame' && calls.filter(c => c.method === 'GET').length === 1)
			throw Object.assign(new Error('captured-reset'), { code: 'ECONNRESET' });
		if (!head && fault === 'sdk-parser')
			throw Object.assign(new Error('captured-invalid-xml'), {
				$response: { statusCode: 200, body: 'captured-provider-body' },
			});
		if ((head && fault === 'head-reset') || (!head && fault === 'get-reset'))
			throw Object.assign(new Error('captured-provider-content'), { code: 'ECONNRESET' });
		if (head && fault === 'timeout')
			throw Object.assign(new Error('captured-private-url'), {
				name: 'TimeoutError',
				code: 'ETIMEDOUT',
			});
		if (head && fault === 'abort')
			return new Promise((_resolve, reject) =>
				options.abortSignal.addEventListener(
					'abort',
					() => reject(Object.assign(new Error('captured-abort'), { name: 'AbortError' })),
					{ once: true }
				)
			);
		const status =
			(head && fault === 'head-403') || (!head && fault === 'get-403')
				? 403
				: !head && fault === 'get-412'
					? 412
					: !head && fault === 'get-501'
						? 501
						: head || fault === 'range-200'
							? 200
							: 206;
		const headers: Record<string, string> = {
			'content-length': String(encrypted.length),
			'etag': fault === 'etag' ? '"changed"' : job.etag!,
			'last-modified': new Date(1000).toUTCString(),
			'x-amz-meta-pluton-export-job': job.id,
			'x-amz-meta-pluton-export-binding': bindingDigest(job.binding),
			'x-amz-meta-pluton-export-nonce': job.ownershipNonce!,
			'x-amz-meta-pluton-export-format': 'aead-v1',
			'x-amz-meta-pluton-export-manifest': job.encryption!.mac,
			'x-amz-meta-pluton-export-purpose': fault === 'metadata' ? 'foreign' : 'archive',
		};
		if (!head)
			headers['content-range'] =
				fault === 'range-mismatch' ? 'bytes 1-2063/2064' : 'bytes 0-2063/2064';
		let data = Buffer.from(encrypted);
		if (fault === 'frame' || fault === 'reset-once-frame') data[0] ^= 1;
		if (fault === 'truncated') data = data.subarray(0, -1);
		const body =
			!head && fault === 'body-reset'
				? Readable.from(
						(async function* () {
							yield data.subarray(0, 512);
							throw Object.assign(new Error('captured-private-object'), { code: 'ECONNRESET' });
						})()
					)
				: Readable.from([
						status >= 400
							? Buffer.from(
									'<Error><Code>' +
										(status === 501
											? 'NotImplemented'
											: status === 412
												? 'PreconditionFailed'
												: 'AccessDenied') +
										'</Code><Message>captured-provider-content</Message></Error>'
								)
							: head
								? Buffer.alloc(0)
								: data,
					]);
		return { response: { statusCode: status, headers, body } };
	});
	return {
		root,
		encrypted,
		keyring,
		storage,
		job,
		calls,
		privacy,
		fault: (v: string) => {
			fault = v;
		},
		close: () => {
			storage.close();
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}
test.each([
	['head-403', 'head', 'HeadObject', 'provider', 403, 'access-denied'],
	['get-403', 'get-headers', 'GetObject', 'provider', 403, 'access-denied'],
	['get-412', 'get-headers', 'GetObject', 'identity-integrity', 412, 'precondition-failed'],
	['get-501', 'get-headers', 'GetObject', 'provider', 501, 'unsupported-api'],
	['head-reset', 'head', 'HeadObject', 'transport', undefined, 'network'],
	['get-reset', 'get-headers', 'GetObject', 'transport', undefined, 'network'],
	['timeout', 'head', 'HeadObject', 'transport', undefined, 'deadline'],
	['etag', 'head', 'HeadObject', 'identity-integrity', 200, 'invalid-response'],
	['metadata', 'identity', 'ObjectIdentity', 'identity-integrity', 200, 'invalid-response'],
	['range-200', 'get-headers', 'GetObject', 'identity-integrity', 200, 'invalid-response'],
	['range-mismatch', 'get-headers', 'GetObject', 'identity-integrity', 206, 'invalid-response'],
	['truncated', 'ciphertext-body', 'GetObject', 'identity-integrity', 206, 'invalid-response'],
	['frame', 'decrypt', 'GetObject', 'identity-integrity', 206, 'invalid-response'],
	['body-reset', 'ciphertext-body', 'GetObject', 'transport', 206, 'network'],
])(
	'real SDK verification fixture %s fails closed with safe operation/body classification',
	async (fault, phase, operation, outcome, httpStatus, providerCategory) => {
		const f = fixture();
		f.fault(fault as string);
		try {
			await expect(f.storage.verify(f.job, AbortSignal.timeout(5000))).rejects.toMatchObject({
				diagnostic: {
					phase,
					operation,
					outcome,
					httpStatus,
					providerCategory,
					elapsedMs: expect.any(Number),
				},
			});
			let diagnostic: any;
			try {
				await f.storage.verify(f.job, AbortSignal.timeout(5000));
			} catch (e: any) {
				diagnostic = e.diagnostic;
			}
			expect(JSON.stringify(diagnostic)).not.toMatch(
				/captured|fixture-etag|storage\.example|pluton-temporary/
			);
			expect(JSON.stringify(diagnostic)).not.toContain(f.job.key);
			if (fault === 'head-reset' || fault === 'get-reset') expect(diagnostic.attempts).toBe(2);
			if (fault === 'body-reset') expect(diagnostic.wireBytesRead).toBe(512);
			expect(f.job.state).toBe('verifying'); // verification never publishes Ready itself
		} finally {
			f.close();
		}
	}
);
test('valid encrypted full readback uses strict ciphertext Range and retains successful privacy checks', async () => {
	const f = fixture();
	try {
		await f.storage.verify(f.job, AbortSignal.timeout(5000));
		expect(f.calls).toEqual([
			{ method: 'HEAD', range: false, conditional: true },
			{ method: 'GET', range: true, conditional: true },
		]);
		expect(f.privacy).toHaveBeenCalledTimes(4);
		const cipher = ExportCipher.open(f.job, f.storage.config);
		try {
			const bytes: Buffer[] = [];
			for await (const chunk of cipher.decrypt(Readable.from([f.encrypted]), 0, 2047, AbortSignal.timeout(5000), () => { throw new Error('diagnostic consumer unavailable'); }))
				bytes.push(chunk);
			expect(hash(Buffer.concat(bytes))).toBe(f.job.summary!.archiveSha256);
		} finally { cipher.close(); }
	} finally {
		f.close();
	}
});
test('successful read retry retains actual attempts and wire status when later authentication fails', async () => {
	const f = fixture();
	f.fault('reset-once-frame');
	try {
		await expect(f.storage.verify(f.job, AbortSignal.timeout(5000))).rejects.toMatchObject({
			diagnostic: {
				phase: 'decrypt',
				httpStatus: 206,
				attempts: 2,
				outcome: 'identity-integrity',
				wireBytesRead: 2064,
			},
		});
	} finally {
		f.close();
	}
});
test('SDK parsing failure retains only wire HTTP status and parser classification, never XML attachments', async () => {
	const f = fixture();
	f.fault('sdk-parser');
	try {
		let failure: any;
		try {
			await f.storage.verify(f.job, AbortSignal.timeout(5000));
		} catch (error) {
			failure = error;
		}
		expect(failure.diagnostic).toMatchObject({
			operation: 'GetObject',
			phase: 'get-headers',
			responseKind: 'sdk-parsing-error',
			httpStatus: 200,
			providerCategory: 'invalid-response',
			attempts: 1,
		});
		expect(JSON.stringify(failure)).not.toMatch(/captured|\$response/);
	} finally {
		f.close();
	}
});
test('authenticated frames cannot bypass the complete plaintext SHA-256 proof', async () => {
	const f = fixture(true);
	try {
		await expect(f.storage.verify(f.job, AbortSignal.timeout(5000))).rejects.toMatchObject({
			reason: 'object-mismatch',
			diagnostic: {
				phase: 'plaintext-sha256',
				operation: 'PlaintextSha256',
				outcome: 'identity-integrity',
				bodyComplete: true,
				plaintextBytesRead: 2048,
				wireBytesRead: 2064,
				httpStatus: 206,
			},
		});
	} finally {
		f.close();
	}
});
test('verification abort and keyring/manifest failures remain distinguishable and bounded', async () => {
	const f = fixture();
	try {
		f.fault('abort');
		const controller = new AbortController();
		const check = f.storage.verify(f.job, controller.signal);
		const expected = expect(check).rejects.toMatchObject({
			diagnostic: { abortReason: 'deadline', phase: 'head' },
		});
		setImmediate(() => controller.abort(new DOMException('fixture', 'TimeoutError')));
		await expected;
		fs.writeFileSync(f.keyring, '{}');
		await expect(f.storage.verify(f.job, AbortSignal.timeout(5000))).rejects.toMatchObject({
			reason: 'encryption-key-unavailable',
			diagnostic: { phase: 'keyring-manifest', outcome: 'keyring' },
		});
	} finally {
		f.close();
	}
});
test('privacy failures identify exact anonymous operation without retaining URL or response contents', async () => {
	const f = fixture();
	try {
		f.privacy.mockRejectedValueOnce(
			Object.assign(new Error('captured-private-url'), { code: 'ETIMEDOUT' })
		);
		await expect(f.storage.verify(f.job, AbortSignal.timeout(5000))).rejects.toMatchObject({
			diagnostic: {
				phase: 'privacy-object',
				operation: 'AnonymousObjectGet',
				outcome: 'transport',
				providerCategory: 'deadline',
			},
		});
	} finally {
		f.close();
	}
});
test('public projection rejects untrusted fields and a diagnostic consumer cannot grant ownership', () => {
	const trace = new VerificationTrace(new AbortController().signal);
	const d = trace.fail(Object.assign(new Error('captured'), { code: 'ECONNRESET' })).diagnostic;
	expect(
		publicVerificationDiagnostic({
			...d,
			elapsedMs: Infinity,
			wireBytesRead: -1,
			providerCode: 'captured',
			responseKind: 'captured',
			secret: 'private',
		} as any)
	).toMatchObject({
		elapsedMs: 0,
		wireBytesRead: 0,
		providerCode: 'unrecognized',
		responseKind: 'invalid-response',
	});
	expect(JSON.stringify(d)).not.toContain('captured');
});

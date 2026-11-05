import crypto from 'crypto';
import { PassThrough, Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { z } from 'zod';
import { ExportKeyError, ExportKeyring } from './ExportKeyring';
import {
	bindingDigest,
	EXPORT_LIMITS,
	TemporaryExportError,
	type ExportJob,
	type ExportConfig,
} from './ExportPolicy';
import type { ManagedArchiveDownload } from '../../services/RemoteRepositoryRecoveryService';

export const EXPORT_CHUNK_BYTES = 4 * 1024 ** 2;
const TAG_BYTES = 16;
const hex = (bytes: number) => z.string().regex(new RegExp(`^[a-f0-9]{${bytes * 2}}$`));
const manifestSchema = z.strictObject({
	version: z.literal(1),
	algorithm: z.literal('AES-256-GCM-HKDF-SHA256'),
	chunkBytes: z.literal(EXPORT_CHUNK_BYTES),
	plaintextBytes: z.number().int().positive().max(EXPORT_LIMITS.maxObjectBytes),
	ciphertextBytes: z.number().int().positive(),
	plaintextSha256: hex(32),
	noncePrefix: hex(8),
	salt: hex(32),
	context: hex(32),
});
const envelopeSchema = z.strictObject({
	keyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
	iv: hex(12),
	data: hex(32),
	tag: hex(16),
});
export const encryptionSchema = z.strictObject({
	manifest: manifestSchema,
	envelope: envelopeSchema,
	mac: hex(32),
	ciphertextSha256: hex(32).optional(),
});
export type ExportEncryption = z.infer<typeof encryptionSchema>;
const fail = () => new TemporaryExportError('object-mismatch');
const hash = (value: Buffer | string) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (m: ExportEncryption['manifest']) =>
	JSON.stringify([
		m.version,
		m.algorithm,
		m.chunkBytes,
		m.plaintextBytes,
		m.ciphertextBytes,
		m.plaintextSha256,
		m.noncePrefix,
		m.salt,
		m.context,
	]);
const context = (job: ExportJob) =>
	hash(
		JSON.stringify([
			'pluton-export-aead-v1',
			job.id,
			job.owner,
			job.destination,
			job.key,
			bindingDigest(job.binding),
		])
	);
export const encryptedBytes = (n: number) => n + Math.ceil(n / EXPORT_CHUNK_BYTES) * TAG_BYTES;
export const storedExportBytes = (job: ExportJob) =>
	job.encryption?.manifest.ciphertextBytes ?? job.summary?.archiveBytes;
export const storedExportSha = (job: ExportJob) =>
	job.encryption?.ciphertextSha256 ?? job.summary?.archiveSha256;
export const isWriteOnce = (mode: unknown) =>
	mode === 'hcp-write-once' || mode === 'application-encrypted-hcp';
export const applicationEncrypted = (job: ExportJob) =>
	job.integrityMode === 'application-encrypted-hcp';

/** Standard Node/OpenSSL AEAD and HKDF primitives. The versioned framing format
 * uses one derived key per frame and a 96-bit nonce (random prefix + uint32 index).
 * A whole frame is buffered/authenticated before any plaintext from it is yielded. */
export class ExportCipher {
	private closed = false;
	private constructor(
		readonly value: ExportEncryption,
		private readonly root: Buffer
	) {}
	static create(job: ExportJob, config: ExportConfig, bytes: number, sha256: string) {
		const ring = new ExportKeyring(config.keyringFile);
		const root = crypto.randomBytes(32);
		try {
			if (!config.keyringBinding || ring.fingerprint() !== config.keyringBinding)
				throw new ExportKeyError();
			const manifest: ExportEncryption['manifest'] = {
				version: 1,
				algorithm: 'AES-256-GCM-HKDF-SHA256',
				chunkBytes: EXPORT_CHUNK_BYTES,
				plaintextBytes: bytes,
				ciphertextBytes: encryptedBytes(bytes),
				plaintextSha256: sha256,
				noncePrefix: crypto.randomBytes(8).toString('hex'),
				salt: crypto.randomBytes(32).toString('hex'),
				context: context(job),
			};
			manifestSchema.parse(manifest);
			const iv = crypto.randomBytes(12);
			const wrap = crypto.createCipheriv('aes-256-gcm', ring.key(), iv, {
				authTagLength: TAG_BYTES,
			});
			wrap.setAAD(Buffer.from('pluton-wrap-v1:' + canonical(manifest)));
			const data = Buffer.concat([wrap.update(root), wrap.final()]);
			const envelope = {
				keyId: ring.active,
				iv: iv.toString('hex'),
				data: data.toString('hex'),
				tag: wrap.getAuthTag().toString('hex'),
			};
			const cipher = new ExportCipher({ manifest, envelope, mac: '' }, root);
			cipher.value.mac = cipher.mac();
			return cipher;
		} catch (error) {
			root.fill(0);
			if (error instanceof ExportKeyError) throw error;
			throw fail();
		} finally {
			ring.close();
		}
	}
	static open(job: ExportJob, config: ExportConfig) {
		let root: Buffer | undefined;
		const ring = new ExportKeyring(config.keyringFile);
		try {
			const value = encryptionSchema.parse(job.encryption),
				m = value.manifest;
			if (
				m.context !== context(job) ||
				m.ciphertextBytes !== encryptedBytes(m.plaintextBytes) ||
				(job.summary &&
					(m.plaintextBytes !== job.summary.archiveBytes ||
						m.plaintextSha256 !== job.summary.archiveSha256))
			)
				throw fail();
			const e = value.envelope;
			const unwrap = crypto.createDecipheriv(
				'aes-256-gcm',
				ring.key(e.keyId),
				Buffer.from(e.iv, 'hex'),
				{ authTagLength: TAG_BYTES }
			);
			unwrap.setAAD(Buffer.from('pluton-wrap-v1:' + canonical(m)));
			unwrap.setAuthTag(Buffer.from(e.tag, 'hex'));
			const pending = unwrap.update(Buffer.from(e.data, 'hex'));
			try {
				root = Buffer.concat([pending, unwrap.final()]);
			} finally {
				pending.fill(0);
			}
			const cipher = new ExportCipher(value, root);
			if (!crypto.timingSafeEqual(Buffer.from(value.mac, 'hex'), Buffer.from(cipher.mac(), 'hex')))
				throw fail();
			return cipher;
		} catch (error) {
			root?.fill(0);
			if (error instanceof ExportKeyError) throw error;
			throw new TemporaryExportError('encryption-metadata-invalid');
		} finally {
			ring.close();
		}
	}
	private derive(label: string) {
		if (this.closed) throw fail();
		return Buffer.from(
			crypto.hkdfSync(
				'sha256',
				this.root,
				Buffer.from(this.value.manifest.salt, 'hex'),
				Buffer.from(label),
				32
			)
		);
	}
	private mac() {
		const key = this.derive('pluton-export-manifest-v1');
		const e = this.value.envelope;
		try {
			return crypto
				.createHmac('sha256', key)
				.update(JSON.stringify([canonical(this.value.manifest), [e.keyId, e.iv, e.data, e.tag]]))
				.digest('hex');
		} finally {
			key.fill(0);
		}
	}
	private frame(index: number) {
		const m = this.value.manifest,
			count = Math.ceil(m.plaintextBytes / m.chunkBytes);
		if (!Number.isSafeInteger(index) || index < 0 || index >= count || index >= 2 ** 32)
			throw fail();
		const bytes = Math.min(m.chunkBytes, m.plaintextBytes - index * m.chunkBytes);
		const iv = Buffer.alloc(12);
		Buffer.from(m.noncePrefix, 'hex').copy(iv);
		iv.writeUInt32BE(index, 8);
		return {
			key: this.derive('pluton-export-frame-v1:' + index),
			iv,
			bytes,
			aad: Buffer.from(
				JSON.stringify(['pluton-export-frame-v1', hash(canonical(m)), index, bytes])
			),
		};
	}
	seal(index: number, plain: Buffer) {
		const f = this.frame(index);
		try {
			if (plain.length !== f.bytes) throw fail();
			const cipher = crypto.createCipheriv('aes-256-gcm', f.key, f.iv, {
				authTagLength: TAG_BYTES,
			});
			cipher.setAAD(f.aad);
			return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
		} finally {
			f.key.fill(0);
		}
	}
	private unseal(index: number, encrypted: Buffer) {
		const f = this.frame(index);
		let pending: Buffer | undefined;
		try {
			if (encrypted.length !== f.bytes + TAG_BYTES) throw fail();
			const cipher = crypto.createDecipheriv('aes-256-gcm', f.key, f.iv, {
				authTagLength: TAG_BYTES,
			});
			cipher.setAAD(f.aad);
			cipher.setAuthTag(encrypted.subarray(f.bytes));
			pending = cipher.update(encrypted.subarray(0, f.bytes));
			const result = Buffer.concat([pending, cipher.final()]);
			return result;
		} catch {
			throw fail();
		} finally {
			pending?.fill(0);
			f.key.fill(0);
		}
	}
	range(start: number, end: number) {
		const m = this.value.manifest;
		if (
			![start, end].every(Number.isSafeInteger) ||
			start < 0 ||
			end < start ||
			end >= m.plaintextBytes
		)
			throw fail();
		const first = Math.floor(start / m.chunkBytes),
			last = Math.floor(end / m.chunkBytes);
		return {
			first,
			last,
			start: first * (m.chunkBytes + TAG_BYTES),
			end: Math.min(m.ciphertextBytes, (last + 1) * (m.chunkBytes + TAG_BYTES)) - 1,
		};
	}
	async *decrypt(
		source: Readable,
		start: number,
		end: number,
		signal: AbortSignal,
		observe?: (phase: 'ciphertext-body' | 'decrypt', bytes?: number, complete?: boolean) => void
	) {
		const report = (phase: 'ciphertext-body' | 'decrypt', bytes?: number, complete?: boolean) => {
			try {
				observe?.(phase, bytes, complete);
			} catch {
				/* Diagnostics cannot change authentication or stream behavior. */
			}
		};
		const selection = this.range(start, end),
			m = this.value.manifest;
		const frame = Buffer.allocUnsafe(m.chunkBytes + TAG_BYTES);
		let index = selection.first,
			used = 0;
		try {
			report('ciphertext-body');
			for await (const chunk of source) {
				signal.throwIfAborted();
				report('decrypt', Buffer.isBuffer(chunk) ? chunk.length : 0);
				if (!Buffer.isBuffer(chunk)) throw fail();
				let offset = 0;
				while (offset < chunk.length) {
					if (index > selection.last) throw fail();
					const needed =
						Math.min(m.chunkBytes, m.plaintextBytes - index * m.chunkBytes) + TAG_BYTES;
					const n = Math.min(needed - used, chunk.length - offset);
					chunk.copy(frame, used, offset, offset + n);
					offset += n;
					used += n;
					if (used === needed) {
						const plain = this.unseal(index, frame.subarray(0, used));
						const lower = Math.max(0, start - index * m.chunkBytes),
							upper = Math.min(plain.length, end - index * m.chunkBytes + 1);
						// Yield an independent authenticated slice; wipe the full temporary frame.
						try {
							yield Buffer.from(plain.subarray(lower, upper));
						} finally {
							plain.fill(0);
						}
						index++;
						used = 0;
					}
				}
				report('ciphertext-body');
			}
			report('ciphertext-body', undefined, true);
			if (used || index !== selection.last + 1) throw fail();
		} finally {
			frame.fill(0);
			source.destroy();
		}
	}
	archive(
		original: ManagedArchiveDownload,
		completed: (sha: string) => void
	): ManagedArchiveDownload {
		const seal = (index: number, plain: Buffer) => this.seal(index, plain);
		const m = this.value.manifest;
		const summary = {
			...original.export,
			archiveBytes: m.ciphertextBytes,
			archiveSha256: '0'.repeat(64),
		};
		return {
			...original,
			export: summary,
			async streamTo(destination, signal, ready) {
				const input = new PassThrough({ highWaterMark: 64 * 1024 });
				const ciphertext = crypto.createHash('sha256'),
					plaintext = crypto.createHash('sha256');
				async function* encrypt() {
					const buffer = Buffer.allocUnsafe(m.chunkBytes);
					let used = 0,
						bytes = 0,
						index = 0;
					try {
						for await (const chunk of input) {
							signal.throwIfAborted();
							plaintext.update(chunk);
							bytes += chunk.length;
							if (bytes > m.plaintextBytes) throw fail();
							let offset = 0;
							while (offset < chunk.length) {
								const n = Math.min(buffer.length - used, chunk.length - offset);
								chunk.copy(buffer, used, offset, offset + n);
								offset += n;
								used += n;
								if (used === buffer.length) {
									const frame = seal(index++, buffer);
									ciphertext.update(frame);
									yield frame;
									used = 0;
								}
							}
						}
						if (bytes !== m.plaintextBytes || plaintext.digest('hex') !== m.plaintextSha256)
							throw fail();
						if (used) {
							const frame = seal(index++, buffer.subarray(0, used));
							ciphertext.update(frame);
							yield frame;
						}
						summary.archiveSha256 = ciphertext.digest('hex');
						completed(summary.archiveSha256);
					} finally {
						buffer.fill(0);
					}
				}
				let failure: unknown;
				const transfer = pipeline(
					Readable.from(encrypt(), { objectMode: false, highWaterMark: 64 * 1024 }),
					destination,
					{
						end: false,
						signal,
					}
				).catch(e => {
					failure = e;
					input.destroy(e);
				});
				try {
					await original.streamTo(input, signal, ready);
					input.end();
					await transfer;
					if (failure) throw failure;
				} catch (e) {
					input.destroy();
					await transfer;
					throw e;
				}
			},
		};
	}
	close() {
		this.root.fill(0);
		this.closed = true;
	}
}

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import {
	ExportCipher,
	EXPORT_CHUNK_BYTES,
	encryptedBytes,
} from '../../src/utils/managedExport/ExportEncryption';
import { ExportKeyError, ExportKeyring } from '../../src/utils/managedExport/ExportKeyring';
import { exportConfiguration, type ExportJob } from '../../src/utils/managedExport/ExportPolicy';

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pluton-aead-'));
	const file = path.join(root, 'keyring.json'),
		secret = crypto.randomBytes(32).toString('base64');
	const keys = {
		version: 1,
		active: 'slot-a',
		keys: { 'slot-a': secret } as Record<string, string>,
	};
	fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
	const config = exportConfiguration({
		MANAGED_EXPORT_ENABLED: 'true',
		MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE: 'true',
		MANAGED_EXPORT_MODE: 'application-encrypted-hcp',
		MANAGED_EXPORT_KEYRING_FILE: file,
		MANAGED_EXPORT_ENDPOINT: 'https://s3.example.internal',
		MANAGED_EXPORT_BUCKET: 'example-exports',
		MANAGED_EXPORT_ACCESS_KEY_ID: crypto.randomBytes(12).toString('hex'),
		MANAGED_EXPORT_SECRET_ACCESS_KEY: crypto.randomBytes(32).toString('hex'),
	})!;
	const id = crypto.randomUUID();
	const job = {
		id,
		owner: 'fixture-owner',
		destination: config.fingerprint,
		key: `${config.prefix}/${id}.tar`,
		integrityMode: 'application-encrypted-hcp',
		binding: {
			backupId: 'backup-01',
			planId: 'plan-01',
			sourceId: 'app-01',
			repositoryId: 'repository-01',
			snapshotId: 'a'.repeat(64),
			mode: 'full',
		},
	} as ExportJob;
	return {
		root,
		file,
		config,
		job,
		keys,
		secret,
		close: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}
async function encode(f: ReturnType<typeof fixture>, plain: Buffer) {
	f.job.summary = { archiveBytes: plain.length, archiveSha256: sha(plain) } as any;
	const cipher = ExportCipher.create(f.job, f.config, plain.length, sha(plain));
	f.job.encryption = cipher.value;
	const archive = {
		export: f.job.summary,
		streamTo: async (dest: Writable, signal: AbortSignal) =>
			pipeline(Readable.from([plain]), dest, { end: false, signal }),
	} as any;
	const chunks: Buffer[] = [];
	try {
		await cipher
			.archive(archive, sha => {
				f.job.encryption!.ciphertextSha256 = sha;
			})
			.streamTo(
				new Writable({
					write(chunk, _e, done) {
						chunks.push(Buffer.from(chunk));
						done();
					},
				}),
				AbortSignal.timeout(5000),
				() => {}
			);
		return Buffer.concat(chunks);
	} finally {
		cipher.close();
	}
}
async function decode(
	f: ReturnType<typeof fixture>,
	bytes: Buffer,
	start = 0,
	end = f.job.encryption!.manifest.plaintextBytes - 1
) {
	const cipher = ExportCipher.open(f.job, f.config),
		range = cipher.range(start, end),
		chunks: Buffer[] = [];
	try {
		for await (const chunk of cipher.decrypt(
			Readable.from([bytes.subarray(range.start, range.end + 1)]),
			start,
			end,
			AbortSignal.timeout(5000)
		))
			chunks.push(chunk);
		return Buffer.concat(chunks);
	} finally {
		cipher.close();
	}
}

describe('application export authenticated framing', () => {
	test('encryption mode and keyring are explicit configuration gates; auto never silently selects application encryption', () => {
		const f = fixture();
		const env = {
			MANAGED_EXPORT_ENABLED: 'true',
			MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE: 'true',
			MANAGED_EXPORT_ENDPOINT: f.config.endpoint,
			MANAGED_EXPORT_BUCKET: f.config.bucket,
			MANAGED_EXPORT_ACCESS_KEY_ID: f.config.accessKeyId,
			MANAGED_EXPORT_SECRET_ACCESS_KEY: f.config.secretAccessKey,
		};
		try {
			expect(exportConfiguration(env)?.exportMode).toBeUndefined();
			for (const override of [
				{ MANAGED_EXPORT_MODE: 'unknown' },
				{ MANAGED_EXPORT_MODE: 'application-encrypted-hcp' },
				{
					MANAGED_EXPORT_MODE: 'application-encrypted-hcp',
					MANAGED_EXPORT_KEYRING_FILE: f.file,
					MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE: 'false',
				},
			])
				expect(() => exportConfiguration({ ...env, ...override })).toThrow('configuration-invalid');
		} finally {
			f.close();
		}
	});
	test('streaming multichunk roundtrip and arbitrary plaintext ranges return exact original bytes', async () => {
		const f = fixture();
		try {
			const plain = crypto.randomBytes(EXPORT_CHUNK_BYTES * 2 + 513),
				bytes = await encode(f, plain);
			expect(bytes.length).toBe(encryptedBytes(plain.length));
			expect((await decode(f, bytes)).equals(plain)).toBe(true);
			for (const [start, end] of [
				[0, 0],
				[15, 100],
				[EXPORT_CHUNK_BYTES - 3, EXPORT_CHUNK_BYTES + 3],
				[EXPORT_CHUNK_BYTES, plain.length - 1],
				[plain.length - 1, plain.length - 1],
			])
				expect((await decode(f, bytes, start, end)).equals(plain.subarray(start, end + 1))).toBe(
					true
				);
			expect(JSON.stringify(f.job.encryption).includes(f.secret)).toBe(false);
			expect(bytes.includes(plain.subarray(0, 256))).toBe(false);
		} finally {
			f.close();
		}
	});
	test.each(['tag', 'ciphertext', 'reorder', 'omit', 'truncate'])(
		'fails authentication/shape without releasing the damaged frame: %s',
		async fault => {
			const f = fixture();
			try {
				let bytes = await encode(f, crypto.randomBytes(EXPORT_CHUNK_BYTES + 512));
				const frame = EXPORT_CHUNK_BYTES + 16;
				if (fault === 'tag') bytes[frame - 1] ^= 1;
				if (fault === 'ciphertext') bytes[10] ^= 1;
				if (fault === 'reorder')
					bytes = Buffer.concat([bytes.subarray(frame), bytes.subarray(0, frame)]);
				if (fault === 'omit') bytes = bytes.subarray(frame);
				if (fault === 'truncate') bytes = bytes.subarray(0, bytes.length - 1);
				await expect(decode(f, bytes)).rejects.toThrow('object-mismatch');
			} finally {
				f.close();
			}
		}
	);
	test('a bad first chunk yields no unauthenticated plaintext', async () => {
		const f = fixture();
		try {
			const bytes = await encode(f, Buffer.alloc(512));
			bytes[bytes.length - 1] ^= 1;
			const cipher = ExportCipher.open(f.job, f.config),
				chunks: Buffer[] = [];
			try {
				await expect(
					(async () => {
						for await (const b of cipher.decrypt(
							Readable.from([bytes]),
							0,
							511,
							new AbortController().signal
						))
							chunks.push(b);
					})()
				).rejects.toThrow();
			} finally {
				cipher.close();
			}
			expect(chunks).toHaveLength(0);
		} finally {
			f.close();
		}
	});
	test.each([
		'plaintextBytes',
		'ciphertextBytes',
		'plaintextSha256',
		'noncePrefix',
		'salt',
		'context',
		'chunkBytes',
		'version',
		'algorithm',
		'mac',
		'envelope',
		'job',
		'owner',
		'binding',
	])('manifest, envelope and immutable identity tampering fails closed: %s', async field => {
		const f = fixture();
		try {
			await encode(f, Buffer.alloc(512));
			const value = f.job.encryption!;
			if (field === 'mac') value.mac = '0'.repeat(64);
			else if (field === 'envelope') value.envelope.tag = '0'.repeat(32);
			else if (field === 'job') f.job.id = crypto.randomUUID();
			else if (field === 'owner') f.job.owner = 'other-owner';
			else if (field === 'binding') f.job.binding.snapshotId = 'b'.repeat(64);
			else
				(value.manifest as any)[field] =
					typeof (value.manifest as any)[field] === 'number' ? 2 : '0'.repeat(64);
			expect(() => ExportCipher.open(f.job, f.config)).toThrow('encryption-metadata-invalid');
		} finally {
			f.close();
		}
	});
	test('wrong/retired keys fail; retaining old slots during rotation recovers a live export after restart', async () => {
		const f = fixture();
		try {
			const plain = crypto.randomBytes(512),
				bytes = await encode(f, plain);
			const original = f.keys.keys['slot-a'];
			f.keys.keys['slot-a'] = crypto.randomBytes(32).toString('base64');
			fs.writeFileSync(f.file, JSON.stringify(f.keys));
			expect(() => ExportCipher.open(f.job, f.config)).toThrow();
			f.keys.keys['slot-a'] = original;
			f.keys.active = 'slot-b';
			f.keys.keys['slot-b'] = crypto.randomBytes(32).toString('base64');
			fs.writeFileSync(f.file, JSON.stringify(f.keys));
			f.job = JSON.parse(JSON.stringify(f.job));
			expect((await decode(f, bytes)).equals(plain)).toBe(true);
			expect(() => ExportCipher.create(f.job, f.config, plain.length, sha(plain))).toThrow(
				'encryption-key-unavailable'
			);
			delete f.keys.keys['slot-a'];
			fs.writeFileSync(f.file, JSON.stringify(f.keys));
			expect(() => ExportCipher.open(f.job, f.config)).toThrow();
		} finally {
			f.close();
		}
	});
	test('independent export material, authenticated truncation and overflow bounds cover 20–80 GiB layouts', () => {
		const f = fixture();
		try {
			const a = ExportCipher.create(f.job, f.config, 80 * 1024 ** 3, 'a'.repeat(64)),
				b = ExportCipher.create(f.job, f.config, 80 * 1024 ** 3, 'a'.repeat(64));
			try {
				expect(a.value.manifest.noncePrefix).not.toBe(b.value.manifest.noncePrefix);
				expect(a.value.envelope.data).not.toBe(b.value.envelope.data);
				for (const size of [20, 80]) {
					const n = size * 1024 ** 3,
						r = a.range(n - 2, n - 1);
					expect(r.end).toBe(encryptedBytes(n) - 1);
					expect(r.end - r.start + 1).toBe(EXPORT_CHUNK_BYTES + 16);
				}
				expect(() => a.range(-1, 0)).toThrow();
				expect(() => a.range(0, 80 * 1024 ** 3)).toThrow();
			} finally {
				a.close();
				b.close();
			}
		} finally {
			f.close();
		}
	});
	test('keyring refuses insecure, malformed, missing and symlink inputs without disclosing contents', () => {
		const f = fixture();
		try {
			expect(() => new ExportKeyring('relative.json')).toThrow('encryption-key-unavailable');
			expect(() => new ExportKeyring('relative.json')).toThrow(ExportKeyError);
			fs.writeFileSync(f.file, 'synthetic-private-invalid-content');
			expect(() => new ExportKeyring(f.file)).toThrow('encryption-key-unavailable');
			if (process.platform !== 'win32') {
				fs.writeFileSync(f.file, JSON.stringify(f.keys));
				fs.chmodSync(f.file, 0o644);
				expect(() => new ExportKeyring(f.file)).toThrow();
				fs.chmodSync(f.file, 0o600);
				const link = path.join(f.root, 'link.json');
				fs.symlinkSync(f.file, link);
				expect(() => new ExportKeyring(link)).toThrow();
				const hardlink = path.join(f.root, 'hardlink.json');
				fs.linkSync(f.file, hardlink);
				expect(() => new ExportKeyring(hardlink)).toThrow();
				expect(() => new ExportKeyring(f.file)).toThrow();
			}
		} finally {
			f.close();
		}
	});
});

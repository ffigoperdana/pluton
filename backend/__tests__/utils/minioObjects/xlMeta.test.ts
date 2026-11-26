import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Writable } from 'stream';
import {
	XlMetaError,
	bitrotFileSize,
	objectKeyFromPath,
	parseMinioFormat,
	parseXlMeta,
	type XlVersion,
} from '../../../src/utils/minioObjects/xlMeta';
import {
	MinioObjectError,
	partPath,
	streamMinioVersion,
} from '../../../src/utils/minioObjects/objectStream';
import {
	S2Error,
	S2StreamDecoder,
	crc32c,
	decodeS2Block,
} from '../../../src/utils/minioObjects/s2';
import { xxhash64 } from '../../../src/utils/minioObjects/xxhash64';
import { MsgpackReader } from '../../../src/utils/minioObjects/msgpack';
import { FIXTURES, listing, readFixtureArchive, source, type FixtureEntry } from './fixture';

// Written by a real MinIO server (minio-version.txt) with generate.sh.
const ROOT = '/srv/example-app/minio';
const single = readFixtureArchive('xl-single.tar.gz', ROOT);
const erasure = readFixtureArchive('erasure-drive1.tar.gz', ROOT);

/** Original upload of each fixture object version, by bucket/key and ordinal (oldest = 1). */
const UPLOADS: Record<string, string[]> = {
	'example-bucket/hello.txt': ['hello.txt'],
	'example-bucket/empty.txt': ['empty.txt'],
	'example-bucket/dokumen/laporan akhir é.txt': ['laporan.txt'],
	'example-bucket/docs/report.bin': ['report.bin'],
	'example-bucket/data/large.bin': ['large.bin'],
	'example-bucket/uploads/multipart.bin': ['multipart.bin'],
	'example-bucket/logs/app.log': ['app.log'],
	'example-bucket/logs/small.log': ['small.log'],
	'example-bucket/exports/table.csv': ['table.csv'],
	'example-bucket/folder/': ['empty.txt'],
	'versioned-bucket/legacy.txt': ['legacy-v1.txt', 'legacy-v2.txt'],
	'versioned-bucket/notes.txt': ['notes-v1.txt', 'notes-v2.txt'],
	'versioned-bucket/kept.bin': ['kept-v1.bin', 'kept-v2.bin'],
};

const metaFiles = (entries: Map<string, FixtureEntry>) =>
	[...entries.values()].filter(entry => entry.type === 'file' && entry.path.endsWith('/xl.meta'));
const objectOf = (metaPath: string) => {
	const relative = path.posix.dirname(metaPath).slice(ROOT.length + 1);
	const [bucket, ...rest] = relative.split('/');
	return {
		bucket,
		key: objectKeyFromPath(rest.join('/')),
		directory: path.posix.dirname(metaPath),
	};
};

async function read(
	entries: Map<string, FixtureEntry>,
	directory: string,
	version: XlVersion,
	inline?: Buffer,
	chunk = 65536
) {
	const chunks: Buffer[] = [];
	const output = new Writable({
		write(value: Buffer, _encoding, done) {
			chunks.push(value);
			done();
		},
	});
	const parts: string[] = [];
	const result = await streamMinioVersion(
		version,
		inline,
		async (part, sink) => {
			const file = partPath(directory, version, part);
			parts.push(file);
			const data = entries.get(file)!.data;
			for (let offset = 0; offset < data.length; offset += chunk)
				await new Promise<void>((resolve, reject) =>
					sink.write(data.subarray(offset, offset + chunk), error =>
						error ? reject(error) : resolve()
					)
				);
		},
		output,
		new AbortController().signal
	);
	return { result, content: Buffer.concat(chunks), parts };
}

describe('xl.meta written by MinIO', () => {
	it('matches MinIO’s own version listing for every object', () => {
		const seen = new Set<string>();
		for (const file of [...metaFiles(single), ...metaFiles(erasure)]) {
			const { bucket, key } = objectOf(file.path);
			const meta = parseXlMeta(file.data);
			expect(meta.minor).toBe(3);
			const expected = listing
				.filter(record => record.bucket === bucket && record.key === key)
				.sort((a, b) => b.versionOrdinal - a.versionOrdinal);
			expect(meta.versions.map(version => version.versionId)).toEqual(
				expected.map(record => record.versionId)
			);
			meta.versions.forEach((version, index) => {
				const record = expected[index];
				expect(version.kind).toBe(record.isDeleteMarker ? 'delete-marker' : 'object');
				expect(version.size).toBe(version.status === 'encrypted' ? null : record.size);
				expect(Number(version.modTimeNs / 1_000_000n)).toBe(Date.parse(record.lastModified));
				if (version.status !== 'encrypted' && !record.isDeleteMarker)
					expect(version.etag).toBe(record.etag);
			});
			seen.add(`${bucket}/${key}`);
		}
		expect(seen.size).toBe(new Set(listing.map(record => `${record.bucket}/${record.key}`)).size);
	});

	it('labels the versions it cannot read with the reason', () => {
		const status = (entries: Map<string, FixtureEntry>, key: string) =>
			parseXlMeta(entries.get(`${ROOT}/${key}/xl.meta`)!.data).versions.map(
				version => version.status
			);
		expect(status(single, 'example-bucket/secret/sse.bin')).toEqual(['encrypted']);
		expect(status(erasure, 'erasure-bucket/object.bin')).toEqual(['erasure-multi-drive']);
		expect(status(single, 'versioned-bucket/notes.txt')).toEqual([
			'delete-marker',
			'supported',
			'supported',
		]);
		expect(status(single, 'example-bucket/logs/small.log')).toEqual(['supported']);
		const encrypted = parseXlMeta(single.get(`${ROOT}/example-bucket/secret/sse.bin/xl.meta`)!.data)
			.versions[0];
		expect(encrypted.etag).toBeNull();
	});

	it('describes inline, part, multipart and compressed layouts', () => {
		const version = (key: string) =>
			parseXlMeta(single.get(`${ROOT}/${key}/xl.meta`)!.data).versions[0];
		expect(version('example-bucket/hello.txt')).toMatchObject({
			inline: true,
			compression: null,
			etagKind: 'md5',
		});
		expect(version('example-bucket/data/large.bin')).toMatchObject({
			inline: false,
			blockSize: 1048576,
			parts: [{ number: 1, size: 2658480 }],
		});
		expect(version('example-bucket/uploads/multipart.bin').parts.map(part => part.size)).toEqual([
			5242880, 5242880, 873200,
		]);
		expect(version('example-bucket/uploads/multipart.bin').etagKind).toBe('multipart');
		const csv = version('example-bucket/exports/table.csv');
		expect(csv).toMatchObject({
			compression: 's2',
			size: source('table.csv').size,
			etagKind: 'multipart',
		});
		expect(csv.storedSize).toBeLessThan(csv.size);
		expect(version('example-bucket/logs/small.log')).toMatchObject({
			inline: true,
			compression: 's2',
			size: 20140,
		});
	});

	it('stores every part file with a 32-byte hash per MiB block', () => {
		for (const file of metaFiles(single)) {
			const { directory } = objectOf(file.path);
			for (const version of parseXlMeta(file.data).versions)
				if (version.status === 'supported' && !version.inline)
					for (const part of version.parts)
						expect(single.get(partPath(directory, version, part))!.data.length).toBe(
							bitrotFileSize(part.size, version.blockSize)
						);
		}
	});
});

describe('object content', () => {
	it('restores every supported version byte for byte', async () => {
		let restored = 0;
		for (const file of metaFiles(single)) {
			const { bucket, key, directory } = objectOf(file.path);
			const meta = parseXlMeta(file.data);
			const objects = meta.versions.filter(version => version.kind === 'object').reverse();
			for (const [ordinal, version] of objects.entries()) {
				if (version.status !== 'supported') continue;
				const upload = source(UPLOADS[`${bucket}/${key}`][ordinal]);
				for (const chunk of [1 << 20, 4099]) {
					const { content, result } = await read(
						single,
						directory,
						version,
						meta.inline.get(version.versionId),
						chunk
					);
					expect(content.length).toBe(upload.size);
					expect(crypto.createHash('sha256').update(content).digest('hex')).toBe(upload.sha256);
					expect(result.etag).toBe(version.etag);
				}
				restored++;
			}
		}
		expect(restored).toBe(16);
	});

	const object = (key: string) => {
		const directory = `${ROOT}/${key}`;
		const meta = parseXlMeta(single.get(`${directory}/xl.meta`)!.data);
		return { directory, meta, version: meta.versions[0] };
	};
	const corrupted = (key: string, file: (version: XlVersion) => string, at: number) => {
		const { directory, version, meta } = object(key);
		const copy = new Map(single);
		const target = file(version);
		const data = Buffer.from(copy.get(target)!.data);
		data[at] ^= 0x01;
		copy.set(target, { ...copy.get(target)!, data });
		return { copy, directory, version, inline: meta.inline.get(version.versionId) };
	};

	it('never completes the output when the content does not match its ETag', async () => {
		const { copy, directory, version } = corrupted(
			'example-bucket/data/large.bin',
			version => partPath(`${ROOT}/example-bucket/data/large.bin`, version, version.parts[0]),
			2_000_000
		);
		const chunks: Buffer[] = [];
		const output = new Writable({
			write(value: Buffer, _encoding, done) {
				chunks.push(value);
				done();
			},
		});
		await expect(
			streamMinioVersion(
				version,
				undefined,
				async (part, sink) => {
					await new Promise<void>(resolve =>
						sink.write(copy.get(partPath(directory, version, part))!.data, () => resolve())
					);
				},
				output,
				new AbortController().signal
			)
		).rejects.toMatchObject({ reason: 'etag-mismatch' });
		expect(Buffer.concat(chunks).length).toBeLessThan(version.size!);
	});

	it('holds back the last chunk of a multipart object until its ETag matches', async () => {
		const key = 'example-bucket/uploads/multipart.bin';
		const { copy, directory, version } = corrupted(
			key,
			version => partPath(`${ROOT}/${key}`, version, version.parts[2]),
			100
		);
		let written = 0;
		const output = new Writable({
			write(value: Buffer, _encoding, done) {
				written += value.length;
				done();
			},
		});
		await expect(
			streamMinioVersion(
				version,
				undefined,
				async (part, sink) => {
					const data = copy.get(partPath(directory, version, part))!.data;
					for (let offset = 0; offset < data.length; offset += 1 << 20)
						await new Promise<void>(resolve =>
							sink.write(data.subarray(offset, offset + (1 << 20)), () => resolve())
						);
				},
				output,
				new AbortController().signal
			)
		).rejects.toMatchObject({ reason: 'etag-mismatch' });
		expect(written).toBeGreaterThan(0);
		expect(written).toBeLessThan(version.size!);
	});

	it('refuses truncated, oversized and corrupt compressed data', async () => {
		const key = 'example-bucket/docs/report.bin';
		const { directory, version } = object(key);
		const file = partPath(directory, version, version.parts[0]);
		const run = (data: Buffer, target = version) =>
			streamMinioVersion(
				target,
				undefined,
				async (_part, sink) => {
					await new Promise<void>((resolve, reject) =>
						sink.write(data, error => (error ? reject(error) : resolve()))
					);
				},
				new Writable({ write: (_v, _e, done) => done() }),
				new AbortController().signal
			);
		const data = single.get(file)!.data;
		await expect(run(data.subarray(0, data.length - 1))).rejects.toMatchObject({
			reason: 'stored-size',
		});
		await expect(run(Buffer.concat([data, Buffer.alloc(1)]))).rejects.toMatchObject({
			reason: 'stored-size',
		});

		const log = object('example-bucket/logs/app.log');
		const logFile = single.get(partPath(log.directory, log.version, log.version.parts[0]))!.data;
		const broken = Buffer.from(logFile);
		broken[32 + 4 + 4 + 40] ^= 0xff; // inside the first compressed S2 chunk
		await expect(run(broken, log.version)).rejects.toMatchObject({ reason: 'compressed-data' });
	});

	it('refuses an inline version without its data and unsupported versions', async () => {
		const { version } = object('example-bucket/hello.txt');
		const sink = new Writable({ write: (_v, _e, done) => done() });
		await expect(
			streamMinioVersion(
				version,
				undefined,
				async () => undefined,
				sink,
				new AbortController().signal
			)
		).rejects.toBeInstanceOf(MinioObjectError);
		const sse = object('example-bucket/secret/sse.bin');
		await expect(
			streamMinioVersion(
				sse.version,
				sse.meta.inline.get('null'),
				async () => undefined,
				sink,
				new AbortController().signal
			)
		).rejects.toMatchObject({ reason: 'not-supported' });
	});
});

/** Minimal msgpack writer for re-sealing fixtures in other container versions. */
const bin = (data: Buffer) => {
	const header = Buffer.alloc(5);
	header[0] = 0xc6;
	header.writeUInt32BE(data.length, 1);
	return Buffer.concat([header, data]);
};
const uint32 = (value: number) => {
	const out = Buffer.alloc(5);
	out[0] = 0xce;
	out.writeUInt32BE(value, 1);
	return out;
};
const container = (minor: number, payload: Buffer) => {
	const head = Buffer.from('XL2 \0\0\0\0', 'latin1');
	head.writeUInt16LE(1, 4);
	head.writeUInt16LE(minor, 6);
	return Buffer.concat([head, payload]);
};
/** Splits a v1.3 xl.meta into its headers, version bodies and inline data. */
function split(file: Buffer) {
	const reader = new MsgpackReader(file.subarray(8));
	const meta = reader.bin();
	reader.uint32();
	const inline = reader.rest();
	const index = new MsgpackReader(meta);
	const headerVersion = index.int();
	const metaVersion = index.int();
	const count = index.int();
	const versions: { header: Buffer; body: Buffer }[] = [];
	for (let i = 0; i < count; i++) versions.push({ header: index.bin(), body: index.bin() });
	return { headerVersion, metaVersion, versions, inline };
}
function seal13(parts: ReturnType<typeof split>) {
	const meta = Buffer.concat([
		Buffer.from([parts.headerVersion, parts.metaVersion, parts.versions.length]),
		...parts.versions.flatMap(version => [bin(version.header), bin(version.body)]),
	]);
	return container(
		3,
		Buffer.concat([bin(meta), uint32(Number(xxhash64(meta) & 0xffffffffn)), parts.inline])
	);
}
const legacyMap = (bodies: Buffer[]) =>
	Buffer.concat([
		Buffer.from([0x81, 0xa8]),
		Buffer.from('Versions'),
		Buffer.from([0x90 + bodies.length]),
		...bodies,
	]);

describe('xl.meta containers and integrity', () => {
	const notes = single.get(`${ROOT}/versioned-bucket/notes.txt/xl.meta`)!.data;
	const kept = single.get(`${ROOT}/versioned-bucket/kept.bin/xl.meta`)!.data;

	it('reads the pre-index containers (minor 0, 1 and 2) like the current one', () => {
		const current = parseXlMeta(notes);
		const parts = split(notes);
		// Legacy containers list versions in any order; MinIO sorts them by time.
		const bodies = parts.versions.map(version => version.body).reverse();
		const map = legacyMap(bodies);
		const v2 = container(
			2,
			Buffer.concat([bin(map), uint32(Number(xxhash64(map) & 0xffffffffn)), parts.inline])
		);
		const v1 = container(1, Buffer.concat([bin(map), parts.inline]));
		expect(parseXlMeta(v2)).toEqual({ ...current, minor: 2 });
		expect(parseXlMeta(v1)).toEqual({ ...current, minor: 1 });
		const keptParts = split(kept);
		const v0 = container(0, legacyMap(keptParts.versions.map(version => version.body)));
		expect(parseXlMeta(v0).versions).toEqual(parseXlMeta(kept).versions);
		expect(
			parseXlMeta(
				Buffer.concat([
					Buffer.from('XL2 1   ', 'latin1'),
					legacyMap(keptParts.versions.map(version => version.body)),
				])
			).minor
		).toBe(0);
	});

	it('refuses a wrong CRC, header, version or truncated metadata', () => {
		const flipped = Buffer.from(notes);
		flipped[60] ^= 0x01;
		expect(() => parseXlMeta(flipped)).toThrow(expect.objectContaining({ reason: 'crc' }));
		expect(() => parseXlMeta(Buffer.concat([Buffer.from('XL3 '), notes.subarray(4)]))).toThrow(
			expect.objectContaining({ reason: 'header' })
		);
		const major = Buffer.from(notes);
		major.writeUInt16LE(2, 4);
		expect(() => parseXlMeta(major)).toThrow(expect.objectContaining({ reason: 'version' }));
		const minor = Buffer.from(notes);
		minor.writeUInt16LE(4, 6);
		expect(() => parseXlMeta(minor)).toThrow(expect.objectContaining({ reason: 'version' }));
		expect(() => parseXlMeta(notes.subarray(0, 200))).toThrow(XlMetaError);
		expect(() => parseXlMeta(Buffer.from('{"version":"1"}'))).toThrow(
			expect.objectContaining({ reason: 'header' })
		);
	});

	it('refuses a version whose index header disagrees with it', () => {
		const parts = split(notes);
		const header = Buffer.from(parts.versions[1].header);
		header[5] ^= 0x01; // inside the version ID
		parts.versions[1] = { ...parts.versions[1], header };
		expect(() => parseXlMeta(seal13(parts))).toThrow(
			expect.objectContaining({ reason: 'malformed' })
		);
	});

	it('hides free (tiered) versions and labels transitioned and unknown compression', () => {
		const parts = split(notes);
		const header = Buffer.from(parts.versions[0].header);
		header[header.length - 3] |= 0x01; // Flags: free version
		parts.versions[0] = { ...parts.versions[0], header };
		expect(parseXlMeta(seal13(parts)).versions.map(version => version.status)).toEqual([
			'supported',
			'supported',
		]);

		const hello = split(single.get(`${ROOT}/example-bucket/hello.txt/xl.meta`)!.data);
		const tiered = Buffer.from(
			hello.versions[0].body
				.toString('latin1')
				.replace(
					'\xbcx-minio-internal-inline-data\xc4\x04true',
					'\xd9\x22x-minio-internal-transition-status\xc4\x08complete'
				),
			'latin1'
		);
		hello.versions[0] = { ...hello.versions[0], body: tiered };
		expect(parseXlMeta(seal13(hello)).versions[0].status).toBe('transitioned');

		const log = split(single.get(`${ROOT}/example-bucket/logs/app.log/xl.meta`)!.data);
		log.versions[0] = {
			...log.versions[0],
			body: Buffer.from(
				log.versions[0].body
					.toString('latin1')
					.replace('klauspost/compress/s2', 'klauspost/compress/zz'),
				'latin1'
			),
		};
		expect(parseXlMeta(seal13(log)).versions[0].status).toBe('unknown-compression');
	});

	it('reads format.json of single-drive and erasure deployments', () => {
		expect(parseMinioFormat(single.get(`${ROOT}/.minio.sys/format.json`)!.data.toString())).toEqual(
			{
				format: 'xl-single',
				drives: 1,
				supported: true,
			}
		);
		expect(
			parseMinioFormat(erasure.get(`${ROOT}/.minio.sys/format.json`)!.data.toString())
		).toEqual({
			format: 'xl',
			drives: 4,
			supported: false,
		});
		expect(parseMinioFormat('{"version":"1","format":"fs"}')).toMatchObject({
			format: 'fs',
			supported: false,
		});
		expect(parseMinioFormat('not json')).toMatchObject({ format: 'unknown', supported: false });
	});

	it('maps object folders to keys', () => {
		expect(objectKeyFromPath('folder__XLDIR__')).toBe('folder/');
		expect(objectKeyFromPath('a/b__XLDIR__')).toBe('a/b/');
		expect(objectKeyFromPath('dokumen/laporan akhir é.txt')).toBe('dokumen/laporan akhir é.txt');
		expect(fs.existsSync(path.join(FIXTURES, 'generate.sh'))).toBe(true);
	});
});

describe('S2 decoding', () => {
	const frame = (type: number, body: Buffer) => {
		const header = Buffer.alloc(4);
		header[0] = type;
		header.writeUIntLE(body.length, 1, 3);
		return Buffer.concat([header, body]);
	};
	const checksum = (data: Buffer) => {
		const crc = crc32c(data);
		const value = Buffer.alloc(4);
		value.writeUInt32LE(((((crc >>> 15) | (crc << 17)) >>> 0) + 0xa282ead8) >>> 0);
		return value;
	};

	it('computes CRC-32C', () => {
		expect(crc32c(Buffer.from('123456789'))).toBe(0xe3069283);
	});

	it('decodes literals, copies, overlapping copies and S2 repeats', () => {
		// "abcd" literal, copy1 offset 4 length 4, repeat (code 5: 3+8=11), copy2 offset 2 length 3, copy4 offset 1 length 2.
		const block = Buffer.alloc(1);
		const elements = Buffer.from([
			0x0c,
			0x61,
			0x62,
			0x63,
			0x64, // literal "abcd"
			0x01,
			0x04, // copy1 offset 4 length 4 -> "abcd"
			0x15,
			0x00,
			0x03, // repeat code 5: 3 + 8 = 11 bytes from offset 4
			0x0a,
			0x02,
			0x00, // copy2 length 3 offset 2
			0x07,
			0x01,
			0x00,
			0x00,
			0x00, // copy4 length 2 offset 1
		]);
		const expected = 'abcd' + 'abcd' + 'abcdabcdabc' + 'bcb' + 'bb';
		block[0] = expected.length;
		expect(decodeS2Block(Buffer.concat([block, elements])).toString()).toBe(expected);
		// Long repeats (codes 6 and 7) and a 2-byte literal length.
		const long = decodeS2Block(
			Buffer.from([
				0x8d, 0x82, 0x04, 0x00, 0x78, 0x01, 0x01, 0x19, 0x00, 0x00, 0x00, 0x1d, 0x00, 0x00, 0x00,
				0x00,
			])
		);
		expect(long.length).toBe(1 + 4 + 260 + 65540);
		expect(long.every(byte => byte === 0x78)).toBe(true);
	});

	it('refuses corrupt blocks, bad checksums, reserved chunks and truncated streams', () => {
		expect(() => decodeS2Block(Buffer.from([0x04, 0x01, 0x00]))).toThrow(S2Error); // repeat before any offset
		expect(() =>
			decodeS2Block(Buffer.from([0x08, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x01, 0x09]))
		).toThrow(S2Error); // offset beyond output
		expect(() => decodeS2Block(Buffer.from([0x05, 0x0c, 0x61, 0x62, 0x63, 0x64]))).toThrow(S2Error); // wrong length
		const id = frame(0xff, Buffer.from('S2sTwO'));
		const data = Buffer.from('hello');
		const decoded: Buffer[] = [];
		const ok = new S2StreamDecoder(chunk => decoded.push(chunk));
		ok.write(
			Buffer.concat([
				id,
				frame(0x01, Buffer.concat([checksum(data), data])),
				frame(0x99, Buffer.from([1, 2])),
				frame(0xfe, Buffer.alloc(3)),
			])
		);
		ok.end();
		expect(Buffer.concat(decoded).toString()).toBe('hello');
		const bad = new S2StreamDecoder(() => undefined);
		expect(() =>
			bad.write(Buffer.concat([id, frame(0x01, Buffer.concat([Buffer.alloc(4), data]))]))
		).toThrow(expect.objectContaining({ reason: 'checksum' }));
		expect(() =>
			new S2StreamDecoder(() => undefined).write(Buffer.concat([id, frame(0x02, Buffer.alloc(1))]))
		).toThrow(expect.objectContaining({ reason: 'unsupported' }));
		expect(() =>
			new S2StreamDecoder(() => undefined).write(frame(0x01, Buffer.concat([checksum(data), data])))
		).toThrow(S2Error);
		const cut = new S2StreamDecoder(() => undefined);
		cut.write(
			Buffer.concat([id, frame(0x01, Buffer.concat([checksum(data), data])).subarray(0, 6)])
		);
		expect(() => cut.end()).toThrow(expect.objectContaining({ reason: 'truncated' }));
	});
});

import { MsgpackError, MsgpackReader } from './msgpack';
import { xxhash64 } from './xxhash64';

/**
 * Reader for MinIO `xl.meta` files (format XL2, major 1, minor 0-3), written
 * from MinIO's open-source on-disk format and checked against files written by
 * a real MinIO server (backend/__tests__/fixtures/minioObjects). It accepts the
 * single-drive layout only and labels every other version with the reason it
 * cannot be read. Nothing here decides that data is correct: object content is
 * verified separately against its ETag.
 */

export type XlMetaFailure = 'header' | 'version' | 'crc' | 'malformed';

export class XlMetaError extends Error {
	constructor(readonly reason: XlMetaFailure) {
		super(`xl.meta ${reason}`);
	}
}

/** Why a version cannot be downloaded; `supported` versions can. */
export type XlVersionStatus =
	| 'supported'
	| 'delete-marker'
	| 'legacy-version'
	| 'encrypted'
	| 'transitioned'
	| 'erasure-multi-drive'
	| 'unknown-layout'
	| 'unknown-compression'
	| 'etag-unverifiable';

export type XlPart = { number: number; size: number; actualSize: number };

export type XlVersion = {
	/** `null` for the unversioned version, else the version UUID. */
	versionId: string;
	kind: 'object' | 'delete-marker' | 'legacy';
	/** Nanoseconds since the Unix epoch, as MinIO stores it. */
	modTimeNs: bigint;
	/** Logical (uncompressed) size; 0 for delete markers, null when encryption hides it. */
	size: number | null;
	/** Stored size after compression. */
	storedSize: number;
	etag: string | null;
	etagKind: 'md5' | 'multipart' | null;
	contentType: string | null;
	inline: boolean;
	compression: 's2' | null;
	dataDir: string | null;
	blockSize: number;
	parts: XlPart[];
	status: XlVersionStatus;
};

export type XlMeta = {
	minor: number;
	/** Newest first, free (tiered) versions removed. */
	versions: XlVersion[];
	inline: Map<string, Buffer>;
};

const HEADER = Buffer.from('XL2 ', 'latin1');
const MAX_VERSIONS = 100_000;
const MAX_PARTS = 10_000;
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const INTERNAL = 'x-minio-internal-';

const uuid = (bytes: Buffer) => {
	if (bytes.length !== 16) throw new XlMetaError('malformed');
	const hex = bytes.toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

type RawObject = {
	id?: string;
	dataDir?: string;
	ecAlgo?: number;
	ecM?: number;
	ecN?: number;
	blockSize?: number;
	ecIndex?: number;
	checksumAlgo?: number;
	partNumbers?: number[];
	partSizes?: number[];
	partActualSizes?: number[] | null;
	size?: number;
	modTime?: bigint;
	system: Map<string, string>;
	user: Map<string, string>;
};

type RawVersion = {
	type: number;
	object?: RawObject;
	free: boolean;
	id?: string;
	modTime?: bigint;
};

function stringMap(reader: MsgpackReader, valuesAsBytes: boolean): Map<string, string> {
	const map = new Map<string, string>();
	if (reader.isNil()) {
		reader.nil();
		return map;
	}
	const entries = reader.mapHeader();
	for (let i = 0; i < entries; i++) {
		const key = reader.str().toLowerCase();
		const value = valuesAsBytes ? reader.bin().toString('utf8') : reader.str();
		if (map.has(key)) throw new XlMetaError('malformed');
		map.set(key, value);
	}
	return map;
}

function intArray(reader: MsgpackReader, allowNil = false): number[] | null {
	if (reader.isNil()) {
		if (!allowNil) throw new XlMetaError('malformed');
		reader.nil();
		return null;
	}
	const tag = reader.peek();
	// msgp writes []uint8 as bin; other integer slices as arrays.
	if (tag >= 0xc4 && tag <= 0xc6) return [...reader.bin()];
	const count = reader.arrayHeader();
	if (count > MAX_PARTS) throw new XlMetaError('malformed');
	const values: number[] = [];
	for (let i = 0; i < count; i++) values.push(reader.int());
	return values;
}

function readObject(reader: MsgpackReader, deleteMarker: boolean): RawObject {
	const object: RawObject = { system: new Map(), user: new Map() };
	const seen = new Set<string>();
	const fields = reader.mapHeader();
	for (let i = 0; i < fields; i++) {
		const field = reader.str();
		if (seen.has(field)) throw new XlMetaError('malformed');
		seen.add(field);
		switch (field) {
			case 'ID':
				object.id = uuid(reader.bin());
				break;
			case 'MTime':
				object.modTime = reader.bigint();
				break;
			case 'MetaSys':
				object.system = stringMap(reader, true);
				break;
			default:
				if (deleteMarker) {
					reader.skip();
					break;
				}
				switch (field) {
					case 'DDir':
						object.dataDir = uuid(reader.bin());
						break;
					case 'EcAlgo':
						object.ecAlgo = reader.int();
						break;
					case 'EcM':
						object.ecM = reader.int();
						break;
					case 'EcN':
						object.ecN = reader.int();
						break;
					case 'EcBSize':
						object.blockSize = reader.int();
						break;
					case 'EcIndex':
						object.ecIndex = reader.int();
						break;
					case 'CSumAlgo':
						object.checksumAlgo = reader.int();
						break;
					case 'PartNums':
						object.partNumbers = intArray(reader)!;
						break;
					case 'PartSizes':
						object.partSizes = intArray(reader)!;
						break;
					case 'PartASizes':
						object.partActualSizes = intArray(reader, true);
						break;
					case 'Size':
						object.size = reader.int();
						break;
					case 'MetaUsr':
						object.user = stringMap(reader, false);
						break;
					default:
						// EcDist, PartETags, PartIdx and fields of later releases do
						// not change where the data is; content is verified by ETag.
						reader.skip();
				}
		}
	}
	return object;
}

/** One msgp-encoded xlMetaV2Version. */
function readVersion(reader: MsgpackReader): RawVersion {
	let type: number | undefined;
	let object: RawObject | undefined;
	let marker: RawObject | undefined;
	let legacy = false;
	const seen = new Set<string>();
	const fields = reader.mapHeader();
	for (let i = 0; i < fields; i++) {
		const field = reader.str();
		if (seen.has(field)) throw new XlMetaError('malformed');
		seen.add(field);
		if (field === 'Type') type = reader.int();
		else if (field === 'V2Obj' && !reader.isNil()) object = readObject(reader, false);
		else if (field === 'DelObj' && !reader.isNil()) marker = readObject(reader, true);
		else if (field === 'V1Obj' && !reader.isNil()) {
			legacy = true;
			reader.skip();
		} else reader.skip();
	}
	// A free version tracks tiered data awaiting removal; MinIO never lists it.
	const free = (value: RawObject) =>
		value.system.has(`${INTERNAL}free-version`) || value.system.has('free-version');
	if (type === 1 && object) return { type, object, free: free(object) };
	if (type === 2 && marker) return { type, object: marker, free: free(marker) };
	if (type === 3 && legacy) return { type, free: false };
	throw new XlMetaError(type === undefined || type < 1 || type > 3 ? 'version' : 'malformed');
}

/** Verifies the per-version header (v1.3) against the version it indexes. */
function checkHeader(header: Buffer, headerVersion: number, version: RawVersion): boolean {
	if (headerVersion < 2) return false;
	const reader = new MsgpackReader(header);
	const items = reader.arrayHeader();
	if (items < 5) throw new XlMetaError('malformed');
	const id = uuid(reader.bin());
	const modTime = reader.bigint();
	reader.skip();
	const type = reader.int();
	const flags = reader.int();
	if (
		version.type !== 3 &&
		(id !== version.object!.id || modTime !== version.object!.modTime || type !== version.type)
	)
		throw new XlMetaError('malformed');
	return (flags & 1) === 1;
}

function decimal(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!/^\d{1,16}$/.test(value)) return NaN;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : NaN;
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

function describe(raw: RawVersion): XlVersion {
	if (raw.type === 3)
		return {
			versionId: 'unknown',
			kind: 'legacy',
			modTimeNs: 0n,
			size: 0,
			storedSize: 0,
			etag: null,
			etagKind: null,
			contentType: null,
			inline: false,
			compression: null,
			dataDir: null,
			blockSize: 0,
			parts: [],
			status: 'legacy-version',
		};
	const object = raw.object!;
	if (!object.id || object.modTime === undefined) throw new XlMetaError('malformed');
	const versionId = object.id === ZERO_ID ? 'null' : object.id;
	if (raw.type === 2)
		return {
			versionId,
			kind: 'delete-marker',
			modTimeNs: object.modTime,
			size: 0,
			storedSize: 0,
			etag: null,
			etagKind: null,
			contentType: null,
			inline: false,
			compression: null,
			dataDir: null,
			blockSize: 0,
			parts: [],
			status: 'delete-marker',
		};
	const system = object.system;
	const keys = [...system.keys()];
	const userKeys = [...object.user.keys()];
	const etag = object.user.get('etag') ?? null;
	const compressionName = system.get(`${INTERNAL}compression`);
	const inline = system.get(`${INTERNAL}inline-data`) === 'true';
	const storedSize = object.size;
	if (storedSize === undefined || storedSize < 0) throw new XlMetaError('malformed');
	const numbers = object.partNumbers || [];
	const sizes = object.partSizes || [];
	const actual = object.partActualSizes;
	if (
		numbers.length !== sizes.length ||
		(actual && actual.length !== sizes.length) ||
		!numbers.length
	)
		throw new XlMetaError('malformed');
	if (sizes.some(value => value < 0) || actual?.some(value => value < 0))
		throw new XlMetaError('malformed');
	let status: XlVersionStatus = 'supported';
	const recordedActual = decimal(system.get(`${INTERNAL}actual-size`));
	const compression =
		compressionName === undefined
			? null
			: compressionName === 'klauspost/compress/s2' || compressionName === 'golang/snappy/LZ77'
				? ('s2' as const)
				: undefined;
	const encrypted =
		keys.some(
			key =>
				key.startsWith(`${INTERNAL}server-side-encryption`) ||
				key === `${INTERNAL}encrypted-multipart`
		) || userKeys.some(key => key.startsWith('x-amz-server-side-encryption'));
	if (encrypted) status = 'encrypted';
	else if (system.get(`${INTERNAL}transition-status`) === 'complete') status = 'transitioned';
	else if (object.ecM !== 1 || object.ecN !== 0) status = 'erasure-multi-drive';
	else if (
		object.ecAlgo !== 1 ||
		object.checksumAlgo !== 1 ||
		object.ecIndex !== 1 ||
		!object.blockSize ||
		object.blockSize < 1 ||
		object.blockSize > 64 * 1024 ** 2 ||
		(!inline && (!object.dataDir || object.dataDir === ZERO_ID))
	)
		status = 'unknown-layout';
	else if (compression === undefined) status = 'unknown-compression';
	let size: number | null = storedSize;
	const parts: XlPart[] = numbers.map((number, index) => ({
		number,
		size: sizes[index],
		actualSize: actual ? actual[index] : sizes[index],
	}));
	if (status === 'supported') {
		// Layout consistency matters only for versions this reader will decode.
		if (
			numbers.some(
				(number, index) =>
					number < 1 || number > MAX_PARTS || (index > 0 && number <= numbers[index - 1])
			)
		)
			throw new XlMetaError('malformed');
		if (sum(sizes) !== storedSize) throw new XlMetaError('malformed');
		if (compression) {
			if (recordedActual === undefined || Number.isNaN(recordedActual))
				throw new XlMetaError('malformed');
			size = recordedActual;
			if (!actual && parts.length === 1) parts[0].actualSize = size;
			else if (!actual) status = 'unknown-layout';
		} else {
			if (recordedActual !== undefined && recordedActual !== storedSize)
				throw new XlMetaError('malformed');
			if (parts.some(part => part.actualSize !== part.size)) throw new XlMetaError('malformed');
		}
		if (status === 'supported' && sum(parts.map(part => part.actualSize)) !== size)
			throw new XlMetaError('malformed');
		if (inline && parts.length !== 1) throw new XlMetaError('malformed');
	} else if (recordedActual !== undefined && !Number.isNaN(recordedActual)) size = recordedActual;
	else if (encrypted) size = null;
	let etagKind: XlVersion['etagKind'] = null;
	if (etag && /^[0-9a-f]{32}$/.test(etag)) etagKind = 'md5';
	else if (
		etag &&
		/^[0-9a-f]{32}-[1-9]\d{0,4}$/.test(etag) &&
		Number(etag.split('-')[1]) === parts.length
	)
		etagKind = 'multipart';
	if (status === 'supported' && !etagKind) status = 'etag-unverifiable';
	const contentType = object.user.get('content-type') ?? null;
	return {
		versionId,
		kind: 'object',
		modTimeNs: object.modTime,
		size,
		storedSize,
		etag: encrypted ? null : etag,
		etagKind,
		contentType: contentType && contentType.length <= 255 ? contentType : null,
		inline,
		compression: compression ?? null,
		dataDir: object.dataDir && object.dataDir !== ZERO_ID ? object.dataDir : null,
		blockSize: object.blockSize || 0,
		parts,
		status,
	};
}

function inlineData(bytes: Buffer): Map<string, Buffer> {
	const map = new Map<string, Buffer>();
	if (!bytes.length) return map;
	if (bytes[0] !== 1) throw new XlMetaError('version');
	const reader = new MsgpackReader(bytes.subarray(1));
	const entries = reader.mapHeader();
	for (let i = 0; i < entries; i++) {
		const key = reader.str();
		if (!key || map.has(key)) throw new XlMetaError('malformed');
		map.set(key, reader.bin());
	}
	return map;
}

function parseLegacyMap(meta: Buffer): RawVersion[] {
	const reader = new MsgpackReader(meta);
	const fields = reader.mapHeader();
	let versions: RawVersion[] | undefined;
	for (let i = 0; i < fields; i++) {
		const field = reader.str();
		if (field !== 'Versions') {
			reader.skip();
			continue;
		}
		if (versions) throw new XlMetaError('malformed');
		const count = reader.arrayHeader();
		if (count > MAX_VERSIONS) throw new XlMetaError('malformed');
		versions = [];
		for (let v = 0; v < count; v++) versions.push(readVersion(reader));
	}
	if (!versions) throw new XlMetaError('malformed');
	return versions;
}

export function parseXlMeta(buffer: Buffer): XlMeta {
	if (buffer.length <= 8 || !buffer.subarray(0, 4).equals(HEADER)) throw new XlMetaError('header');
	let major: number;
	let minor: number;
	if (buffer.subarray(4, 8).toString('latin1') === '1   ') {
		major = 1;
		minor = 0;
	} else {
		major = buffer.readUInt16LE(4);
		minor = buffer.readUInt16LE(6);
	}
	if (major !== 1 || minor > 3) throw new XlMetaError('version');
	try {
		const reader = new MsgpackReader(buffer.subarray(8));
		let raw: RawVersion[];
		let inline = new Map<string, Buffer>();
		if (minor === 0) {
			raw = parseLegacyMap(buffer.subarray(8));
		} else {
			const meta = reader.bin();
			if (minor >= 2) {
				const crc = reader.uint32();
				if (Number(xxhash64(meta) & 0xffffffffn) !== crc) throw new XlMetaError('crc');
			}
			inline = inlineData(reader.rest());
			if (minor < 3) raw = parseLegacyMap(meta);
			else {
				const index = new MsgpackReader(meta);
				const headerVersion = index.int();
				const metaVersion = index.int();
				if (headerVersion < 1 || headerVersion > 3 || metaVersion < 1 || metaVersion > 3)
					throw new XlMetaError('version');
				const count = index.int();
				if (count < 0 || count > MAX_VERSIONS) throw new XlMetaError('malformed');
				raw = [];
				for (let i = 0; i < count; i++) {
					const header = index.bin();
					const body = index.bin();
					const versionReader = new MsgpackReader(body);
					const version = readVersion(versionReader);
					if (versionReader.remaining) throw new XlMetaError('malformed');
					if (checkHeader(header, headerVersion, version)) version.free = true;
					raw.push(version);
				}
			}
		}
		const versions = raw
			.filter(version => !version.free)
			.map(describe)
			.map((version, order) => ({ version, order }))
			.sort((a, b) =>
				a.version.modTimeNs === b.version.modTimeNs
					? a.order - b.order
					: a.version.modTimeNs > b.version.modTimeNs
						? -1
						: 1
			)
			.map(entry => entry.version);
		return { minor, versions, inline };
	} catch (error) {
		if (error instanceof XlMetaError) throw error;
		if (error instanceof MsgpackError) throw new XlMetaError('malformed');
		throw error;
	}
}

/** Bytes a bitrot-protected shard file of `size` data bytes occupies. */
export function bitrotFileSize(size: number, shardSize: number): number {
	return size === 0 ? 0 : Math.ceil(size / shardSize) * 32 + size;
}

/** The S3 object key of an object folder below a bucket folder. */
export function objectKeyFromPath(relative: string): string {
	return relative.endsWith('__XLDIR__') ? `${relative.slice(0, -'__XLDIR__'.length)}/` : relative;
}

export type MinioFormat = {
	format: 'xl-single' | 'xl' | 'fs' | 'unknown';
	drives: number;
	supported: boolean;
};

/** `.minio.sys/format.json` of a data folder. */
export function parseMinioFormat(text: string): MinioFormat {
	let value: any;
	try {
		value = JSON.parse(text);
	} catch {
		return { format: 'unknown', drives: 0, supported: false };
	}
	const sets = Array.isArray(value?.xl?.sets) ? value.xl.sets : [];
	const drives = sets.reduce(
		(total: number, set: unknown) => total + (Array.isArray(set) ? set.length : 0),
		0
	);
	const format = ['xl-single', 'xl', 'fs'].includes(value?.format) ? value.format : 'unknown';
	return {
		format,
		drives,
		supported:
			format === 'xl-single' &&
			value?.version === '1' &&
			value?.xl?.version === '3' &&
			sets.length === 1 &&
			drives === 1,
	};
}

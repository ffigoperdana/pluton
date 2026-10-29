import crypto from 'crypto';
import { once } from 'events';
import { Transform, Writable } from 'stream';
import { finished, pipeline } from 'stream/promises';
import tar from 'tar-stream';
import { managedSnapshotPath } from '../managedSnapshotPath';
import type { ManagedRepositorySession } from './ManagedSftpRepositorySession';
import type { ManagedSnapshotIndex } from './ManagedSnapshotIndex';
import type { ManagedExportProof } from './ManagedExportProof';
import {
	ManagedExportError,
	assertManagedLinkTarget,
	exportIncludes,
	type ManagedExportEntry,
	type ManagedExportSummary,
} from './ManagedExportPolicy';

const MAX_EXTENSION = 64 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
type Metadata = {
	name: string;
	type: 'file' | 'directory' | 'symlink';
	size: number;
	mode: number;
	uid: number;
	gid: number;
	mtime: string;
	uname: string;
	gname: string;
	linkname?: string;
	pax?: Record<string, string>;
};
function invalid(): never {
	throw new ManagedExportError('tar-invalid');
}
function text(bytes: Buffer): string {
	try {
		return decoder.decode(bytes);
	} catch {
		return invalid();
	}
}
function field(bytes: Buffer): string {
	const end = bytes.indexOf(0);
	if (end >= 0 && bytes.subarray(end).some(value => value !== 0)) invalid();
	return text(end < 0 ? bytes : bytes.subarray(0, end));
}
function number(bytes: Buffer, signed = false): number {
	let value: bigint;
	if (bytes[0] & 0x80) {
		value = BigInt(bytes[0] & 0x7f);
		for (const byte of bytes.subarray(1)) value = (value << 8n) | BigInt(byte);
		if (bytes[0] & 0x40) value -= 1n << BigInt(bytes.length * 8 - 1);
	} else {
		const zero = bytes.indexOf(0);
		if (zero !== -1 && bytes.subarray(zero).some(value => value !== 0 && value !== 32)) invalid();
		const raw = text(bytes).replace(/\0.*$/s, '').trim();
		if (!/^[0-7]*$/.test(raw)) invalid();
		value = raw ? BigInt('0o' + raw) : 0n;
	}
	if (
		(!signed && value < 0n) ||
		value > BigInt(Number.MAX_SAFE_INTEGER) ||
		value < BigInt(Number.MIN_SAFE_INTEGER)
	)
		invalid();
	return Number(value);
}
function decimal(value: string): number {
	if (!/^\d{1,16}$/.test(value) || !Number.isSafeInteger(Number(value))) invalid();
	return Number(value);
}
function timestamp(value: string): Date {
	if (!/^-?\d{1,12}(?:\.\d{1,9})?$/.test(value)) invalid();
	const date = new Date(Number(value) * 1000);
	if (!Number.isFinite(date.getTime())) invalid();
	return date;
}
function paxRecords(payload: Buffer): Record<string, string> {
	const result: Record<string, string> = Object.create(null);
	for (let offset = 0; offset < payload.length; ) {
		const separator = payload.indexOf(32, offset);
		if (separator < 0 || separator - offset > 7) invalid();
		const lengthText = text(payload.subarray(offset, separator));
		if (!/^[1-9]\d{0,6}$/.test(lengthText)) invalid();
		const end = offset + Number(lengthText);
		if (end > payload.length || end <= separator + 2 || payload[end - 1] !== 10) invalid();
		const equals = payload.indexOf(61, separator + 1);
		if (equals < 0 || equals >= end - 1) invalid();
		const key = text(payload.subarray(separator + 1, equals));
		const value = text(payload.subarray(equals + 1, end - 1));
		if (Object.hasOwn(result, key) || value.includes('\0')) invalid();
		if (
			![
				'path',
				'linkpath',
				'size',
				'mtime',
				'atime',
				'ctime',
				'uid',
				'gid',
				'uname',
				'gname',
				'SCHILY.acl.access',
				'SCHILY.acl.default',
			].includes(key) &&
			!/^SCHILY\.xattr\.user\.[A-Za-z0-9_.-]{1,128}$/.test(key)
		)
			throw new ManagedExportError('tar-extension-unsupported');
		result[key] = value;
		offset = end;
	}
	return result;
}
function packedHeader(metadata: Metadata): tar.Headers & { pax?: Record<string, string> } {
	const pax = { ...metadata.pax };
	const result: tar.Headers & { pax?: Record<string, string> } = {
		...metadata,
		mtime: new Date(metadata.mtime),
	};
	// A zero permission mask is legitimate. Keep pack.entry's defaulting logic
	// from replacing it: the encoder masks this sentinel bit out of the mode.
	if (!metadata.mode) result.mode = 0o10000;
	// tar-stream's narrow octal owner fields saturate and its base mtime is int32.
	// Use standard PAX overrides instead of silently changing original metadata.
	for (const key of ['uid', 'gid'] as const)
		if (metadata[key] > 0o777777) {
			pax[key] = String(metadata[key]);
			result[key] = 0;
		}
	for (const key of ['uname', 'gname'] as const)
		if (Buffer.byteLength(metadata[key]) > 31 || /[^\x20-\x7e]/.test(metadata[key])) {
			pax[key] = metadata[key];
			result[key] = '';
		}
	const seconds = result.mtime!.getTime() / 1000;
	if (seconds < 0 || seconds > 0x7fffffff) {
		pax.mtime ||= String(seconds);
		result.mtime = new Date(0);
	}
	if (Object.keys(pax).length)
		result.pax = Object.fromEntries(
			Object.entries(pax).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		);
	return result;
}
async function write(stream: Writable, data: Buffer, signal: AbortSignal) {
	// tar-stream entries use streamx: write(data, callback) is not supported.
	// Its documented boolean/drain contract bounds queued payload bytes.
	if (!stream.write(data)) await once(stream, 'drain', { signal });
}

/** A strict incremental TAR reader, NOT an extractor. It retains one 512-byte
 * header and at most 64 KiB of extension metadata. Payloads pass through bounded
 * backpressure while being hashed; only canonical allowlisted headers are emitted.
 * Raw PAX/GNU headers never reach the destination, preventing parser disagreement. */
class TarReader {
	private header = Buffer.alloc(512);
	private headerBytes = 0;
	private remaining = 0;
	private padding = 0;
	private zeroHeaders = 0;
	private rawBytes = 0;
	private extensions = 0;
	private extensionBytes = 0;
	private extendedType = '';
	private extended: Buffer[] = [];
	private pax: Record<string, string> | undefined;
	private longName?: string;
	private longLink?: string;
	private entry?: ManagedExportEntry;
	private hash?: crypto.Hash;
	private output?: Writable;
	private outputDone?: Promise<void>;
	private included = 0;
	private readonly cursor: string;
	constructor(
		private readonly index: ManagedSnapshotIndex,
		private readonly proof: ManagedExportProof,
		private readonly pack: tar.Pack,
		private readonly compare: boolean,
		private readonly signal: AbortSignal
	) {
		this.cursor = proof.createCursor();
	}
	close() {
		this.proof.releaseCursor(this.cursor);
	}
	async consume(bytes: Buffer) {
		this.rawBytes += bytes.length;
		if (!Number.isSafeInteger(this.rawBytes)) invalid();
		let offset = 0;
		while (offset < bytes.length) {
			this.signal.throwIfAborted();
			if (this.remaining) {
				const size = Math.min(this.remaining, bytes.length - offset);
				const part = bytes.subarray(offset, offset + size);
				if (this.extendedType) this.extended.push(Buffer.from(part));
				else if (this.entry) {
					this.hash?.update(part);
					if (this.output) await write(this.output, part, this.signal);
				}
				this.remaining -= size;
				offset += size;
				if (!this.remaining) await this.finishEntry();
			} else if (this.padding) {
				const size = Math.min(this.padding, bytes.length - offset);
				if (bytes.subarray(offset, offset + size).some(value => value !== 0)) invalid();
				this.padding -= size;
				offset += size;
			} else {
				const size = Math.min(512 - this.headerBytes, bytes.length - offset);
				bytes.copy(this.header, this.headerBytes, offset, offset + size);
				offset += size;
				this.headerBytes += size;
				if (this.headerBytes === 512) {
					this.headerBytes = 0;
					await this.readHeader();
				}
			}
		}
	}
	private async readHeader() {
		const h = this.header;
		if (h.every(value => value === 0)) {
			if (++this.zeroHeaders > 128) throw new ManagedExportError('tar-metadata-limit');
			return;
		}
		if (this.zeroHeaders) invalid();
		let checksum = 0;
		for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : h[i];
		if (checksum !== number(h.subarray(148, 156))) invalid();
		const magic = text(h.subarray(257, 263));
		if (!['ustar\0', 'ustar '].includes(magic))
			throw new ManagedExportError('tar-extension-unsupported');
		if (
			(magic === 'ustar\0' && text(h.subarray(263, 265)) !== '00') ||
			(magic === 'ustar ' && !h.subarray(263, 265).equals(Buffer.from([32, 0])))
		)
			throw new ManagedExportError('tar-extension-unsupported');
		const type = String.fromCharCode(h[156] || 48);
		const rawSize = number(h.subarray(124, 136));
		if (['x', 'L', 'K'].includes(type)) {
			if (rawSize < 1 || (this.extensionBytes += rawSize) > MAX_EXTENSION || ++this.extensions > 3)
				throw new ManagedExportError('tar-metadata-limit');
			this.extendedType = type;
			this.extended = [];
			this.remaining = rawSize;
			this.padding = (512 - (rawSize % 512)) % 512;
			return;
		}
		if (!['0', '2', '3', '4', '5', '6'].includes(type))
			throw new ManagedExportError('tar-extension-unsupported');
		const pax = this.pax || {};
		let name = field(h.subarray(0, 100));
		if (magic === 'ustar\0') {
			const prefix = field(h.subarray(345, 500));
			if (prefix) name = prefix + '/' + name;
		}
		if ((this.longName && pax.path) || (this.longLink && pax.linkpath)) invalid();
		name = pax.path ?? this.longName ?? name;
		if (type === '5' && name.endsWith('/')) name = name.slice(0, -1);
		if (name.startsWith('/')) invalid();
		const filePath = managedSnapshotPath('/' + name);
		const indexed = this.index.get(filePath);
		if (!indexed) throw new ManagedExportError('archive-entry-mismatch');
		if (
			type !==
			(
				{ file: '0', dir: '5', symlink: '2', chardev: '3', dev: '4', fifo: '6' } as Record<
					string,
					string
				>
			)[indexed.type]
		)
			throw new ManagedExportError('archive-entry-mismatch');
		this.proof.seen(this.cursor, filePath);
		const size = pax.size === undefined ? rawSize : decimal(pax.size);
		if (pax.size !== undefined && rawSize !== 0 && rawSize !== size) invalid();
		const linkname = pax.linkpath ?? this.longLink ?? field(h.subarray(157, 257));
		if ((type !== '0' && size !== 0) || (type !== '2' && linkname)) invalid();
		const selected = exportIncludes(this.proof.mode, indexed.type);
		if (selected) {
			if (
				type !== ({ file: '0', dir: '5', symlink: '2' } as Record<string, string>)[indexed.type] ||
				(indexed.type === 'file' && size !== indexed.size)
			)
				throw new ManagedExportError('archive-entry-mismatch');
			if (indexed.type === 'symlink') assertManagedLinkTarget(filePath, linkname);
			const extra: Record<string, string> = {};
			if (magic === 'ustar ') {
				if (number(h.subarray(369, 381)) || h.subarray(381).some(value => value !== 0))
					throw new ManagedExportError('tar-extension-unsupported');
				extra.atime = String(number(h.subarray(345, 357), true));
				extra.ctime = String(number(h.subarray(357, 369), true));
			}
			for (const key of Object.keys(pax).sort()) {
				if (['path', 'linkpath', 'size', 'uid', 'gid', 'uname', 'gname'].includes(key)) continue;
				if (['mtime', 'atime', 'ctime'].includes(key)) timestamp(pax[key]);
				extra[key] = pax[key];
			}
			const mtime =
				pax.mtime === undefined
					? new Date(number(h.subarray(136, 148), true) * 1000)
					: timestamp(pax.mtime);
			if (!Number.isFinite(mtime.getTime())) invalid();
			const metadata: Metadata = {
				name,
				type: indexed.type === 'dir' ? 'directory' : (indexed.type as 'file' | 'symlink'),
				size,
				mode: number(h.subarray(100, 108)),
				uid: pax.uid === undefined ? number(h.subarray(108, 116)) : decimal(pax.uid),
				gid: pax.gid === undefined ? number(h.subarray(116, 124)) : decimal(pax.gid),
				mtime: mtime.toISOString(),
				uname: pax.uname ?? field(h.subarray(265, 297)),
				gname: pax.gname ?? field(h.subarray(297, 329)),
				...(indexed.type === 'symlink' ? { linkname } : {}),
				...(Object.keys(extra).length ? { pax: extra } : {}),
			};
			if (
				metadata.mode > 0o7777 ||
				metadata.uid > 0xffffffff ||
				metadata.gid > 0xffffffff ||
				metadata.uname.length > 256 ||
				metadata.gname.length > 256
			)
				invalid();
			this.entry = {
				path: filePath,
				type: indexed.type as ManagedExportEntry['type'],
				size,
				...(indexed.type === 'symlink' ? { linkTarget: linkname } : {}),
				metadata: JSON.stringify({ ...metadata, name: undefined }),
			};
			if (this.compare && this.proof.get(filePath)?.metadata !== this.entry.metadata)
				throw new ManagedExportError('archive-content-mismatch');
			this.hash = indexed.type === 'file' ? crypto.createHash('sha256') : undefined;
			this.outputDone = new Promise<void>((resolve, reject) => {
				this.output = this.pack.entry(packedHeader(metadata), error =>
					error ? reject(error) : resolve()
				);
				this.output.on('error', () => undefined); // callback/pipeline carry the closed failure
			});
			void this.outputDone.catch(() => undefined);
		} else {
			this.entry = undefined;
			this.hash = undefined;
			this.output = undefined;
		}
		this.remaining = size;
		this.padding = (512 - (size % 512)) % 512;
		this.pax = undefined;
		this.longName = undefined;
		this.longLink = undefined;
		this.extensions = 0;
		this.extensionBytes = 0;
		if (!size) await this.finishEntry();
	}
	private async finishEntry() {
		if (this.extendedType) {
			const payload = Buffer.concat(this.extended);
			if (this.extendedType === 'x') {
				if (this.pax) invalid();
				this.pax = paxRecords(payload);
			} else {
				if (payload.at(-1) !== 0 || payload.subarray(0, -1).includes(0)) invalid();
				const value = text(payload.subarray(0, -1));
				if (this.extendedType === 'L') {
					if (this.longName) invalid();
					this.longName = value;
				} else {
					if (this.longLink) invalid();
					this.longLink = value;
				}
			}
			this.extendedType = '';
			this.extended = [];
		} else if (this.entry) {
			if (this.hash) this.entry.sha256 = this.hash.digest('hex');
			if (this.compare) {
				if (this.proof.get(this.entry.path)?.sha256 !== this.entry.sha256)
					throw new ManagedExportError('archive-content-mismatch');
			} else this.proof.append(this.entry);
			this.output!.end();
			await this.outputDone;
			this.included++;
			this.entry = undefined;
			this.output = undefined;
			this.hash = undefined;
		}
	}
	finish() {
		if (
			this.headerBytes ||
			this.remaining ||
			this.padding ||
			this.zeroHeaders < 2 ||
			this.rawBytes % 512 ||
			this.extensions ||
			this.extendedType
		)
			invalid();
		this.proof.flush();
		const expected =
			this.proof.summary?.includedEntries ??
			Object.entries(this.proof.counts).reduce(
				(sum, [type, n]) => sum + (exportIncludes(this.proof.mode, type) ? n : 0),
				0
			);
		if (this.included !== expected) throw new ManagedExportError('archive-incomplete');
		if (!this.compare) this.proof.validateCompleteness();
	}
}

/** Shared verified stream contract for native download and future durable export
 * consumers. Preparation discards canonical bytes after hashing; transfer checks
 * every selected entry against that immutable proof before writing its TAR footer. */
async function runManagedExport(
	index: ManagedSnapshotIndex,
	session: ManagedRepositorySession,
	proof: ManagedExportProof,
	destination: Writable,
	signal: AbortSignal,
	compare = true
): Promise<ManagedExportSummary> {
	index.assertExportEntries(proof.mode);
	if (compare && !proof.summary) throw new ManagedExportError('export-proof-missing');
	if (!compare) proof.reset();
	const pack = tar.pack();
	const hash = crypto.createHash('sha256');
	let bytes = 0;
	const meter = new Transform({
		transform(chunk, _encoding, done) {
			bytes += chunk.length;
			if (!Number.isSafeInteger(bytes)) {
				done(new ManagedExportError('tar-invalid'));
				return;
			}
			hash.update(chunk);
			done(null, chunk);
		},
	});
	const reader = new TarReader(index, proof, pack, compare, signal);
	let validationFailure: unknown;
	const input = new Writable({
		write(chunk, _encoding, done) {
			reader.consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).then(
				() => done(),
				error => {
					validationFailure = error;
					done(error);
				}
			);
		},
	});
	input.on('error', () => undefined);
	const output = pipeline(pack, meter, destination, { end: false, signal });
	void output.catch(error => input.destroy(error));
	try {
		await session.archive(proof.binding.snapshotId, input);
		input.end();
		await finished(input);
		reader.finish();
		pack.finalize();
		await output;
		const digest = hash.digest('hex');
		if (compare) {
			if (proof.summary!.archiveSha256 !== digest || proof.summary!.archiveBytes !== bytes)
				throw new ManagedExportError('archive-content-mismatch');
			return proof.summary!;
		}
		return proof.finish(digest, bytes);
	} catch (error) {
		const failure =
			validationFailure instanceof Error
				? validationFailure
				: error instanceof Error
					? error
					: new ManagedExportError('tar-invalid');
		input.destroy(failure);
		pack.destroy(failure);
		meter.destroy(failure);
		destination.destroy(failure);
		await output.catch(() => undefined);
		throw validationFailure || error;
	} finally {
		reader.close();
	}
}

export async function prepareManagedExport(
	index: ManagedSnapshotIndex,
	session: ManagedRepositorySession,
	proof: ManagedExportProof,
	signal: AbortSignal
) {
	if (proof.summary) return proof.summary;
	return runManagedExport(
		index,
		session,
		proof,
		new Writable({
			write(_chunk, _encoding, done) {
				done();
			},
		}),
		signal,
		false
	);
}

/** Consumers cannot bypass comparison with the completed preparation proof. */
export function streamManagedExport(
	index: ManagedSnapshotIndex,
	session: ManagedRepositorySession,
	proof: ManagedExportProof,
	destination: Writable,
	signal: AbortSignal
): Promise<ManagedExportSummary> {
	return runManagedExport(index, session, proof, destination, signal, true);
}

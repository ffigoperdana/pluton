import crypto from 'crypto';
import { Writable } from 'stream';
import { S2Error, S2StreamDecoder } from './s2';
import { bitrotFileSize, type XlPart, type XlVersion } from './xlMeta';

const HASH_BYTES = 32;

export type MinioObjectFailure =
	| 'not-supported'
	| 'inline-missing'
	| 'stored-size'
	| 'decoded-size'
	| 'compressed-data'
	| 'etag-mismatch';

export class MinioObjectError extends Error {
	constructor(readonly reason: MinioObjectFailure) {
		super(`MinIO object ${reason}`);
	}
}

/** Removes the 32-byte bitrot hash in front of every shard block of a part file. */
class BitrotStripper {
	private hashLeft = 0;
	private dataLeft = 0;
	private remaining: number;

	constructor(
		size: number,
		private readonly shardSize: number,
		private readonly emit: (chunk: Buffer) => void
	) {
		this.remaining = size;
		this.next();
	}

	write(chunk: Buffer) {
		let position = 0;
		while (position < chunk.length) {
			if (this.hashLeft) {
				const skipped = Math.min(this.hashLeft, chunk.length - position);
				this.hashLeft -= skipped;
				position += skipped;
				continue;
			}
			if (!this.dataLeft) throw new MinioObjectError('stored-size');
			const taken = Math.min(this.dataLeft, chunk.length - position);
			this.emit(chunk.subarray(position, position + taken));
			this.dataLeft -= taken;
			this.remaining -= taken;
			position += taken;
			if (!this.dataLeft) this.next();
		}
	}

	end() {
		if (this.remaining || this.hashLeft || this.dataLeft) throw new MinioObjectError('stored-size');
	}

	private next() {
		if (this.remaining > 0) {
			this.hashLeft = HASH_BYTES;
			this.dataLeft = Math.min(this.shardSize, this.remaining);
		}
	}
}

/** Size of the stored (bitrot-protected) data of one part. */
export function storedPartSize(version: XlVersion, part: XlPart): number {
	return bitrotFileSize(part.size, version.blockSize);
}

/** Path of a part file below the object folder. */
export function partPath(objectDirectory: string, version: XlVersion, part: XlPart): string {
	if (!version.dataDir) throw new MinioObjectError('not-supported');
	return `${objectDirectory}/${version.dataDir}/part.${part.number}`;
}

const write = (output: Writable, chunk: Buffer) =>
	new Promise<void>((resolve, reject) => {
		output.write(chunk, error => (error ? reject(error) : resolve()));
	});

/**
 * Streams the original bytes of one supported version to `output` and verifies
 * them against the stored ETag (MD5, or MD5 of part MD5s for multipart
 * uploads) and every recorded size. The last chunk is held back until the
 * verification succeeds, so a failed check never leaves complete output.
 */
export async function streamMinioVersion(
	version: XlVersion,
	inline: Buffer | undefined,
	readPart: (part: XlPart, sink: Writable) => Promise<void>,
	output: Writable,
	signal: AbortSignal
): Promise<{ bytes: number; etag: string }> {
	if (version.status !== 'supported' || !version.etag || !version.etagKind)
		throw new MinioObjectError('not-supported');
	if (version.inline && !inline) throw new MinioObjectError('inline-missing');
	const whole = crypto.createHash('md5');
	const partDigests: Buffer[] = [];
	let held: Buffer | undefined;
	let total = 0;

	const release = async (chunks: Buffer[]) => {
		for (const chunk of chunks) {
			signal.throwIfAborted();
			if (held) await write(output, held);
			held = chunk;
		}
	};

	for (const part of version.parts) {
		signal.throwIfAborted();
		const partHash = crypto.createHash('md5');
		let decoded = 0;
		let ready: Buffer[] = [];
		const accept = (chunk: Buffer) => {
			decoded += chunk.length;
			if (decoded > part.actualSize) throw new MinioObjectError('decoded-size');
			whole.update(chunk);
			partHash.update(chunk);
			ready.push(chunk);
		};
		const decoder = version.compression ? new S2StreamDecoder(accept) : undefined;
		const stripper = new BitrotStripper(
			part.size,
			version.blockSize,
			decoder ? chunk => decoder.write(chunk) : accept
		);
		let stored = 0;
		const expected = storedPartSize(version, part);
		const feed = (chunk: Buffer) => {
			stored += chunk.length;
			if (stored > expected) throw new MinioObjectError('stored-size');
			try {
				stripper.write(chunk);
			} catch (error) {
				throw error instanceof S2Error ? new MinioObjectError('compressed-data') : error;
			}
			const chunks = ready;
			ready = [];
			return chunks;
		};
		const finish = () => {
			try {
				stripper.end();
				decoder?.end();
			} catch (error) {
				throw error instanceof S2Error ? new MinioObjectError('compressed-data') : error;
			}
			if (stored !== expected) throw new MinioObjectError('stored-size');
			const chunks = ready;
			ready = [];
			return chunks;
		};
		if (version.inline) {
			if (inline!.length !== expected) throw new MinioObjectError('stored-size');
			await release(feed(inline!));
		} else {
			let failure: unknown;
			const sink = new Writable({
				write(chunk: Buffer, _encoding, done) {
					let chunks: Buffer[];
					try {
						chunks = feed(chunk);
					} catch (error) {
						failure = error;
						return done(error as Error);
					}
					release(chunks).then(
						() => done(),
						error => {
							failure = error;
							done(error);
						}
					);
				},
			});
			sink.on('error', () => undefined);
			try {
				await readPart(part, sink);
			} catch (error) {
				throw failure ?? error;
			} finally {
				sink.destroy();
			}
			if (failure) throw failure;
		}
		await release(finish());
		if (decoded !== part.actualSize) throw new MinioObjectError('decoded-size');
		partDigests.push(partHash.digest());
		total += decoded;
	}

	if (total !== version.size) throw new MinioObjectError('decoded-size');
	const etag =
		version.etagKind === 'md5'
			? whole.digest('hex')
			: `${crypto.createHash('md5').update(Buffer.concat(partDigests)).digest('hex')}-${partDigests.length}`;
	if (etag !== version.etag) throw new MinioObjectError('etag-mismatch');
	signal.throwIfAborted();
	if (held) await write(output, held);
	return { bytes: total, etag };
}

/**
 * Streaming decoder for the S2 framing format (klauspost/compress/s2), which
 * MinIO uses for compressed objects. S2 extends Snappy, so Snappy-framed
 * streams decode too. Written from the public S2 and Snappy framing
 * specifications. Every data chunk's masked CRC-32C is checked.
 */
export class S2Error extends Error {
	constructor(readonly reason: 'corrupt' | 'checksum' | 'unsupported' | 'truncated') {
		super(`compressed data ${reason}`);
	}
}

/** Largest block an S2 writer produces (and Snappy's 64 KiB fits below it). */
const MAX_BLOCK = 4 * 1024 * 1024;
const MAX_CHUNK = MAX_BLOCK + 1024;

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

export function crc32c(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

const masked = (crc: number) => ((((crc >>> 15) | (crc << 17)) >>> 0) + 0xa282ead8) >>> 0;

/** Decodes one S2 (or Snappy) block. */
export function decodeS2Block(src: Buffer): Buffer {
	let s = 0;
	let length = 0;
	for (let shift = 0; ; shift += 7) {
		if (s >= src.length || shift > 28) throw new S2Error('corrupt');
		const byte = src[s++];
		length += (byte & 0x7f) * 2 ** shift;
		if (byte < 0x80) break;
	}
	if (length > MAX_BLOCK) throw new S2Error('corrupt');
	const dst = Buffer.allocUnsafe(length);
	let d = 0;
	let offset = 0;
	const need = (bytes: number) => {
		if (s + bytes > src.length) throw new S2Error('corrupt');
	};
	while (s < src.length) {
		const tag = src[s];
		let copy: number;
		switch (tag & 0x03) {
			case 0: {
				let x = tag >> 2;
				if (x < 60) s += 1;
				else {
					const bytes = x - 59;
					need(1 + bytes);
					x = src.readUIntLE(s + 1, bytes);
					s += 1 + bytes;
				}
				const literal = x + 1;
				if (s + literal > src.length || d + literal > length) throw new S2Error('corrupt');
				src.copy(dst, d, s, s + literal);
				d += literal;
				s += literal;
				continue;
			}
			case 1: {
				need(2);
				const code = (tag >> 2) & 0x07;
				const distance = ((tag & 0xe0) << 3) | src[s + 1];
				s += 2;
				if (distance === 0) {
					// S2 repeat: copy again from the previous offset.
					if (code === 5) {
						need(1);
						copy = src[s] + 4;
						s += 1;
					} else if (code === 6) {
						need(2);
						copy = src.readUInt16LE(s) + (1 << 8);
						s += 2;
					} else if (code === 7) {
						need(3);
						copy = src.readUIntLE(s, 3) + (1 << 16);
						s += 3;
					} else copy = code;
				} else {
					offset = distance;
					copy = code;
				}
				copy += 4;
				break;
			}
			case 2:
				need(3);
				copy = 1 + (tag >> 2);
				offset = src.readUInt16LE(s + 1);
				s += 3;
				break;
			default:
				need(5);
				copy = 1 + (tag >> 2);
				offset = src.readUInt32LE(s + 1);
				s += 5;
		}
		if (offset <= 0 || d < offset || copy > length - d) throw new S2Error('corrupt');
		if (offset >= copy) dst.copyWithin(d, d - offset, d - offset + copy);
		else for (let i = 0; i < copy; i++) dst[d + i] = dst[d - offset + i];
		d += copy;
	}
	if (d !== length) throw new S2Error('corrupt');
	return dst;
}

const IDENTIFIERS = new Set(['S2sTwO', 'sNaPpY']);

export class S2StreamDecoder {
	private buffer: Buffer = Buffer.alloc(0);
	private started = false;
	private received = false;

	constructor(private readonly emit: (chunk: Buffer) => void) {}

	write(chunk: Buffer) {
		if (!chunk.length) return;
		this.received = true;
		this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
		let position = 0;
		while (this.buffer.length - position >= 4) {
			const type = this.buffer[position];
			const length = this.buffer.readUIntLE(position + 1, 3);
			if (length > MAX_CHUNK && type < 0x80) throw new S2Error('corrupt');
			if (this.buffer.length - position - 4 < length) break;
			const body = this.buffer.subarray(position + 4, position + 4 + length);
			position += 4 + length;
			this.chunk(type, body);
		}
		this.buffer = position ? Buffer.from(this.buffer.subarray(position)) : this.buffer;
	}

	end() {
		if (this.buffer.length) throw new S2Error('truncated');
		if (this.received && !this.started) throw new S2Error('corrupt');
	}

	private chunk(type: number, body: Buffer) {
		if (type === 0xff) {
			if (body.length !== 6 || !IDENTIFIERS.has(body.toString('latin1')))
				throw new S2Error('unsupported');
			this.started = true;
			return;
		}
		if (!this.started) throw new S2Error('corrupt');
		if (type === 0x00 || type === 0x01) {
			if (body.length < 4) throw new S2Error('corrupt');
			const expected = body.readUInt32LE(0);
			const data = type === 0x00 ? decodeS2Block(body.subarray(4)) : Buffer.from(body.subarray(4));
			if (data.length > MAX_BLOCK) throw new S2Error('corrupt');
			if (masked(crc32c(data)) !== expected) throw new S2Error('checksum');
			if (data.length) this.emit(data);
			return;
		}
		// Padding (0xfe) and skippable chunks such as the S2 seek index (0x99).
		if (type >= 0x80) return;
		throw new S2Error('unsupported');
	}
}

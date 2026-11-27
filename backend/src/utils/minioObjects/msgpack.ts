/**
 * A bounded MessagePack reader for MinIO metadata. It reads in place (byte
 * values are subarrays of the input), never allocates more than the input
 * describes and throws MsgpackError on anything truncated or unexpected.
 */
export class MsgpackError extends Error {}

const MAX_DEPTH = 32;

export class MsgpackReader {
	private position = 0;

	constructor(private readonly buffer: Buffer) {}

	get offset() {
		return this.position;
	}

	get remaining() {
		return this.buffer.length - this.position;
	}

	/** The bytes after the current position. */
	rest(): Buffer {
		return this.buffer.subarray(this.position);
	}

	peek(): number {
		this.need(1);
		return this.buffer[this.position];
	}

	isNil(): boolean {
		return this.remaining > 0 && this.buffer[this.position] === 0xc0;
	}

	nil(): void {
		if (this.byte() !== 0xc0) throw new MsgpackError('expected nil');
	}

	bool(): boolean {
		const tag = this.byte();
		if (tag === 0xc2) return false;
		if (tag === 0xc3) return true;
		throw new MsgpackError('expected bool');
	}

	mapHeader(): number {
		const tag = this.byte();
		if (tag >= 0x80 && tag <= 0x8f) return tag & 0x0f;
		if (tag === 0xde) return this.uint(2);
		if (tag === 0xdf) return this.uint(4);
		throw new MsgpackError('expected map');
	}

	arrayHeader(): number {
		const tag = this.byte();
		if (tag >= 0x90 && tag <= 0x9f) return tag & 0x0f;
		if (tag === 0xdc) return this.uint(2);
		if (tag === 0xdd) return this.uint(4);
		throw new MsgpackError('expected array');
	}

	/** A str value, or a bin value holding UTF-8 (msgp writes some keys either way). */
	str(): string {
		const tag = this.peek();
		if (tag >= 0xc4 && tag <= 0xc6) return this.bin().toString('utf8');
		this.position++;
		let length: number;
		if (tag >= 0xa0 && tag <= 0xbf) length = tag & 0x1f;
		else if (tag === 0xd9) length = this.uint(1);
		else if (tag === 0xda) length = this.uint(2);
		else if (tag === 0xdb) length = this.uint(4);
		else throw new MsgpackError('expected str');
		return this.take(length).toString('utf8');
	}

	/** A bin value; str values are accepted as their UTF-8 bytes. */
	bin(): Buffer {
		const tag = this.byte();
		let length: number;
		if (tag === 0xc4) length = this.uint(1);
		else if (tag === 0xc5) length = this.uint(2);
		else if (tag === 0xc6) length = this.uint(4);
		else if (tag >= 0xa0 && tag <= 0xbf) length = tag & 0x1f;
		else if (tag === 0xd9) length = this.uint(1);
		else if (tag === 0xda) length = this.uint(2);
		else if (tag === 0xdb) length = this.uint(4);
		else throw new MsgpackError('expected bin');
		return this.take(length);
	}

	/** Any integer as a bigint. */
	bigint(): bigint {
		const tag = this.byte();
		if (tag <= 0x7f) return BigInt(tag);
		if (tag >= 0xe0) return BigInt(tag - 0x100);
		const read = (length: number, signed: boolean) => {
			const bytes = this.take(length);
			if (length === 8) return signed ? bytes.readBigInt64BE(0) : bytes.readBigUInt64BE(0);
			const value = signed ? bytes.readIntBE(0, length) : bytes.readUIntBE(0, length);
			return BigInt(value);
		};
		switch (tag) {
			case 0xcc:
				return read(1, false);
			case 0xcd:
				return read(2, false);
			case 0xce:
				return read(4, false);
			case 0xcf:
				return read(8, false);
			case 0xd0:
				return read(1, true);
			case 0xd1:
				return read(2, true);
			case 0xd2:
				return read(4, true);
			case 0xd3:
				return read(8, true);
		}
		throw new MsgpackError('expected integer');
	}

	/** Any integer that fits a JavaScript safe integer. */
	int(): number {
		const value = this.bigint();
		if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
			throw new MsgpackError('integer out of range');
		return Number(value);
	}

	/** A uint32 value (the xl.meta CRC is written as msgp uint32). */
	uint32(): number {
		const value = this.bigint();
		if (value < 0n || value > 0xffffffffn) throw new MsgpackError('expected uint32');
		return Number(value);
	}

	/** Skips one value of any type, nested at most MAX_DEPTH deep. */
	skip(depth = 0): void {
		if (depth > MAX_DEPTH) throw new MsgpackError('nesting too deep');
		const tag = this.peek();
		if (tag <= 0x7f || tag >= 0xe0 || tag === 0xc0 || tag === 0xc2 || tag === 0xc3) {
			this.position++;
			return;
		}
		if ((tag >= 0x80 && tag <= 0x8f) || tag === 0xde || tag === 0xdf) {
			const entries = this.mapHeader();
			for (let i = 0; i < entries * 2; i++) this.skip(depth + 1);
			return;
		}
		if ((tag >= 0x90 && tag <= 0x9f) || tag === 0xdc || tag === 0xdd) {
			const items = this.arrayHeader();
			for (let i = 0; i < items; i++) this.skip(depth + 1);
			return;
		}
		if (
			(tag >= 0xa0 && tag <= 0xbf) ||
			(tag >= 0xc4 && tag <= 0xc6) ||
			(tag >= 0xd9 && tag <= 0xdb)
		) {
			this.bin();
			return;
		}
		if ((tag >= 0xcc && tag <= 0xcf) || (tag >= 0xd0 && tag <= 0xd3)) {
			this.bigint();
			return;
		}
		this.position++;
		switch (tag) {
			case 0xca:
				this.take(4);
				return;
			case 0xcb:
				this.take(8);
				return;
			case 0xd4:
				this.take(2);
				return;
			case 0xd5:
				this.take(3);
				return;
			case 0xd6:
				this.take(5);
				return;
			case 0xd7:
				this.take(9);
				return;
			case 0xd8:
				this.take(17);
				return;
			case 0xc7:
				this.take(this.uint(1) + 1);
				return;
			case 0xc8:
				this.take(this.uint(2) + 1);
				return;
			case 0xc9:
				this.take(this.uint(4) + 1);
				return;
		}
		throw new MsgpackError('unknown type');
	}

	private byte(): number {
		this.need(1);
		return this.buffer[this.position++];
	}

	private uint(length: number): number {
		return this.take(length).readUIntBE(0, length);
	}

	private take(length: number): Buffer {
		this.need(length);
		const value = this.buffer.subarray(this.position, this.position + length);
		this.position += length;
		return value;
	}

	private need(length: number) {
		if (length < 0 || this.position + length > this.buffer.length)
			throw new MsgpackError('truncated');
	}
}

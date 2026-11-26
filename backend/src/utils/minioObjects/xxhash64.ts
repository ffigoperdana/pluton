/**
 * xxHash64 (seed 0), written from the public xxHash specification. MinIO stores
 * the low 32 bits of xxHash64 of the xl.meta metadata block as its CRC. Inputs
 * are small (one object's metadata), so BigInt arithmetic is fast enough.
 */
const MASK = (1n << 64n) - 1n;
const P1 = 11400714785074694791n;
const P2 = 14029467366897019727n;
const P3 = 1609587929392839161n;
const P4 = 9650029242287828579n;
const P5 = 2870177450012600261n;

const rotl = (value: bigint, bits: bigint) => ((value << bits) | (value >> (64n - bits))) & MASK;
const round = (accumulator: bigint, lane: bigint) =>
	(rotl((accumulator + lane * P2) & MASK, 31n) * P1) & MASK;
const merge = (accumulator: bigint, value: bigint) =>
	((accumulator ^ round(0n, value)) * P1 + P4) & MASK;

export function xxhash64(input: Uint8Array, seed = 0n): bigint {
	const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
	const length = buffer.length;
	let position = 0;
	let hash: bigint;
	if (length >= 32) {
		let v1 = (seed + P1 + P2) & MASK;
		let v2 = (seed + P2) & MASK;
		let v3 = seed & MASK;
		let v4 = (seed - P1) & MASK;
		while (position + 32 <= length) {
			v1 = round(v1, buffer.readBigUInt64LE(position));
			v2 = round(v2, buffer.readBigUInt64LE(position + 8));
			v3 = round(v3, buffer.readBigUInt64LE(position + 16));
			v4 = round(v4, buffer.readBigUInt64LE(position + 24));
			position += 32;
		}
		hash = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK;
		hash = merge(hash, v1);
		hash = merge(hash, v2);
		hash = merge(hash, v3);
		hash = merge(hash, v4);
	} else hash = (seed + P5) & MASK;
	hash = (hash + BigInt(length)) & MASK;
	while (position + 8 <= length) {
		hash = (rotl(hash ^ round(0n, buffer.readBigUInt64LE(position)), 27n) * P1 + P4) & MASK;
		position += 8;
	}
	if (position + 4 <= length) {
		hash =
			(rotl(hash ^ ((BigInt(buffer.readUInt32LE(position)) * P1) & MASK), 23n) * P2 + P3) & MASK;
		position += 4;
	}
	while (position < length) {
		hash = (rotl(hash ^ ((BigInt(buffer[position]) * P5) & MASK), 11n) * P1) & MASK;
		position++;
	}
	hash ^= hash >> 33n;
	hash = (hash * P2) & MASK;
	hash ^= hash >> 29n;
	hash = (hash * P3) & MASK;
	hash ^= hash >> 32n;
	return hash;
}

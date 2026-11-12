import crypto from 'crypto';
import path from 'path';
import { AppError } from '../AppError';

/** Closed failure vocabulary. Provider text, paths and credentials are never returned. */
export type RelocationFailureCode =
	| 'unexpected-repository-file'
	| 'repository-incomplete'
	| 'source-missing'
	| 'destination-not-empty'
	| 'destination-listing-mismatch'
	| 'destination-hash-mismatch'
	| 'destination-conflict'
	| 'destination-full'
	| 'source-changed'
	| 'destination-changed'
	| 'repository-identity-mismatch'
	| 'snapshot-set-mismatch'
	| 'snapshot-missing'
	| 'restic-check-failed'
	| 'copy-failed'
	| 'network-unavailable'
	| 'authentication-denied'
	| 'host-verification-failed'
	| 'wrong-password'
	| 'repository-unavailable'
	| 'timeout'
	| 'cancelled'
	| 'invalid-output'
	| 'output-limit'
	| 'execution-failed'
	| 'configuration-invalid'
	| 'server-restarted'
	| 'plan-busy'
	| 'source-delete-failed';

export class RelocationError extends AppError {
	constructor(
		readonly code: RelocationFailureCode,
		statusCode = 409
	) {
		super(statusCode, `Repository relocation failed safely (${code}).`);
		Object.setPrototypeOf(this, RelocationError.prototype);
	}
}

export type InventoryEntry = { path: string; size: number };
export type RepositoryInventory = {
	entries: InventoryEntry[];
	fileCount: number;
	totalBytes: number;
	/** SHA-256 over the sorted `path\tsize` lines. Identifies the exact file set. */
	digest: string;
};
export type RepositoryFileClass = 'config' | 'key' | 'snapshot' | 'index' | 'data' | 'lock';

const ID = /^[a-f0-9]{64}$/;

/**
 * A Restic repository holds only `config` and content-addressed files. Rclone
 * upload temporaries end with `.partial`. Anything else is not ours to move.
 */
export function classifyRepositoryPath(value: string): RepositoryFileClass | 'partial' | undefined {
	if (value.endsWith('.partial')) return 'partial';
	if (value === 'config') return 'config';
	const parts = value.split('/');
	if (parts.length === 2 && ID.test(parts[1])) {
		if (parts[0] === 'keys') return 'key';
		if (parts[0] === 'snapshots') return 'snapshot';
		if (parts[0] === 'index') return 'index';
		if (parts[0] === 'locks') return 'lock';
	}
	if (
		parts.length === 3 &&
		parts[0] === 'data' &&
		/^[a-f0-9]{2}$/.test(parts[1]) &&
		ID.test(parts[2]) &&
		parts[2].startsWith(parts[1])
	)
		return 'data';
	return undefined;
}

export type RawListingEntry = { Path?: unknown; Size?: unknown; IsDir?: unknown };

/**
 * Builds the authoritative file set from `rclone lsjson -R --files-only`.
 * Locks are excluded (never copied). `partial` collects Rclone temporaries so a
 * retry can remove them from its own destination; elsewhere they are rejected.
 */
export function buildInventory(
	raw: unknown,
	options: { allowPartial?: boolean; requireRepository?: boolean } = {}
): RepositoryInventory & { partial: string[] } {
	if (!Array.isArray(raw)) throw new RelocationError('invalid-output');
	const entries: InventoryEntry[] = [];
	const partial: string[] = [];
	const seen = new Set<string>();
	for (const item of raw as RawListingEntry[]) {
		if (!item || typeof item !== 'object') throw new RelocationError('invalid-output');
		if (item.IsDir === true) continue;
		if (typeof item.Path !== 'string' || typeof item.Size !== 'number')
			throw new RelocationError('invalid-output');
		if (!Number.isSafeInteger(item.Size) || item.Size < 0)
			throw new RelocationError('invalid-output');
		const kind = classifyRepositoryPath(item.Path);
		if (kind === 'lock') continue;
		if (kind === 'partial') {
			if (!options.allowPartial) throw new RelocationError('unexpected-repository-file');
			partial.push(item.Path);
			continue;
		}
		if (!kind) throw new RelocationError('unexpected-repository-file');
		if (seen.has(item.Path)) throw new RelocationError('invalid-output');
		seen.add(item.Path);
		entries.push({ path: item.Path, size: item.Size });
	}
	if (options.requireRepository !== false) {
		if (!seen.has('config') || !entries.some(entry => classifyRepositoryPath(entry.path) === 'key'))
			throw new RelocationError('repository-incomplete');
	}
	return { ...summarize(entries), partial };
}

export function summarize(entries: InventoryEntry[]): RepositoryInventory {
	const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const hash = crypto.createHash('sha256');
	let totalBytes = 0;
	for (const entry of sorted) {
		hash.update(`${entry.path}\t${entry.size}\n`);
		totalBytes += entry.size;
	}
	return {
		entries: sorted,
		fileCount: sorted.length,
		totalBytes,
		digest: hash.digest('hex'),
	};
}

/** Every file of `part` exists in `whole` with the same size (no foreign files). */
export function isSubsetOf(part: InventoryEntry[], whole: InventoryEntry[]) {
	const sizes = new Map(whole.map(entry => [entry.path, entry.size]));
	return part.every(entry => sizes.get(entry.path) === entry.size);
}

const HASH_LINE = /^([0-9a-fA-F]{64}|[A-Z]+[A-Za-z :-]*)\s{2}(.+)$/;

/** Parses one `rclone hashsum sha256` record. Rclone prints an error word instead of a hash. */
export function parseHashLine(line: string): { hash: string; path: string } {
	const match = HASH_LINE.exec(line.replace(/\r$/, ''));
	if (!match) throw new RelocationError('invalid-output');
	return { hash: match[1].toLowerCase(), path: match[2] };
}

/**
 * Restic names every file except `config` by the SHA-256 of its content, so a
 * downloaded hash proves each destination byte. `config` is compared with the
 * source digest. Every inventoried file must be hashed exactly once.
 */
export class HashVerification {
	private readonly expected: Map<string, number>;
	private readonly verified = new Set<string>();
	constructor(
		inventory: RepositoryInventory,
		private readonly configSha256: string
	) {
		this.expected = new Map(inventory.entries.map(entry => [entry.path, entry.size]));
	}
	get count() {
		return this.verified.size;
	}
	accept(line: string) {
		const record = parseHashLine(line);
		const kind = classifyRepositoryPath(record.path);
		if (kind === 'lock') return;
		if (!this.expected.has(record.path) || this.verified.has(record.path))
			throw new RelocationError('destination-listing-mismatch');
		const name = path.posix.basename(record.path);
		const valid = kind === 'config' ? record.hash === this.configSha256 : record.hash === name;
		if (!valid) throw new RelocationError('destination-hash-mismatch');
		this.verified.add(record.path);
	}
	finish() {
		if (this.verified.size !== this.expected.size)
			throw new RelocationError('destination-hash-mismatch');
	}
}

/** Same normalization as Storage removal scope; Windows drive letters are case-insensitive. */
export function normalizeLocationPath(value: string): string {
	const slash = value.replace(/\\/g, '/');
	const normalized = path.posix.normalize(slash).replace(/\/$/, '');
	return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function locationsOverlap(a: string, b: string) {
	const left = normalizeLocationPath(a),
		right = normalizeLocationPath(b);
	if (!left || !right || left === '.' || right === '.') return true;
	return left === right || left.startsWith(right + '/') || right.startsWith(left + '/');
}

/** A destination must be a concrete directory, never a Storage root or traversal. */
export function validateRelocationPath(value: unknown): string {
	if (typeof value !== 'string') throw new RelocationError('configuration-invalid', 400);
	const trimmed = value.trim();
	const normalized = normalizeLocationPath(trimmed);
	if (
		!trimmed ||
		trimmed !== value ||
		value.length > 4096 ||
		value.includes('\\') ||
		[...value].some(character => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f) ||
		value.split('/').includes('..') ||
		normalized === '' ||
		normalized === '.' ||
		normalized === '/' ||
		value.startsWith('-')
	)
		throw new RelocationError('configuration-invalid', 400);
	return value;
}

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

export const FIXTURES = path.join(__dirname, '..', '..', 'fixtures', 'minioObjects');

export type FixtureEntry = { path: string; type: 'file' | 'dir'; data: Buffer; mtime: Date };

/** Reads a fixture .tar.gz (ustar, GNU long names or pax paths) into memory. */
export function readFixtureArchive(
	name: string,
	root = '/srv/example-app/minio'
): Map<string, FixtureEntry> {
	const archive = zlib.gunzipSync(fs.readFileSync(path.join(FIXTURES, name)));
	const entries = new Map<string, FixtureEntry>();
	let position = 0;
	let longName: string | undefined;
	const field = (start: number, length: number) => {
		const bytes = archive.subarray(position + start, position + start + length);
		const end = bytes.indexOf(0);
		return bytes.subarray(0, end < 0 ? bytes.length : end).toString('utf8');
	};
	while (position + 512 <= archive.length) {
		if (archive.subarray(position, position + 512).every(byte => byte === 0)) break;
		const size = parseInt(field(124, 12).trim() || '0', 8);
		const type = field(156, 1) || '0';
		const prefix = field(345, 155);
		let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
		longName = undefined;
		const data = archive.subarray(position + 512, position + 512 + size);
		const mtime = new Date(parseInt(field(136, 12).trim(), 8) * 1000);
		position += 512 + Math.ceil(size / 512) * 512;
		if (type === 'L') {
			longName = data.toString('utf8').replace(/\0+$/, '');
			continue;
		}
		if (type === 'x') {
			const match = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
			if (match) longName = match[1];
			continue;
		}
		name = name.replace(/^\.\//, '').replace(/\/$/, '');
		if (!name || name === '.') continue;
		const full = `${root}/${name}`;
		if (type === '5') entries.set(full, { path: full, type: 'dir', data: Buffer.alloc(0), mtime });
		else if (type === '0' || type === '\0')
			entries.set(full, { path: full, type: 'file', data: Buffer.from(data), mtime });
		// Parents that tar did not list explicitly.
		for (
			let parent = path.posix.dirname(full);
			parent.length > 1 && !entries.has(parent);
			parent = path.posix.dirname(parent)
		)
			entries.set(parent, { path: parent, type: 'dir', data: Buffer.alloc(0), mtime });
	}
	return entries;
}

export type SourceFile = { file: string; size: number; md5: string; sha256: string };
export const sources: SourceFile[] = JSON.parse(
	fs.readFileSync(path.join(FIXTURES, 'sources.json'), 'utf8')
);
export const source = (file: string) => sources.find(entry => entry.file === file)!;

export type ListingRecord = {
	bucket: string;
	key: string;
	size: number;
	etag: string;
	versionId: string;
	versionOrdinal: number;
	isDeleteMarker?: boolean;
	lastModified: string;
	type: string;
};
export const listing: ListingRecord[] = fs
	.readFileSync(path.join(FIXTURES, 'listing.jsonl'), 'utf8')
	.split('\n')
	.filter(Boolean)
	.map(line => JSON.parse(line));

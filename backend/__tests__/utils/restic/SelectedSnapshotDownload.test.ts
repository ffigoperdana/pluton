import { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import tar from 'tar-stream';
import { streamSelectedSnapshot } from '../../../src/utils/restic/SelectedSnapshotDownload';
const binding = {
	backupId: 'backup-01',
	repositoryId: 'repository-01',
	snapshotId: 'a'.repeat(64),
};
const file = (p: string, type = 'file', size = 5) => ({
	path: p,
	name: p.split('/').pop(),
	type,
	size: type === 'file' ? size : 0,
	isDirectory: type === 'dir',
	modifiedAt: '2026-01-01T00:00:00Z',
});
const rows = [
	file('/srv', 'dir'),
	file('/srv/app', 'dir'),
	file('/srv/app/file.txt'),
	file('/srv/other.txt'),
];
const index = (entries = rows) =>
	({
		get: (p: string) => entries.find(f => f.path === p),
		[Symbol.iterator]: () => entries[Symbol.iterator](),
	}) as any;
function sink() {
	const chunks: Buffer[] = [];
	const output = new Writable({
		write(c, _e, done) {
			chunks.push(Buffer.from(c));
			done();
		},
	});
	output.on('error', () => {});
	return { output, chunks };
}
async function archive(
	entries: { path: string; body?: string; type?: string; linkname?: string }[]
) {
	const pack = tar.pack();
	for (const e of entries)
		pack.entry(
			{
				name: e.path.slice(1),
				type: (e.type || 'file') as any,
				size: e.type === 'symlink' ? 0 : Buffer.byteLength(e.body || ''),
				mtime: new Date('2026-01-01T00:00:00Z'),
				mode: 420,
				linkname: e.linkname,
			},
			Buffer.from(e.body || '')
		);
	pack.finalize();
	const chunks: Buffer[] = [];
	for await (const b of pack) chunks.push(b);
	return Buffer.concat(chunks);
}
const session = (body: Buffer) =>
	({
		dump: jest.fn(async (_id, _p, dest) => pipeline(Readable.from([body]), dest, { end: false })),
	}) as any;
describe('bounded selected snapshot download', () => {
	test('raw regular file preserves exact bytes and metadata; HEAD reads no contents', async () => {
		const s = session(Buffer.from('hello')),
			v = sink(),
			head = jest.fn();
		await streamSelectedSnapshot(
			index(),
			s,
			binding,
			'/srv/app/file.txt',
			v.output,
			new AbortController().signal,
			head,
			true
		);
		expect(s.dump).not.toHaveBeenCalled();
		expect(head).toHaveBeenCalledWith({
			fileName: 'file.txt',
			contentType: 'application/octet-stream',
			length: 5,
		});
		await streamSelectedSnapshot(
			index(),
			s,
			binding,
			'/srv/app/file.txt',
			v.output,
			new AbortController().signal,
			head
		);
		expect(Buffer.concat(v.chunks).toString()).toBe('hello');
		expect(s.dump).toHaveBeenCalledWith(
			binding.snapshotId,
			'/srv/app/file.txt',
			expect.any(Writable)
		);
	});
	test.each(['hell', 'too-long'])('wrong raw file byte count fails closed: %s', async body => {
		const v = sink();
		await expect(
			streamSelectedSnapshot(
				index(),
				session(Buffer.from(body)),
				binding,
				'/srv/app/file.txt',
				v.output,
				new AbortController().signal,
				() => {}
			)
		).rejects.toBeDefined();
	});
	test('directory exports only its descendants with strict TAR validation and ephemeral proof', async () => {
		const original = await archive([{ path: '/srv/app/file.txt', body: 'hello' }]),
			s = session(original),
			v = sink(),
			head = jest.fn();
		await streamSelectedSnapshot(
			index(),
			s,
			binding,
			'/srv/app',
			v.output,
			new AbortController().signal,
			head
		);
		expect(head).toHaveBeenCalledWith({ fileName: 'app.tar', contentType: 'application/x-tar' });
		const extract = tar.extract(),
			names: string[] = [],
			contents: string[] = [];
		extract.on('entry', (h, stream, next) => {
			names.push(h.name);
			let data = '';
			stream.on('data', b => (data += b));
			stream.on('end', () => {
				contents.push(data);
				next();
			});
		});
		await pipeline(Readable.from(v.chunks), extract);
		expect(names).toEqual(['srv/app/file.txt']);
		expect(contents).toEqual(['hello']);
	});
	test.each(['foreign-path', 'missing-entry', 'truncated', 'unsafe-link', 'graph-escape'])(
		'directory refuses %s without accepting a completed archive',
		async failure => {
			let body = await archive([
				{
					path: failure === 'foreign-path' ? '/srv/other.txt' : '/srv/app/file.txt',
					body: 'hello',
				},
			]);
			if (failure === 'missing-entry') body = await archive([]);
			if (failure === 'truncated') body = body.subarray(0, 600);
			let entries = rows;
			if (failure === 'unsafe-link' || failure === 'graph-escape') {
				entries = [
					...rows,
					file('/srv/app/escape', 'symlink'),
					...(failure === 'graph-escape' ? [file('/srv/app/up', 'symlink')] : []),
				];
				body = await archive([
					{ path: '/srv/app/file.txt', body: 'hello' },
					...(failure === 'graph-escape'
						? [{ path: '/srv/app/up', type: 'symlink', linkname: '../../' }]
						: []),
					{
						path: '/srv/app/escape',
						type: 'symlink',
						linkname: failure === 'unsafe-link' ? '../../../../outside' : 'up/../outside',
					},
				]);
			}
			const v = sink();
			await expect(
				streamSelectedSnapshot(
					index(entries),
					session(body),
					binding,
					'/srv/app',
					v.output,
					new AbortController().signal,
					() => {}
				)
			).rejects.toBeDefined();
			expect(v.output.destroyed).toBe(true);
			const partial = Buffer.concat(v.chunks);
			expect(partial.subarray(-1024).equals(Buffer.alloc(1024))).toBe(false);
		}
	);
	test.each(['/missing', '/srv/app/../other.txt', '//srv/app', '/srv/app\\escape'])(
		'unsafe/missing exact path never reaches provider: %s',
		async p => {
			const s = session(Buffer.from('hello')),
				v = sink();
			await expect(
				streamSelectedSnapshot(
					index(),
					s,
					binding,
					p,
					v.output,
					new AbortController().signal,
					() => {}
				)
			).rejects.toBeDefined();
			expect(s.dump).not.toHaveBeenCalled();
		}
	);
	test('symbolic links are not followed; special entries inside folders and pre-aborted requests fail before data reads', async () => {
		const s = session(Buffer.alloc(0)),
			v = sink();
		for (const type of ['symlink', 'socket', 'fifo'])
			await expect(
				streamSelectedSnapshot(
					index([file('/srv/item', type)]),
					s,
					binding,
					'/srv/item',
					v.output,
					new AbortController().signal,
					() => {}
				)
			).rejects.toBeDefined();
		await expect(
			streamSelectedSnapshot(
				index([...rows, file('/srv/app/pipe', 'fifo')]),
				s,
				binding,
				'/srv/app',
				v.output,
				new AbortController().signal,
				() => {}
			)
		).rejects.toBeDefined();
		const stop = new AbortController();
		stop.abort();
		await expect(
			streamSelectedSnapshot(index(), s, binding, '/srv/app', v.output, stop.signal, () => {})
		).rejects.toBeDefined();
		expect(s.dump).not.toHaveBeenCalled();
	});
	test('provider failure is propagated, with no successful transfer claim', async () => {
		const s = {
				dump: jest.fn(async () => {
					throw new Error('synthetic provider failure');
				}),
			} as any,
			v = sink();
		await expect(
			streamSelectedSnapshot(
				index(),
				s,
				binding,
				'/srv/app/file.txt',
				v.output,
				new AbortController().signal,
				() => {}
			)
		).rejects.toThrow('synthetic provider failure');
	});
});

/** Only fresh disposable Linux fixtures; never accepts repository or source inputs. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import tar from 'tar-stream';
const exec = promisify(execFile);
export const restic = '/usr/local/bin/restic',
	rclone = '/usr/local/bin/rclone';
export async function run(binary: string, args: string[], password?: string) {
	try {
		return (
			await exec(binary, args, {
				env: { ...process.env, ...(password ? { RESTIC_PASSWORD: password } : {}) },
				encoding: 'buffer',
				maxBuffer: 32 * 1024 ** 2,
				timeout: 30 * 60_000,
			})
		).stdout;
	} catch {
		throw new Error(`Disposable process failed (${path.basename(binary)}).`);
	}
}
export async function hashTree(root: string) {
	const entries: Record<string, any> = {};
	let bytes = 0;
	async function walk(directory: string): Promise<void> {
		for await (const entry of await fs.opendir(directory)) {
			const file = path.join(directory, entry.name),
				stat = await fs.lstat(file),
				relative = path.relative(root, file);
			if (stat.isDirectory()) {
				entries[relative] = { type: 'dir', mode: stat.mode & 0o777 };
				await walk(file);
			} else if (stat.isFile()) {
				const digest = crypto.createHash('sha256');
				for await (const chunk of createReadStream(file)) digest.update(chunk);
				entries[relative] = {
					type: 'file',
					mode: stat.mode & 0o777,
					bytes: stat.size,
					sha256: digest.digest('hex'),
				};
				bytes += stat.size;
			} else if (stat.isSymbolicLink())
				entries[relative] = { type: 'symlink', target: await fs.readlink(file) };
			else entries[relative] = { type: 'special' };
		}
	}
	await walk(root);
	return { entries, bytes };
}
export async function port() {
	const server = net.createServer();
	await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
	const value = (server.address() as net.AddressInfo).port;
	await new Promise<void>(r => server.close(() => r()));
	return value;
}
export async function ready(port: number) {
	const deadline = Date.now() + 10_000;
	for (;;) {
		if (
			await new Promise<boolean>(resolve => {
				const socket = net.createConnection({ host: '127.0.0.1', port });
				socket.once('connect', () => {
					socket.destroy();
					resolve(true);
				});
				socket.once('error', () => {
					socket.destroy();
					resolve(false);
				});
			})
		)
			return;
		assert(Date.now() < deadline, 'SFTP startup deadline.');
		await new Promise(r => setTimeout(r, 25));
	}
}
export async function fixture(source: string, mode: string, size: number) {
	await fs.mkdir(path.join(source, 'nested'), { recursive: true, mode: 0o700 });
	await fs.writeFile(path.join(source, 'nested', 'selected.txt'), 'selected historical fixture\n', {
		mode: 0o600,
	});
	const chunk = Buffer.alloc(4 * 1024 ** 2);
	let remaining = size;
	for (let index = 0; remaining > 0; index++) {
		const file = await fs.open(path.join(source, 'nested', `data-${index}.bin`), 'wx', 0o600);
		try {
			let part = Math.min(remaining, 256 * 1024 ** 2);
			remaining -= part;
			while (part > 0) {
				crypto.randomFillSync(chunk);
				const length = Math.min(part, chunk.length);
				let offset = 0;
				while (offset < length) {
					const result = await file.write(chunk, offset, length - offset);
					assert(result.bytesWritten > 0);
					offset += result.bytesWritten;
				}
				part -= length;
			}
		} finally {
			await file.close();
		}
	}
	if (mode === 'metadata' || mode === 'combined')
		for (let start = 0; start < (mode === 'combined' ? 115552 : 80000); start += 32)
			await Promise.all(
				Array.from({ length: 32 }, (_, j) =>
					fs.writeFile(
						path.join(source, `file-${String(start + j).padStart(6, '0')}-${'x'.repeat(90)}.txt`),
						'fixture\n',
						{ mode: 0o600 }
					)
				)
			);
	if (mode === 'colon')
		await fs.writeFile(path.join(source, 'nested', 'job:2026.txt'), 'colon fixture\n', {
			mode: 0o600,
		});
	if (mode === 'percent') {
		await fs.mkdir(path.join(source, '100%complete'), { mode: 0o700 });
		await fs.writeFile(
			path.join(source, '100%complete', '%2e%2e:文件.txt'),
			'literal encoding fixture\n',
			{ mode: 0o600 }
		);
		let long = source;
		for (let i = 0; i < 8; i++) long = path.join(long, `nested-${i}-${'x'.repeat(70)}`);
		await fs.mkdir(long, { recursive: true, mode: 0o700 });
		await fs.writeFile(path.join(long, 'café-文件.txt'), 'long path fixture', { mode: 0o600 });
	}
	if (mode === 'symlink') {
		await fs.symlink('nested/selected.txt', path.join(source, 'internal'));
		await fs.symlink('missing', path.join(source, 'broken'));
		await fs.symlink('/outside/fixture', path.join(source, 'external'));
	}
	if (mode === 'fifo') await run('/usr/bin/mkfifo', [path.join(source, 'pipe')]);
}
export async function receive(response: Response, file: string) {
	assert.equal(response.status, 200);
	assert.match(response.headers.get('Content-Type')!, /^application\/x-tar/);
	assert.equal(
		response.headers.get('Content-Disposition'),
		'attachment; filename="backup-backup-01.tar"'
	);
	assert.match(response.headers.get('Cache-Control')!, /no-store/);
	const archiveHash = crypto.createHash('sha256');
	let bytes = 0,
		firstByteMs = 0,
		tail = Buffer.alloc(0);
	const start = performance.now();
	const meter = new Transform({
		transform(chunk, _encoding, done) {
			if (!bytes) firstByteMs = performance.now() - start;
			bytes += chunk.length;
			archiveHash.update(chunk);
			tail = Buffer.concat([tail, chunk]).subarray(-1024);
			done(null, chunk);
		},
	});
	await pipeline(
		Readable.fromWeb(response.body as any),
		meter,
		createWriteStream(file, { flags: 'wx', mode: 0o600 })
	);
	assert.equal(bytes % 512, 0);
	assert.equal(tail.length, 1024);
	assert(
		tail.every(byte => byte === 0),
		'TAR termination is mandatory.'
	);
	return { bytes, firstByteMs: Math.round(firstByteMs), sha256: archiveHash.digest('hex') };
}
export async function checkTar(stream: Readable, allowLinks = false) {
	const extract = tar.extract();
	let files = 0,
		directories = 0,
		links = 0,
		externalLinks = 0;
	extract.on('entry', (header, body, next) => {
		assert(!header.name.startsWith('/'));
		assert(!header.name.split('/').includes('..'));
		assert(['file', 'directory', ...(allowLinks ? ['symlink'] : [])].includes(header.type!));
		if (header.type === 'file') files++;
		if (header.type === 'directory') directories++;
		if (header.type === 'symlink') {
			links++;
			if (header.linkname?.startsWith('/')) externalLinks++;
		}
		body.on('end', next);
		body.resume();
	});
	await pipeline(stream, extract);
	return { files, directories, links, externalLinks };
}
export function measureProcesses() {
	let resticPeakRssBytes = 0,
		rclonePeakRssBytes = 0,
		maxResticProcesses = 0,
		sampling = false;
	const timer = setInterval(async () => {
		if (sampling) return;
		sampling = true;
		try {
			let count = 0;
			for (const pid of (await fs.readdir('/proc')).filter(n => /^\d+$/.test(n))) {
				const status = await fs.readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
				const name = /^Name:\s+(\S+)/m.exec(status)?.[1],
					rss = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] || 0) * 1024;
				if (name === 'restic') {
					count++;
					resticPeakRssBytes = Math.max(resticPeakRssBytes, rss);
				}
				if (name === 'rclone') rclonePeakRssBytes = Math.max(rclonePeakRssBytes, rss);
			}
			maxResticProcesses = Math.max(maxResticProcesses, count);
		} finally {
			sampling = false;
		}
	}, 100);
	timer.unref();
	return {
		stop: () => clearInterval(timer),
		result: () => ({
			resticPeakRssBytes,
			rclonePeakRssBytes,
			maxResticProcesses,
			nodePeakRssBytes: process.resourceUsage().maxRSS * 1024,
		}),
	};
}

/** Disposable unprivileged Linux research fixture; no application/production inputs. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import tar from 'tar-stream';
const exec = promisify(execFile);
assert.notEqual(process.getuid(), 0);
const root = await fs.mkdtemp('/tmp/pluton-link-probe-');
const source = path.join(root, 'source', 'app-01');
const repository = path.join(root, 'repository');
const password = crypto.randomBytes(32).toString('hex');
const env = { PATH: process.env.PATH, RESTIC_PASSWORD: password };
async function restic(args) {
	try {
		return (
			await exec('restic', ['--no-cache', '-r', repository, ...args], {
				env,
				maxBuffer: 1024 * 1024,
			})
		).stdout;
	} catch {
		throw new Error('Disposable Restic probe failed; provider output withheld.');
	}
}
let socket;
try {
	assert.match((await exec('restic', ['version'])).stdout, /restic 0\.19\.1/);
	await fs.mkdir(path.join(source, 'nested'), { recursive: true });
	await fs.writeFile(path.join(source, 'data.txt'), 'source-time bytes\n');
	await fs.writeFile(path.join(source, 'nested', 'unicode-雪.txt'), 'unicode bytes\n');
	await fs.writeFile(path.join(root, 'outside-sentinel'), 'never read through a link\n');
	const links = {
		'file-link': 'data.txt',
		'directory-link': 'nested',
		'broken-link': 'missing-file',
		'circle-a': 'circle-b',
		'circle-b': 'circle-a',
		'absolute-link': '/outside-fixture/sentinel',
		'escaping-link': '../../../outside-sentinel',
		'nested/parent-link': '../data.txt',
	};
	for (const [name, target] of Object.entries(links))
		await fs.symlink(target, path.join(source, name));
	await exec('mkfifo', [path.join(source, 'fifo')]);
	socket = net.createServer();
	await new Promise(resolve => socket.listen(path.join(source, 'socket'), resolve));
	const long = path.join(source, 'long-雪'.repeat(12));
	await fs.mkdir(long);
	await fs.writeFile(path.join(long, 'literal-%3A:雪.txt'), 'long unicode bytes\n');
	await restic(['init']);
	const backup = await restic(['--json', 'backup', source]);
	const snapshot = JSON.parse(backup.trim().split('\n').at(-1)).snapshot_id;
	const listing = (await restic(['--no-lock', '--json', 'ls', snapshot, '--long']))
		.trim()
		.split('\n')
		.map(JSON.parse)
		.filter(row => row.struct_type === 'node');
	assert.equal(listing.filter(row => row.type === 'symlink').length, 8);
	await fs.unlink(path.join(source, 'file-link'));
	await fs.symlink('changed-after-backup', path.join(source, 'file-link'));
	const headers = [];
	const extract = tar.extract();
	extract.on('entry', (header, body, next) => {
		headers.push({
			name: '/' + header.name.replace(/\/$/, ''),
			type: header.type,
			target: header.linkname,
		});
		body.on('end', next);
		body.resume();
	});
	const child = spawn(
		'restic',
		['--no-lock', '--no-cache', '-r', repository, 'dump', '--archive', 'tar', snapshot, '/'],
		{ env, stdio: ['ignore', 'pipe', 'ignore'] }
	);
	const closed = new Promise(resolve => child.once('close', resolve));
	await pipeline(child.stdout, extract);
	assert.equal(await closed, 0);
	for (const [name, target] of Object.entries(links)) {
		const node = headers.find(row => row.name === path.posix.join(source, name));
		assert.equal(node?.type, 'symlink');
		assert.equal(node.target, target);
	}
	const restored = path.join(root, 'restored');
	await fs.mkdir(restored);
	await restic(['--no-lock', 'restore', snapshot, '--target', restored, '--overwrite', 'never']);
	for (const [name, target] of Object.entries(links)) {
		const node = path.join(restored, source.slice(1), name);
		assert((await fs.lstat(node)).isSymbolicLink());
		assert.equal(await fs.readlink(node), target);
	}
	console.log(
		JSON.stringify({
			event: 'managed_symlink_restic_probe',
			symlinkTargetsInListing: listing
				.filter(row => row.type === 'symlink')
				.every(row => typeof row.linktarget === 'string'),
			linksPreservedInTar: 8,
			linksRestoredAsMetadata: 8,
			changedSourceTargetPreserved: true,
			specialEntries: listing
				.filter(row => ['fifo', 'socket'].includes(row.type))
				.map(row => ({
					type: row.type,
					tarType: headers.find(header => header.name === row.path)?.type ?? 'omitted',
				})),
			regularFiles: headers.filter(row => row.type === 'file').length,
		})
	);
} finally {
	if (socket) await new Promise(resolve => socket.close(resolve));
	assert.equal(path.dirname(root), '/tmp');
	assert(path.basename(root).startsWith('pluton-link-probe-'));
	await fs.rm(root, { recursive: true, force: true });
}

/** Disposable crash driver: SIGKILL without service/SQLite teardown. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hcpPublicationProtocol } from './hcpPublicationProtocol';
import { ManagedExportStore } from '../../src/stores/ManagedExportStore';

const [file, provider, requestedPhase, keyring] = process.argv.slice(2);
const semantic = requestedPhase.startsWith('semantic-');
const phase = requestedPhase.replace(/^semantic-/, '');
const parent = path.resolve(path.dirname(provider));
if (
	path.dirname(parent) !== path.resolve(os.tmpdir()) ||
	!/^pluton-publication-[A-Za-z0-9]{6}$/.test(path.basename(parent)) ||
	file !== path.join(parent, 'journal', 'jobs.sqlite') ||
	provider !== path.join(parent, 'provider.json') ||
	fs.lstatSync(parent).isSymbolicLink()
)
	throw new Error('Disposable crash fixture paths required');
if (
	semantic &&
	(keyring !== path.join(parent, 'keyring.json') ||
		!fs.lstatSync(keyring).isFile() ||
		fs.lstatSync(keyring).isSymbolicLink())
)
	throw new Error('Disposable keyring path required');
const f = hcpPublicationProtocol(
	semantic ? 'operation-aborted-a' : '',
	semantic,
	'same-node',
	semantic ? keyring : undefined
);
const original = f.storage.client.config.requestHandler.handle;
let n = 0;
f.storage.client.config.requestHandler.handle = async (request: any, options: any) => {
	if (
		phase !== 'settled' &&
		request.method === 'POST' &&
		request.path.endsWith('.probe-race') &&
		request.query.uploadId &&
		++n === (semantic ? 1 : 2)
	) {
		// The provider handled this request, but its response has not reached
		// the client. Preserve server ordering while withholding the receipt.
		await original(request, options);
		return new Promise(() => {});
	}
	return original(request, options);
};
const store = new ManagedExportStore(file);
store.save(f.job);
function crash() {
	const snapshot = JSON.stringify({
		objects: [...f.objects].map(([key, value]) => [
			key,
			{ ...value, body: value.body.toString('base64') },
		]),
		uploads: [...f.uploads].map(([id, u]) => [
			id,
			{ ...u, parts: [...u.parts].map(([n, b]) => [n, b.toString('base64')]) },
		]),
	});
	const fd = fs.openSync(provider, 'wx', 0o600);
	fs.writeFileSync(fd, snapshot);
	fs.fsyncSync(fd);
	fs.closeSync(fd);
	if (semantic) fs.unlinkSync(path.join(f.root, 'keyring.json'));
	fs.rmdirSync(f.root); // this separate nonencrypted helper directory is empty
	process.kill(process.pid, 'SIGKILL');
}
await f.storage.preflight(f.job, AbortSignal.timeout(15_000), fields => {
	const race = fields.publicationRaces?.[0];
	const acknowledged = race?.attempts.some(a => a.outcome === 'acknowledged');
	if (phase === 'before-receipt' && acknowledged) crash();
	store.update(f.job.id, fields);
	Object.assign(f.job, structuredClone(fields));
	if (
		(phase === 'after-receipt' && acknowledged) ||
		(phase === 'settled' && race?.state === 'single-winner')
	)
		crash();
});
throw new Error('Crash checkpoint was not reached');

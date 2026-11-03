/** Disposable crash driver: SIGKILL without service/SQLite teardown. */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hcpPublicationProtocol } from './hcpPublicationProtocol';
import { ManagedExportStore } from '../../src/stores/ManagedExportStore';

const [file, provider, phase] = process.argv.slice(2);
const parent = path.resolve(path.dirname(provider));
if (
	path.dirname(parent) !== path.resolve(os.tmpdir()) ||
	!/^pluton-publication-[A-Za-z0-9]{6}$/.test(path.basename(parent)) ||
	file !== path.join(parent, 'journal', 'jobs.sqlite') ||
	provider !== path.join(parent, 'provider.json') ||
	fs.lstatSync(parent).isSymbolicLink()
)
	throw new Error('Disposable crash fixture paths required');
const f = hcpPublicationProtocol();
const original = f.storage.client.config.requestHandler.handle;
let n = 0;
f.storage.client.config.requestHandler.handle = async (request: any, options: any) => {
	if (
		phase !== 'settled' &&
		request.method === 'POST' &&
		request.path.endsWith('.probe-race') &&
		request.query.uploadId &&
		++n === 2
	)
		return new Promise(() => {}); // controlled in-flight competitor at crash
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

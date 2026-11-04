/** Actual pinned SDK/Node HTTP transport on loopback only; no real credentials. */
import http from 'http';
import { once } from 'events';
import { hcpPublicationProtocol } from './hcpPublicationProtocol';
import { S3ExportStorage } from '../../src/utils/managedExport/S3ExportStorage';
import path from 'path';
import { ManagedExportStore } from '../../src/stores/ManagedExportStore';

async function scenario(fault: string) {
	const f = hcpPublicationProtocol('', true);
	let requests = 0;
	let versioningWire:
		| { get: boolean; pathStyle: boolean; signed: boolean; versioningOnly: boolean }
		| undefined;
	let unknownObject = fault === 'historical',
		deletes = 0,
		reconciled = false;
	const controller = new AbortController();
	const cancel = () =>
		controller.abort(
			fault.includes('deadline')
				? new DOMException('Synthetic deadline', 'TimeoutError')
				: new Error('private-abort-reason')
		);
	const server = http
		.createServer((req, res) => {
			requests++;
			if (req.method === 'DELETE') deletes++;
			const url = new URL(req.url!, 'http://127.0.0.1');
			if (url.searchParams.has('versioning')) {
				versioningWire = {
					get: req.method === 'GET',
					pathStyle: url.pathname === '/' + f.config.bucket + '/',
					signed: req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 ') === true,
					versioningOnly: [...url.searchParams.keys()].every(k => k === 'versioning'),
				};
				if (fault === 'reset') {
					req.socket.destroy();
					return;
				}
				if (fault === 'sdk-timeout') return;
				if (fault === 'truncated') {
					res.writeHead(200, { 'Content-Length': '1000', 'Connection': 'close' });
					res.end('<VersioningConfiguration/>');
					return;
				}
				if (fault === 'transient-reset' && requests === 1) {
					req.socket.destroy();
					return;
				}
				if (fault.endsWith('-request')) {
					cancel();
					return;
				}
				if (fault.endsWith('-body') && !reconciled) {
					res.writeHead(200);
					res.write('<VersioningConfiguration>');
					return;
				}
				if (fault === '501' || fault === '403') {
					res.writeHead(Number(fault));
					res.end(
						`<Error><Code>${fault === '501' ? 'NotImplemented' : 'AccessDenied'}</Code><Message>private-provider-body</Message></Error>`
					);
					return;
				}
				if (fault === 'Enabled' || fault === 'Suspended' || fault === 'sdk-mismatch') {
					res.end(
						`<VersioningConfiguration><Status>${fault === 'sdk-mismatch' ? 'Enabled' : fault}</Status></VersioningConfiguration>`
					);
					return;
				}
				const invalid: Record<string, string> = {
					empty: '',
					malformed: '<VersioningConfiguration>',
					wrongRoot: '<Wrong/>',
					duplicate:
						'<VersioningConfiguration><Status>Enabled</Status><Status>Suspended</Status></VersioningConfiguration>',
					unknownStatus:
						'<VersioningConfiguration><Status>Unknown</Status></VersioningConfiguration>',
					whitespaceStatus: '<VersioningConfiguration><Status> </Status></VersioningConfiguration>',
					huge: '<VersioningConfiguration>' + ' '.repeat(20_000) + '</VersioningConfiguration>',
				};
				if (fault in invalid) {
					res.end(invalid[fault]);
					return;
				}
				res.end('<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2020-09-01/"/>');
			} else if (url.searchParams.has('uploads')) {
				res.end(
					'<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>'
				);
			} else if (req.method === 'HEAD') {
				res.writeHead(unknownObject ? 200 : 404);
				res.end();
			} else {
				res.writeHead(400);
				res.end();
			}
		})
		.listen(0, '127.0.0.1');
	await once(server, 'listening');
	// Only this disposable fixture bypasses exportConfiguration's HTTPS endpoint
	// restriction to exercise Node's real transport without a test certificate.
	const storage = new S3ExportStorage({
		...f.config,
		endpoint: `http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}`,
	});
	if (fault === 'sdk-timeout') {
		storage.client.config.requestHandler.updateHttpClientConfig!('requestTimeout', 25);
		storage.client.config.requestHandler.updateHttpClientConfig!('throwOnRequestTimeout', true);
	}
	f.job.integrityMode = 'application-encrypted-hcp';
	f.job.state = 'cancelled';
	if (fault.endsWith('-before')) cancel();
	if (fault === 'sdk-mismatch')
		storage.client.middlewareStack.add(
			next => async args => {
				const result = await next(args);
				(result.output as any).Status = undefined; // simulate a future deserializer regression
				return result;
			},
			{ step: 'deserialize', priority: 'normal', name: 'fixtureSdkDropsStatus' }
		);
	if (fault === 'deadline-complete')
		storage.client.middlewareStack.add(
			next => async args => {
				const result = await next(args);
				cancel();
				return result;
			},
			{ step: 'initialize', name: 'fixtureAbortAfterDeserialization' }
		);
	if (fault.endsWith('-body')) {
		const handler = storage.client.config.requestHandler;
		const original = handler.handle.bind(handler);
		handler.handle = async (request, options) => {
			const result = await original(request, options);
			setImmediate(cancel); // only after HTTP 200 headers have really arrived
			return result;
		};
	}
	try {
		let cleaned = false;
		try {
			await storage.cleanup(f.job, controller.signal, f.update);
			cleaned = true;
		} catch {
			/* bounded diagnostics below */
		}
		const originalRequests = requests;
		let modeAdmission;
		if (['success', 'Enabled', 'Suspended', '501', '403', 'empty', 'wrongRoot'].includes(fault)) {
			const candidate = new S3ExportStorage({
				...storage.config,
				exportMode: fault === 'Enabled' ? undefined : storage.config.exportMode,
			});
			try {
				modeAdmission = await candidate.mode(new AbortController().signal);
			} catch {
				modeAdmission = 'refused';
			} finally {
				candidate.close();
			}
		}
		let inspection;
		if (fault === 'success') {
			const before = JSON.stringify(f.job);
			const observed = await storage.inspectPreflight(f.job, new AbortController().signal);
			inspection = {
				readOnly: observed.readOnly,
				ownershipAdopted: observed.ownershipAdopted,
				unchanged: JSON.stringify(f.job) === before,
				versioning: observed.observations[0],
			};
		}
		let afterRestart;
		if (fault === 'historical' || fault === 'deadline-body') {
			const file = path.join(f.root, 'journal', 'jobs.sqlite');
			let store = new ManagedExportStore(file);
			store.save(f.job);
			store.close();
			unknownObject = false; // separately authorized operator removal, fixture only
			reconciled = true;
			storage.close();
			store = new ManagedExportStore(file);
			const restored = store.get(f.job.id)!;
			const retry = new S3ExportStorage(storage.config);
			try {
				await retry.cleanup(restored, new AbortController().signal, fields =>
					store.update(restored.id, fields)
				);
				afterRestart = {
					cleanupState: store.get(restored.id)!.cleanupState,
					retainedFailure: store.get(restored.id)!.lastCleanupFailure?.operation,
					ownedObjects: restored.ownedObjects?.length || 0,
					deletes,
				};
			} finally {
				retry.close();
				store.close();
			}
		}
		return {
			cleaned,
			aborted: controller.signal.aborted,
			requests: originalRequests,
			failure: f.job.lastCleanupFailure,
			versioningWire,
			inspection,
			modeAdmission,
			afterRestart,
			deletes,
		};
	} finally {
		storage.close();
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
		f.close();
	}
}
async function main() {
	const report: Record<string, unknown> = {};
	for (const fault of [
		'reset',
		'sdk-timeout',
		'truncated',
		'deadline-complete',
		'historical',
		'transient-reset',
		'success',
		'Enabled',
		'sdk-mismatch',
		'Suspended',
		'501',
		'403',
		'empty',
		'malformed',
		'wrongRoot',
		'duplicate',
		'unknownStatus',
		'whitespaceStatus',
		'huge',
		'deadline-before',
		'cancel-before',
		'deadline-request',
		'cancel-request',
		'deadline-body',
		'cancel-body',
	])
		report[fault] = await scenario(fault);
	process.stdout.write('VERSIONING ' + JSON.stringify(report) + '\n');
}
main().catch(() => {
	process.stderr.write('Disposable versioning transport driver failed.\n');
	process.exitCode = 1;
});

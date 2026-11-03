import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { hcpPublicationProtocol } from '../fixtures/hcpPublicationProtocol';
import { ManagedExportStore } from '../../src/stores/ManagedExportStore';
import { publicExportPublications } from '../../src/utils/managedExport/ExportPublication';
import type { ExportJob } from '../../src/utils/managedExport/ExportPolicy';

jest.mock('../../src/utils/logger', () => ({ planLogger: () => ({ info: jest.fn() }) }));
const signal = () => AbortSignal.timeout(15_000);
function journal(f: ReturnType<typeof hcpPublicationProtocol>) {
	const file = path.join(f.root, 'journal', 'jobs.sqlite');
	const store = new ManagedExportStore(file);
	store.save(f.job);
	return {
		file,
		store,
		update: (fields: Partial<ExportJob>) => {
			store.update(f.job.id, fields);
			Object.assign(f.job, structuredClone(fields));
		},
	};
}
describe('real SDK concurrent multipart publication and safe durable cleanup', () => {
	test.each([false, true])(
		'one winner and 409 losers, full readback, marker preservation: encrypted=%s',
		async encrypted => {
			const f = hcpPublicationProtocol('', encrypted),
				j = journal(f);
			try {
				f.store(f.config.prefix + '/', Buffer.alloc(0), {});
				expect(await f.storage.inventory([], signal())).toMatchObject({
					directoryMarker: 'verified-empty',
					objects: 0,
				});
				await f.storage.preflight(f.job, signal(), j.update);
				expect(f.job.preflightChecks).toContain('concurrent-publication');
				expect(f.job.preflightChecks).toContain('cleanup');
				expect(f.uploads.size).toBe(0);
				expect([...f.objects.keys()]).toEqual([f.config.prefix + '/']);
				const report = publicExportPublications(j.store.get(f.job.id)!);
				expect(report).toHaveLength(2);
				expect(report.map(r => r.operations.length)).toEqual([2, 3]);
				for (const race of report) {
					expect(race).toMatchObject({
						ambiguityRemaining: false,
						multipleSuccesses: false,
						multipartCleanupPending: false,
						objectCleanupPending: false,
					});
					expect(race.operations.filter(o => o.acknowledged)).toHaveLength(1);
					expect(race.operations.every(o => o.durableReceipt)).toBe(true);
					expect(
						race.operations
							.filter(o => o.operation === 'CompleteMultipartUpload')
							.every(o => o.uploadAbsent)
					).toBe(true);
				}
				expect(await f.storage.inventory([f.job], signal())).toMatchObject({
					objects: 0,
					uploads: 0,
					directoryMarker: 'verified-empty',
				});
			} finally {
				j.store.close();
				f.close();
			}
		}
	);
	test.each([
		'competitor-400',
		'competitor-404',
		'competitor-412',
		'competitor-500',
		'embedded-error',
		'two-successes',
		'malformed',
		'empty',
		'missing-etag',
		'wrong-key',
		'lost-ack',
		'head-incomplete',
		'hash-mismatch',
		'inconsistent-conflict',
	])('NO-GO with distinct durable operation evidence and protected object: %s', async fault => {
		const f = hcpPublicationProtocol(fault, true),
			j = journal(f);
		try {
			await expect(f.storage.preflight(f.job, signal(), j.update)).rejects.toThrow();
			expect(f.job.preflightChecks).not.toContain('concurrent-publication');
			expect(f.job.providerEvidence).toBeUndefined();
			const saved = j.store.get(f.job.id)!,
				key = saved.key + '.probe-race';
			if (fault.startsWith('competitor-') || fault === 'embedded-error')
				expect(saved.creationReceipts?.some(r => r.key === key && r.acknowledged)).toBe(true);
			expect(f.objects.has(key)).toBe(true);
			expect(f.uploads.size).toBe(0);
			expect(saved.ownedObjects?.some(p => p.key === key)).toBe(false);
			const report = publicExportPublications(saved)[0];
			expect(report.operations).toHaveLength(2);
			expect(report.operations.every(o => o.durableReceipt)).toBe(true);
			if (fault.startsWith('competitor-') || fault === 'embedded-error') {
				expect(saved.creationReceipts?.some(r => r.key === key && r.acknowledged)).toBe(true);
				expect(report.operations[0]).toMatchObject({ acknowledged: true, durableReceipt: true });
				expect(report.operations[1].httpStatus).toBe(
					fault === 'embedded-error' ? 503 : Number(fault.slice(11))
				);
			}
			if (fault === 'embedded-error')
				expect(report.operations[1]).toMatchObject({
					wireHttpStatus: 200,
					response: 'embedded-error',
					providerCode: 'InvalidPart',
					acknowledged: false,
				});
			if (fault === 'two-successes')
				expect(report).toMatchObject({ multipleSuccesses: true, ambiguityRemaining: true });
			expect(JSON.stringify(report)).not.toMatch(
				/private-|\.tar|etag|uploadId|nonce|example.internal|authorization/i
			);
			expect(f.calls.some(c => c.method === 'DELETE' && c.key === key && !c.query.uploadId)).toBe(
				false
			);
			await expect(f.storage.cleanup(structuredClone(saved), signal(), j.update)).rejects.toThrow();
			expect(f.objects.has(key)).toBe(true);
		} finally {
			j.store.close();
			f.close();
		}
	});
	test.each(['put-winner', 'put-lost-ack'])(
		'mixed PUT/multipart competitors retain exact per-operation outcomes: %s',
		async fault => {
			const f = hcpPublicationProtocol(fault, true),
				j = journal(f);
			try {
				if (fault === 'put-winner') {
					await f.storage.preflight(f.job, signal(), j.update);
					expect(
						publicExportPublications(j.store.get(f.job.id)!)
							.find(r => r.target === 'put-race')
							?.operations.find(a => a.acknowledged)?.competitor
					).toBe('put');
					expect(f.objects.size).toBe(0);
				} else {
					await expect(f.storage.preflight(f.job, signal(), j.update)).rejects.toThrow();
					expect(f.objects.has(f.job.key + '.probe-put-race')).toBe(true);
					expect(
						publicExportPublications(j.store.get(f.job.id)!).find(r => r.target === 'put-race')
					).toMatchObject({ ambiguityRemaining: true, objectProof: false });
				}
			} finally {
				j.store.close();
				f.close();
			}
		}
	);
	test('a historical matching key, hash and metadata without durable publication/ownership proof is never adopted', async () => {
		const f = hcpPublicationProtocol('competitor-404'),
			j = journal(f);
		try {
			await expect(f.storage.preflight(f.job, signal(), j.update)).rejects.toThrow();
			const old = j.store.get(f.job.id)!;
			delete old.publicationRaces;
			delete old.ownedObjects;
			await expect(f.storage.cleanup(old, signal(), j.update)).rejects.toMatchObject({
				diagnostic: { detail: 'ownership-proof-missing', target: 'race' },
			});
			expect(f.objects.has(old.key + '.probe-race')).toBe(true);
		} finally {
			j.store.close();
			f.close();
		}
	});
	test('winner acknowledgement is durably committed while its competitor is still in flight', async () => {
		const f = hcpPublicationProtocol(),
			j = journal(f);
		const original = f.storage.client.config.requestHandler.handle;
		const saved = Promise.withResolvers<void>(),
			held = Promise.withResolvers<any>();
		let pendingRequest: any,
			n = 0;
		f.storage.client.config.requestHandler.handle = async (request: any, options: any) => {
			if (
				request.method === 'POST' &&
				request.path.endsWith('.probe-race') &&
				request.query.uploadId &&
				++n === 2
			) {
				pendingRequest = request;
				return held.promise;
			}
			return original(request, options);
		};
		const running = f.storage.preflight(f.job, signal(), fields => {
			j.update(fields);
			if (
				fields.publicationRaces?.some(
					r =>
						r.attempts.some(a => a.outcome === 'acknowledged') &&
						r.attempts.some(a => a.outcome === 'pending')
				)
			)
				saved.resolve();
		});
		try {
			await Promise.race([
				saved.promise,
				running.then(() => {
					throw new Error('Expected an in-flight competitor');
				}),
			]);
			const persisted = j.store.get(f.job.id)!,
				key = f.job.key + '.probe-race';
			expect(persisted.creationReceipts).toContainEqual({ key, acknowledged: true });
			expect(persisted.publicationRaces?.[0].state).toBe('pending');
			expect(persisted.ownedObjects?.some(p => p.key === key)).toBe(false);
			expect(j.store.db.pragma('synchronous', { simple: true })).toBe(2);
			held.resolve(await original(pendingRequest, {}));
			await running;
		} finally {
			held.resolve(await original(pendingRequest, {}).catch(() => ({})));
			await running.catch(() => {});
			j.store.close();
			f.close();
		}
	});
	test('a failed durable receipt write never authorizes cleanup from volatile state', async () => {
		const f = hcpPublicationProtocol(),
			j = journal(f);
		try {
			await expect(
				f.storage.preflight(f.job, signal(), fields => {
					if (
						fields.publicationRaces?.some(r => r.attempts.some(a => a.outcome === 'acknowledged'))
					)
						throw new Error('simulated-journal-io-failure');
					j.update(fields);
				})
			).rejects.toThrow();
			const persisted = j.store.get(f.job.id)!;
			expect(persisted.publicationRaces?.[0].state).not.toBe('verified');
			await expect(f.storage.cleanup(persisted, signal(), j.update)).rejects.toThrow();
			expect(f.objects.has(f.job.key + '.probe-race')).toBe(true);
		} finally {
			j.store.close();
			f.close();
		}
	});
	test.each(['before-receipt', 'after-receipt', 'settled'])(
		'SIGKILL crash, reopen SQLite and bounded reconciliation: %s',
		async phase => {
			const f = hcpPublicationProtocol(),
				file = path.join(f.root, 'journal', 'jobs.sqlite'),
				provider = path.join(f.root, 'provider.json');
			try {
				const result = spawnSync(
					process.execPath,
					[
						'--import',
						'tsx',
						path.join(__dirname, '../fixtures/hcpPublicationCrash.process.ts'),
						file,
						provider,
						phase,
					],
					{
						cwd: process.cwd(),
						env: process.env,
						encoding: 'utf8',
						timeout: 20_000,
						maxBuffer: 1024 * 1024,
					}
				);
				expect(result.error?.code).not.toBe('ETIMEDOUT');
				expect(result.signal === 'SIGKILL' || (result.status !== null && result.status !== 0)).toBe(
					true
				);
				expect(fs.existsSync(provider)).toBe(true);
				const snapshot = JSON.parse(fs.readFileSync(provider, 'utf8'));
				for (const [key, object] of snapshot.objects)
					f.objects.set(key, {
						...object,
						body: Buffer.from(object.body, 'base64'),
						modified: new Date(object.modified),
					});
				for (const [id, upload] of snapshot.uploads)
					f.uploads.set(id, {
						...upload,
						parts: new Map(upload.parts.map(([n, data]: any) => [n, Buffer.from(data, 'base64')])),
					});
				const store = new ManagedExportStore(file);
				try {
					const job = store.all()[0],
						key = job.key + '.probe-race';
					const cleanup = f.storage.cleanup(job, signal(), fields => store.update(job.id, fields));
					if (phase === 'settled') {
						await cleanup;
						expect(f.objects.size).toBe(0);
					} else {
						await expect(cleanup).rejects.toThrow();
						expect(f.objects.has(key)).toBe(true);
					}
					expect(f.uploads.size).toBe(0);
					if (phase === 'before-receipt')
						expect(
							store.get(job.id)?.creationReceipts?.some(r => r.key === key && r.acknowledged)
						).toBe(false);
				} finally {
					store.close();
				}
			} finally {
				f.close();
			}
		}
	);
});

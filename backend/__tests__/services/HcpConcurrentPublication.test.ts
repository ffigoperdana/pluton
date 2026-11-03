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
	test('HTTP 200 headers followed by body connection reset are transport failure, not embedded XML evidence', async () => {
		const f = hcpPublicationProtocol('second-body-reset', true),
			j = journal(f);
		try {
			await expect(f.storage.preflight(f.job, signal(), j.update)).rejects.toThrow();
			const report = publicExportPublications(j.store.get(f.job.id)!)[0];
			expect(report.operations[1]).toMatchObject({
				wireHttpStatus: 200,
				response: 'transport-error',
				providerCategory: 'network',
				acknowledged: false,
			});
			expect(report).toMatchObject({ ambiguityRemaining: true, objectProof: false });
			expect(f.objects.has(f.job.key + '.probe-race')).toBe(true);
		} finally {
			j.store.close();
			f.close();
		}
	});
	test.each([
		['second-missing-etag', { entityTagPresent: false, entityTagQuoted: false }],
		['second-unquoted-etag', { entityTagPresent: true, entityTagQuoted: false }],
		['second-missing-bucket', { bucketPresent: false, bucketMatches: false }],
		['second-wrong-bucket', { bucketPresent: true, bucketMatches: false }],
		['second-missing-key', { keyPresent: false, keyMatches: false }],
		['second-wrong-key', { keyPresent: true, keyMatches: false }],
		['second-version', { versionAbsentOrNull: false }],
	])(
		'one valid 200 and one invalid 200 identifies exact schema failure without inferring a second commit: %s',
		async (fault, failed) => {
			const f = hcpPublicationProtocol(fault as string, true),
				j = journal(f);
			try {
				await expect(f.storage.preflight(f.job, signal(), j.update)).rejects.toThrow();
				const saved = j.store.get(f.job.id)!,
					report = publicExportPublications(saved)[0];
				expect(saved.preflightFailure).toMatchObject({
					detail: 'race-multiple-acknowledgements',
					target: 'race',
				});
				expect(report).toMatchObject({
					acknowledgedResponses: 2,
					validSuccessResponses: 1,
					multipleAcknowledgements: true,
					multipleSuccesses: false,
					ambiguityRemaining: true,
					objectProof: false,
					proofVerified: false,
				});
				expect(report.operations[0]).toMatchObject({
					httpStatus: 200,
					wireHttpStatus: 200,
					response: 'success',
					validationEvidence: 'recorded',
					validation: {
						status200: true,
						entityTagPresent: true,
						entityTagQuoted: true,
						versionAbsentOrNull: true,
						objectIdentityRequired: true,
						bucketPresent: true,
						bucketMatches: true,
						keyPresent: true,
						keyMatches: true,
					},
				});
				expect(report.operations[1]).toMatchObject({
					httpStatus: 200,
					wireHttpStatus: 200,
					response: 'invalid-response',
					acknowledged: true,
					durableReceipt: true,
					validationEvidence: 'recorded',
					validation: { status200: true, ...(failed as object) },
				});
				const key = f.job.key + '.probe-race';
				expect(f.commits.filter(c => c.key === key)).toHaveLength(1); // independent provider fixture evidence, not application inference
				expect(saved.ownedObjects?.some(p => p.key === key)).toBe(false);
				expect(f.objects.has(key)).toBe(true);
				expect(f.uploads.size).toBe(0);
				const before = JSON.stringify(j.store.get(saved.id));
				const diagnosis = await f.storage.inspectPreflight(saved, signal());
				expect(diagnosis.publications).toEqual(publicExportPublications(saved));
				expect(JSON.stringify(j.store.get(saved.id))).toBe(before);
				expect(JSON.stringify(report)).not.toMatch(
					/private-|foreign-|\.tar|nonce|uploadId|example.internal|authorization/i
				);
				await expect(
					f.storage.cleanup(structuredClone(saved), signal(), j.update)
				).rejects.toThrow();
				expect(f.objects.has(key)).toBe(true);
			} finally {
				j.store.close();
				f.close();
			}
		}
	);
	test('two schema-valid responses do not establish two independently observed commits', async () => {
		const f = hcpPublicationProtocol('schema-only-success', true),
			j = journal(f);
		try {
			await expect(f.storage.preflight(f.job, signal(), j.update)).rejects.toThrow();
			const report = publicExportPublications(j.store.get(f.job.id)!)[0];
			expect(report).toMatchObject({
				acknowledgedResponses: 2,
				validSuccessResponses: 2,
				multipleSuccesses: true,
				ambiguityRemaining: true,
				objectProof: false,
			});
			expect(f.job.preflightFailure?.detail).toBe('race-multiple-successes');
			expect(f.commits.filter(c => c.key === f.job.key + '.probe-race')).toHaveLength(1);
			expect(f.objects.has(f.job.key + '.probe-race')).toBe(true);
		} finally {
			j.store.close();
			f.close();
		}
	});
	test.each(['same-node', 'different-nodes'] as const)(
		'global write-once model retains exact guarantees under simulated routing: %s',
		async routing => {
			const f = hcpPublicationProtocol('', true, routing),
				j = journal(f);
			try {
				await f.storage.preflight(f.job, signal(), j.update);
				expect(new Set(f.completionRoutes).size).toBe(routing === 'same-node' ? 1 : 2);
				expect(f.objects.size).toBe(0);
				expect(f.uploads.size).toBe(0);
			} finally {
				j.store.close();
				f.close();
			}
		}
	);
	test('a node-local collision model may pass one route but concurrent different-node overwrite remains blocked', async () => {
		const f = hcpPublicationProtocol('node-local-overwrite', true, 'different-nodes'),
			j = journal(f);
		try {
			await expect(f.storage.preflight(f.job, signal(), j.update)).rejects.toThrow();
			const commits = f.commits.filter(c => c.key === f.job.key + '.probe-race');
			expect(new Set(commits.map(c => c.route)).size).toBe(2);
			expect(new Set(commits.map(c => c.sha256)).size).toBe(2);
			expect(f.job.preflightFailure?.detail).toBe('race-multiple-successes');
			expect(publicExportPublications(j.store.get(f.job.id)!)[0]).toMatchObject({
				multipleSuccesses: true,
				objectProof: false,
			});
			expect(f.objects.has(f.job.key + '.probe-race')).toBe(true);
		} finally {
			j.store.close();
			f.close();
		}
	});
	test.each(['second-embedded-whitespace', 'second-malformed', 'second-duplicate-etag'])(
		'real SDK XML formatting remains fail-closed, not normalized to a conflict: %s',
		async fault => {
			const f = hcpPublicationProtocol(fault, true),
				j = journal(f);
			try {
				await expect(f.storage.preflight(f.job, signal(), j.update)).rejects.toThrow();
				const report = publicExportPublications(j.store.get(f.job.id)!)[0];
				expect(report).toMatchObject({ ambiguityRemaining: true, objectProof: false });
				expect(report.operations[1].response).not.toBe('success');
				expect(report.operations[1].httpStatus).not.toBe(409);
				if (fault === 'second-embedded-whitespace') {
					expect(report.operations[1]).toMatchObject({
						httpStatus: 200,
						response: 'embedded-error',
						acknowledged: false,
						httpAcknowledged: true,
						providerCode: 'InvalidPart',
						completion: {
							body: 'complete',
							xml: 'error',
							xmlParser: 'accepted',
							sdkParser: 'not-run',
						},
					});
				} else {
					expect(report.operations[1]).toMatchObject({
						httpStatus: 200,
						wireHttpStatus: 200,
						response: 'body-invalid',
						completion: {
							body: 'complete',
							xmlParser: fault === 'second-malformed' ? 'rejected' : 'accepted',
							sdkParser: 'not-run',
						},
						acknowledged: false,
						validationEvidence: 'not-evaluated',
					});
				}
				expect(f.job.preflightChecks).not.toContain('concurrent-publication');
				expect(f.objects.has(f.job.key + '.probe-race')).toBe(true);
			} finally {
				j.store.close();
				f.close();
			}
		}
	);
	test('body evidence survives SQLite reopen; repeated cleanup never adopts an ambiguous object', async () => {
		const f = hcpPublicationProtocol('second-embedded-whitespace', true),
			j = journal(f);
		let reopened: ManagedExportStore | undefined;
		try {
			await expect(f.storage.preflight(f.job, signal(), j.update)).rejects.toThrow();
			const before = publicExportPublications(j.store.get(f.job.id)!);
			expect(before[0]).toMatchObject({
				httpAcknowledgements: 2,
				acknowledgedResponses: 1,
				validSuccessResponses: 1,
				ambiguityRemaining: true,
				objectProof: false,
			});
			j.store.close();
			reopened = new ManagedExportStore(j.file);
			expect(publicExportPublications(reopened.get(f.job.id)!)).toEqual(before);
			for (let n = 0; n < 2; n++) {
				const saved = reopened.get(f.job.id)!;
				const report = publicExportPublications(saved)[0];
				expect(report.operations.map(a => a.completion)).toEqual(
					before[0].operations.map(a => a.completion)
				);
				expect(report).toMatchObject({
					ambiguityRemaining: true,
					objectProof: false,
					validSuccessResponses: 1,
				});
				await expect(
					f.storage.cleanup(saved, signal(), fields => reopened!.update(saved.id, fields))
				).rejects.toThrow();
				expect(f.objects.has(saved.key + '.probe-race')).toBe(true);
				expect(
					reopened.get(saved.id)?.ownedObjects?.some(p => p.key === saved.key + '.probe-race')
				).toBe(false);
			}
			expect(
				f.calls.some(
					c => c.method === 'DELETE' && !c.query.uploadId && c.key.endsWith('.probe-race')
				)
			).toBe(false);
		} finally {
			reopened?.close();
			if (!reopened) j.store.close();
			f.close();
		}
	});
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
					fault === 'embedded-error' ? 200 : Number(fault.slice(11))
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
					if (phase !== 'before-receipt') {
						expect(publicExportPublications(job)[0].operations[0].completion).toMatchObject({
							body: 'complete',
							xml: 'result',
							xmlParser: 'accepted',
							sdkParser: 'resolved',
						});
					}
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

import request from 'supertest';
import express, { Express } from 'express';
import { createBackupRouter } from '../../src/routes/backups';
import { BackupController } from '../../src/controllers/BackupController';
import { BackupService } from '../../src/services/BackupServices';
import jwt from 'jsonwebtoken';
import Cookies from 'cookies';
import { RetainedRestoreDependencyError } from '../../src/utils/retainedRestoreDependency';
import http from 'http';
import { AddressInfo } from 'net';
import { ManagedRepositoryAccessError } from '../../src/utils/restic/ManagedSftpRepositorySession';
import { SnapshotIndexError } from '../../src/utils/restic/ManagedSnapshotIndex';
import { webAccess } from '../../src/middlewares/webAccess';
import { AppError } from '../../src/utils/AppError';
import { ManagedExportError } from '../../src/utils/restic/ManagedExportPolicy';

jest.mock('jsonwebtoken');
jest.mock('cookies');
jest.mock('../../src/services/ConfigService', () => ({
	configService: {
		config: {
			SECRET: 'test-secret',
		},
	},
}));

describe('Backup Routes', () => {
	let app: Express;
	let backupController: BackupController;
	let mockBackupService: jest.Mocked<BackupService>;

	const setupAuthMock = (authenticated: boolean) => {
		if (authenticated) {
			(Cookies as jest.MockedClass<typeof Cookies>).mockImplementation(
				() =>
					({
						get: jest.fn().mockReturnValue('valid-token'),
					}) as any
			);
			(jwt.verify as jest.Mock).mockImplementation((token, secret, callback) => {
				callback(null, { user: 'testuser' });
			});
		} else {
			(Cookies as jest.MockedClass<typeof Cookies>).mockImplementation(
				() =>
					({
						get: jest.fn().mockReturnValue(null),
					}) as any
			);
		}
	};

	beforeEach(() => {
		jest.clearAllMocks();

		mockBackupService = {
			deleteBackup: jest.fn(),
			getSnapshotFiles: jest.fn(),
			getSnapshotPage: jest.fn(),
			getBackupProgress: jest.fn(),
			cancelBackup: jest.fn(),
			getBackupDownload: jest.fn(),
			generateBackupDownload: jest.fn(),
			downloadPreparation: jest.fn(),
			getExportManifest: jest.fn(),
			cancelBackupDownload: jest.fn(),
		} as any;

		backupController = new BackupController(mockBackupService);

		app = express();
		app.use(express.json());
		app.use('/api/backups', createBackupRouter(backupController));

		// Default to authenticated
		setupAuthMock(true);
	});

	describe('mode-bound verified exports', () => {
		const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		const manifestUrl = `/api/backups/backup-01/download-preparations/${id}/manifest`;
		it('authenticates manifests before accessing snapshot metadata', async () => {
			setupAuthMock(false);
			expect((await request(app).get(manifestUrl)).status).toBe(401);
			expect(mockBackupService.getExportManifest).not.toHaveBeenCalled();
		});
		it('streams a private manifest with the exact backup, preparation and export mode', async () => {
			const payload = JSON.stringify({ version: 1, mode: 'regular-files' }) + '\n';
			mockBackupService.getExportManifest.mockResolvedValue({
				fileName: 'backup-backup-01-regular-files.manifest.jsonl',
				async streamTo(destination: any, _signal: AbortSignal, ready: () => void) {
					ready();
					destination.write(payload);
				},
			} as any);
			const response = await request(app).get(`${manifestUrl}?exportMode=regular-files`);
			expect(response.status).toBe(200);
			expect(response.text).toBe(payload);
			expect(response.headers['content-type']).toContain('application/x-ndjson');
			expect(response.headers['cache-control']).toBe('private, no-store');
			expect(mockBackupService.getExportManifest).toHaveBeenCalledWith(
				'backup-01',
				id,
				'regular-files'
			);
		});
		it.each([
			'exportMode=other',
			'exportMode=full&exportMode=regular-files',
			'repository=other',
			'snapshotId=latest',
		])('refuses ambiguous modes and caller overrides: %s', async query => {
			expect((await request(app).get(`${manifestUrl}?${query}`)).status).toBe(400);
			expect(
				(await request(app).post(`/api/backups/backup-01/action/download?${query}`)).status
			).toBe(400);
			expect(mockBackupService.getExportManifest).not.toHaveBeenCalled();
			expect(mockBackupService.generateBackupDownload).not.toHaveBeenCalled();
		});
		it('does not expose a manifest when ownership or the mode proof is refused', async () => {
			mockBackupService.getExportManifest.mockRejectedValueOnce(
				new AppError(403, 'Snapshot access refused.')
			);
			expect((await request(app).get(manifestUrl)).status).toBe(403);
			mockBackupService.getExportManifest.mockRejectedValueOnce(
				new ManagedExportError('export-proof-missing')
			);
			const response = await request(app).get(manifestUrl);
			expect(response.status).toBe(409);
			expect(response.body).toMatchObject({
				success: false,
				code: 'managed-export-refused',
				reason: 'export-proof-missing',
			});
		});
		it('removes archive headers on a safe failure before manifest bytes are sent', async () => {
			mockBackupService.getExportManifest.mockResolvedValue({
				fileName: 'backup-backup-01.manifest.jsonl',
				async streamTo(_destination: any, _signal: AbortSignal, ready: () => void) {
					ready();
					throw new Error('synthetic-private-provider-output');
				},
			} as any);
			const response = await request(app).get(manifestUrl);
			expect(response.status).toBe(500);
			expect(response.headers['content-type']).toContain('application/json');
			expect(response.headers['content-disposition']).toBeUndefined();
			expect(response.text).not.toContain('synthetic-private-provider-output');
		});
		it('carries the selected mode through admission, status, cancellation and transfer', async () => {
			mockBackupService.generateBackupDownload.mockResolvedValue({
				streaming: true,
				preparation: { id, state: 'queued' },
			});
			mockBackupService.downloadPreparation.mockResolvedValue({
				id,
				state: 'queued',
				retryAfterMs: 0,
			} as any);
			mockBackupService.getBackupDownload.mockRejectedValue(
				new ManagedExportError('export-proof-missing')
			);
			expect(
				(await request(app).post('/api/backups/backup-01/action/download?exportMode=regular-files'))
					.status
			).toBe(202);
			expect(mockBackupService.generateBackupDownload).toHaveBeenCalledWith(
				'backup-01',
				undefined,
				expect.any(AbortSignal),
				false,
				'regular-files'
			);
			for (const method of ['get', 'delete'] as const) {
				expect(
					(
						await request(app)[method](
							`/api/backups/backup-01/download-preparations/${id}?exportMode=regular-files`
						)
					).status
				).toBe(200);
				expect(mockBackupService.downloadPreparation).toHaveBeenLastCalledWith(
					'backup-01',
					id,
					method === 'delete',
					'regular-files'
				);
			}
			expect(
				(
					await request(app).get(
						`/api/backups/backup-01/action/download?preparationId=${id}&exportMode=regular-files`
					)
				).status
			).toBe(409);
			expect(mockBackupService.getBackupDownload).toHaveBeenCalledWith(
				'backup-01',
				id,
				'regular-files'
			);
		});
	});

	describe('asynchronous download preparation', () => {
		const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		it('preserves the application same-origin boundary for bodyless creation and cancellation', async () => {
			const guarded = express();
			guarded.use(
				webAccess({ canonical: 'https://example.internal', origins: ['https://example.internal'] })
			);
			guarded.use(express.json());
			guarded.use('/api/backups', createBackupRouter(backupController));
			mockBackupService.generateBackupDownload.mockResolvedValue({
				streaming: true,
				preparation: { id, state: 'queued' },
			});
			mockBackupService.downloadPreparation.mockResolvedValue({
				id,
				state: 'cancelled',
				retryAfterMs: 0,
			} as any);
			for (const [method, route] of [
				['post', '/action/download'],
				['delete', `/download-preparations/${id}`],
			] as const) {
				for (const origin of ['', 'https://other.example.internal']) {
					let rejected = request(guarded)
						[method](`/api/backups/backup-01${route}`)
						.set('Host', 'example.internal');
					if (origin) rejected = rejected.set('Origin', origin);
					expect((await rejected).status).toBe(403);
				}
				const accepted = await request(guarded)
					[method](`/api/backups/backup-01${route}`)
					.set('Host', 'example.internal')
					.set('Origin', 'https://example.internal')
					.set('Sec-Fetch-Site', 'same-origin');
				expect(accepted.status).toBe(method === 'post' ? 202 : 200);
			}
			expect(mockBackupService.generateBackupDownload).toHaveBeenCalledTimes(1);
			expect(mockBackupService.downloadPreparation).toHaveBeenCalledTimes(1);
		});
		it('returns a confirmed 202 job identity and private no-store response', async () => {
			mockBackupService.generateBackupDownload.mockResolvedValue({
				streaming: true,
				preparation: { id, state: 'queued' },
			});
			const response = await request(app).post('/api/backups/backup-01/action/download').send({});
			expect(response.status).toBe(202);
			expect(response.body.result.preparation.id).toBe(id);
			expect(response.headers['cache-control']).toBe('private, no-store');
		});
		it.each(['get', 'delete'] as const)(
			'requires authentication for %s status/cancellation',
			async method => {
				setupAuthMock(false);
				const response = await request(app)[method](
					`/api/backups/backup-01/download-preparations/${id}`
				);
				expect(response.status).toBe(401);
				expect(mockBackupService.downloadPreparation).not.toHaveBeenCalled();
			}
		);
		it.each(['get', 'delete'] as const)(
			'binds %s to the backup and exact job, with no caller options',
			async method => {
				mockBackupService.downloadPreparation.mockResolvedValue({
					id,
					state: 'indexing',
					retryAfterMs: 2000,
				} as any);
				const response = await request(app)[method](
					`/api/backups/backup-01/download-preparations/${id}`
				);
				expect(response.status).toBe(200);
				expect(response.headers['retry-after']).toBe('2');
				expect(mockBackupService.downloadPreparation).toHaveBeenCalledWith(
					'backup-01',
					id,
					method === 'delete',
					'full'
				);
				const rejected = await request(app)[method](
					`/api/backups/backup-01/download-preparations/${id}?repository=other`
				);
				expect(rejected.status).toBe(400);
				expect(mockBackupService.downloadPreparation).toHaveBeenCalledTimes(1);
			}
		);
		it('allows only a bounded preparation identity on authenticated GET Download', async () => {
			mockBackupService.getBackupDownload.mockRejectedValue(new Error('fixture'));
			await request(app).get(`/api/backups/backup-01/action/download?preparationId=${id}`);
			expect(mockBackupService.getBackupDownload).toHaveBeenCalledWith('backup-01', id);
			mockBackupService.getBackupDownload.mockClear();
			expect(
				(await request(app).get('/api/backups/backup-01/action/download?preparationId=latest'))
					.status
			).toBe(400);
			expect(mockBackupService.getBackupDownload).not.toHaveBeenCalled();
		});
	});
	describe('bounded managed snapshot pages', () => {
		it('requires authentication before any metadata work', async () => {
			setupAuthMock(false);
			expect((await request(app).get('/api/backups/backup-01/files/page')).status).toBe(401);
			expect(mockBackupService.getSnapshotPage).not.toHaveBeenCalled();
		});
		it.each([
			'limit=501',
			'limit=0',
			'offset=-1',
			'offset=500001',
			'offset=1.5',
			'sort=command',
			'order=other',
			'replicationId=mirror',
			'repository=other',
			'path=../escape',
			'path=%2Fsrv%2F..%2Fescape',
			'limit=2&limit=3',
			`search=${'a'.repeat(129)}`,
		])('rejects invalid parameters: %s', async query => {
			expect((await request(app).get(`/api/backups/backup-01/files/page?${query}`)).status).toBe(
				400
			);
			expect(mockBackupService.getSnapshotPage).not.toHaveBeenCalled();
		});
		it('returns indexing status without a partial listing, with a bounded retry hint', async () => {
			mockBackupService.getSnapshotPage.mockResolvedValue({
				status: 'indexing',
				retryAfterMs: 1000,
			});
			const response = await request(app).get('/api/backups/backup-01/files/page');
			expect(response.status).toBe(202);
			expect(response.headers['retry-after']).toBe('1');
			expect(response.body.result).toEqual({ status: 'indexing', retryAfterMs: 1000 });
		});
		it('passes only validated page arguments and request cancellation to the service', async () => {
			mockBackupService.getSnapshotPage.mockResolvedValue({
				status: 'ready',
				files: [],
				total: 0,
			} as any);
			const response = await request(app).get(
				'/api/backups/backup-01/files/page?path=%2Fsrv&limit=20&offset=40&sort=size&order=desc'
			);
			expect(response.status).toBe(200);
			expect(response.headers['cache-control']).toBe('private, no-store');
			expect(mockBackupService.getSnapshotPage).toHaveBeenCalledWith(
				'backup-01',
				{ path: '/srv', limit: 20, offset: 40, sort: 'size', order: 'desc' },
				expect.any(AbortSignal)
			);
		});
		it.each([
			['index-resource-limit', 429],
			['metadata-invalid', 422],
			['index-unavailable', 503],
		] as const)('retains the closed %s error and status', async (code, status) => {
			mockBackupService.getSnapshotPage.mockRejectedValue(new SnapshotIndexError(code));
			const response = await request(app).get('/api/backups/backup-01/files/page');
			expect(response.status).toBe(status);
			expect(response.body.code).toBe(code);
		});
		it('sanitizes unknown failures on both metadata endpoints', async () => {
			mockBackupService.getSnapshotPage.mockRejectedValue(
				new Error('synthetic-private-provider-config')
			);
			mockBackupService.getSnapshotFiles.mockRejectedValue(
				new Error('synthetic-private-provider-config')
			);
			for (const route of ['files', 'files/page']) {
				const response = await request(app).get(`/api/backups/backup-01/${route}`);
				expect(response.status).toBe(500);
				expect(JSON.stringify(response.body)).not.toContain('synthetic-private');
			}
		});
	});
	describe('DELETE /api/backups/:id', () => {
		it('returns the retained database dependency code with HTTP 409', async () => {
			mockBackupService.deleteBackup.mockRejectedValue(new RetainedRestoreDependencyError());
			const response = await request(app).delete('/api/backups/backup-1');
			expect(response.status).toBe(409);
			expect(response.body).toMatchObject({
				success: false,
				code: 'RETAINED_DATABASE_RESTORE_DEPENDENCY',
			});
			expect(response.body.error).toContain('/database-restores');
		});
		it('should return 401 if not authenticated', async () => {
			setupAuthMock(false);

			const response = await request(app).delete('/api/backups/backup-1');

			expect(response.status).toBe(401);
			expect(mockBackupService.getBackupDownload).not.toHaveBeenCalled();
			expect(mockBackupService.generateBackupDownload).not.toHaveBeenCalled();
		});

		it('should delete a backup when authenticated', async () => {
			mockBackupService.deleteBackup.mockResolvedValue({ success: true, result: true } as any);

			const response = await request(app)
				.delete('/api/backups/backup-1')
				.set('Cookie', ['token=valid-token']);

			expect(response.status).toBe(200);
			expect(mockBackupService.deleteBackup).toHaveBeenCalledWith('backup-1', true);
		});
	});

	describe('GET /api/backups/:id/files', () => {
		it('should return 401 if not authenticated', async () => {
			setupAuthMock(false);

			const response = await request(app).get('/api/backups/backup-1/files');

			expect(response.status).toBe(401);
		});

		it('should return snapshot files when authenticated', async () => {
			mockBackupService.getSnapshotFiles.mockResolvedValue([
				{ name: 'file1.txt', size: 100 },
				{ name: 'file2.txt', size: 200 },
			] as any);

			const response = await request(app)
				.get('/api/backups/backup-1/files')
				.set('Cookie', ['token=valid-token']);

			expect(response.status).toBe(200);
			expect(mockBackupService.getSnapshotFiles).toHaveBeenCalledWith('backup-1', undefined);
		});
	});

	describe('GET /api/backups/:id/progress', () => {
		it('should return 401 if not authenticated', async () => {
			setupAuthMock(false);

			const response = await request(app)
				.get('/api/backups/backup-1/progress')
				.query({ sourceId: 'device-1', sourceType: 'device' });

			expect(response.status).toBe(401);
		});

		it('should return backup progress when authenticated', async () => {
			mockBackupService.getBackupProgress.mockResolvedValue({
				percent: 50,
				filesProcessed: 100,
			} as any);

			const response = await request(app)
				.get('/api/backups/backup-1/progress')
				.query({ sourceId: 'device-1', sourceType: 'device' })
				.set('Cookie', ['token=valid-token']);

			expect(response.status).toBe(200);
			expect(mockBackupService.getBackupProgress).toHaveBeenCalledWith('backup-1');
		});
	});

	describe('POST /api/backups/:id/action/cancel', () => {
		it('should return 401 if not authenticated', async () => {
			setupAuthMock(false);

			const response = await request(app)
				.post('/api/backups/backup-1/action/cancel')
				.query({ planId: 'plan-1' });

			expect(response.status).toBe(401);
		});

		it('should cancel a backup when authenticated', async () => {
			mockBackupService.cancelBackup.mockResolvedValue({ success: true } as any);

			const response = await request(app)
				.post('/api/backups/backup-1/action/cancel')
				.query({ planId: 'plan-1' })
				.set('Cookie', ['token=valid-token']);

			expect(response.status).toBe(200);
			expect(mockBackupService.cancelBackup).toHaveBeenCalledWith('plan-1', 'backup-1');
		});
	});

	describe('GET /api/backups/:id/action/download', () => {
		it('should return 401 if not authenticated', async () => {
			setupAuthMock(false);

			const response = await request(app).get('/api/backups/backup-1/action/download');

			expect(response.status).toBe(401);
			expect(mockBackupService.getBackupDownload).not.toHaveBeenCalled();
		});

		it('should initiate backup download when authenticated', async () => {
			// For streaming responses, we just verify the service was called
			// The actual streaming is handled by the controller
			mockBackupService.getBackupDownload.mockImplementation(async () => {
				throw new Error('Stream test - expected');
			});

			const response = await request(app)
				.get('/api/backups/backup-1/action/download')
				.set('Cookie', ['token=valid-token']);

			expect(mockBackupService.getBackupDownload).toHaveBeenCalledWith('backup-1');
			expect(response.status).toBe(500); // Error because we threw in mock
		});
		it('streams the remote TAR with safe attachment/cache headers and no JSON envelope', async () => {
			const bytes = Buffer.from([0, 255, 1, 2, 0]);
			mockBackupService.getBackupDownload.mockResolvedValue({
				fileName: 'backup-backup-01.tar',
				streamTo: async (destination: any, signal: AbortSignal, ready: () => void) => {
					expect(signal.aborted).toBe(false);
					ready();
					destination.write(bytes);
				},
			});
			const response = await request(app)
				.get('/api/backups/backup-01/action/download')
				.buffer(true)
				.parse((response, done) => {
					const chunks: Buffer[] = [];
					response.on('data', chunk => chunks.push(chunk));
					response.on('end', () => done(null, Buffer.concat(chunks)));
				});
			expect(response.status).toBe(200);
			expect(response.headers['content-type']).toBe('application/x-tar');
			expect(response.headers['content-disposition']).toBe(
				'attachment; filename="backup-backup-01.tar"'
			);
			expect(response.headers['cache-control']).toBe('private, no-store');
			expect(response.body).toEqual(bytes);
		});
		it.each(['wrong-password', 'execution-failed'] as const)(
			'returns sanitized %s before stream headers',
			async code => {
				mockBackupService.getBackupDownload.mockResolvedValue({
					fileName: 'backup-backup-01.tar',
					streamTo: async () => {
						throw new ManagedRepositoryAccessError(code);
					},
				});
				const response = await request(app).get('/api/backups/backup-01/action/download');
				expect(response.status).toBe(502);
				expect(response.headers['content-disposition']).toBeUndefined();
				expect(response.body).toEqual({
					success: false,
					error: `Managed repository access failed (${code}).`,
					code,
				});
			}
		);
		it('never exposes a raw provider error in an early HTTP failure', async () => {
			mockBackupService.getBackupDownload.mockResolvedValue({
				fileName: 'backup-backup-01.tar',
				streamTo: async () => {
					throw new Error('synthetic-password raw credential config');
				},
			});
			const response = await request(app).get('/api/backups/backup-01/action/download');
			expect(response.status).toBe(502);
			expect(response.body).toEqual({ success: false, error: 'Remote download failed.' });
		});
	});
	describe('remote Download HTTP disconnect', () => {
		async function listening() {
			const server = http.createServer(app);
			await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
			return {
				server,
				url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/backups/backup-01/action/download`,
			};
		}
		async function close(server: http.Server) {
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
		it('aborts an active GET and awaits session cleanup when the browser disconnects', async () => {
			let activeSignal: AbortSignal | undefined;
			let cleaned = false;
			let finish: () => void;
			const cleanup = new Promise<void>(resolve => {
				finish = resolve;
			});
			mockBackupService.getBackupDownload.mockResolvedValue({
				fileName: 'backup-backup-01.tar',
				streamTo: async (destination: any, signal: AbortSignal, ready: () => void) => {
					activeSignal = signal;
					ready();
					destination.write('partial-tar');
					await new Promise<void>(resolve =>
						signal.addEventListener('abort', () => resolve(), { once: true })
					);
					cleaned = true;
					finish();
					throw new ManagedRepositoryAccessError('cancelled');
				},
			});
			const { server, url } = await listening();
			try {
				const client = http.get(url, response => response.once('data', () => client.destroy()));
				client.on('error', () => undefined);
				await cleanup;
				expect(activeSignal?.aborted).toBe(true);
				expect(cleaned).toBe(true);
			} finally {
				await close(server);
			}
		});
		it('aborts the POST repository preflight on disconnect', async () => {
			let entered: () => void;
			let finished: () => void;
			let activeSignal: AbortSignal | undefined;
			const started = new Promise<void>(resolve => {
				entered = resolve;
			});
			const cleanup = new Promise<void>(resolve => {
				finished = resolve;
			});
			mockBackupService.generateBackupDownload.mockImplementation(async (_, __, signal) => {
				activeSignal = signal;
				entered();
				await new Promise<void>(resolve =>
					signal!.addEventListener('abort', () => resolve(), { once: true })
				);
				finished();
				throw new ManagedRepositoryAccessError('cancelled');
			});
			const { server, url } = await listening();
			try {
				const client = http.request(url, { method: 'POST' });
				client.on('error', () => undefined);
				client.end();
				await started;
				client.destroy();
				await cleanup;
				expect(activeSignal?.aborted).toBe(true);
			} finally {
				await close(server);
			}
		});
		it('terminates a partial response on late failure instead of appending errors/secrets', async () => {
			mockBackupService.getBackupDownload.mockResolvedValue({
				fileName: 'backup-backup-01.tar',
				streamTo: async (destination: any, _: AbortSignal, ready: () => void) => {
					ready();
					destination.write('partial-tar');
					await new Promise<void>(resolve => setImmediate(resolve));
					throw new Error('synthetic-password raw credential config');
				},
			});
			const { server, url } = await listening();
			try {
				let received = '';
				let aborted = false;
				await new Promise<void>((resolve, reject) => {
					const client = http.get(url, response => {
						response.on('data', chunk => {
							received += chunk.toString();
						});
						response.once('aborted', () => {
							aborted = true;
							resolve();
						});
						response.once('end', resolve);
						response.on('error', () => undefined);
					});
					client.on('error', reject);
				});
				expect(aborted).toBe(true);
				expect(received).toBe('partial-tar');
				expect(received).not.toMatch(/synthetic-password|error|success/);
			} finally {
				await close(server);
			}
		});
	});

	describe('POST /api/backups/:id/action/download', () => {
		it('should return 401 if not authenticated', async () => {
			setupAuthMock(false);

			const response = await request(app).post('/api/backups/backup-1/action/download');

			expect(response.status).toBe(401);
			expect(mockBackupService.generateBackupDownload).not.toHaveBeenCalled();
		});

		it('should generate backup download when authenticated', async () => {
			setupAuthMock(true);
			mockBackupService.generateBackupDownload.mockResolvedValue({
				downloadUrl: 'http://example.com/download',
			} as any);

			const response = await request(app)
				.post('/api/backups/backup-1/action/download')
				.send({ files: ['file1.txt', 'file2.txt'] });

			expect(response.status).toBe(200);
			expect(mockBackupService.generateBackupDownload).toHaveBeenCalledWith(
				'backup-1',
				undefined,
				expect.any(AbortSignal),
				true
			);
		});
		it('rejects client credentials/repository URLs/options before any repository access', async () => {
			mockBackupService.generateBackupDownload.mockResolvedValue({ streaming: true });
			const response = await request(app)
				.post('/api/backups/backup-01/action/download')
				.send({
					password: 'synthetic-client-password',
					repository: 'sftp:arbitrary',
					options: { ssh: 'arbitrary-command' },
				});
			expect(response.status).toBe(400);
			expect(response.body).toEqual({ success: false, error: 'Invalid download request.' });
			expect(mockBackupService.generateBackupDownload).not.toHaveBeenCalled();
			expect(response.text).not.toMatch(/password|sftp|ssh/);
		});
		it('rejects a client repository override on GET before service lookup', async () => {
			const response = await request(app)
				.get('/api/backups/backup-01/action/download')
				.query({ repository: 'sftp:arbitrary', password: 'synthetic-client-password' });
			expect(response.status).toBe(400);
			expect(response.body).toEqual({ success: false, error: 'Invalid download request.' });
			expect(mockBackupService.getBackupDownload).not.toHaveBeenCalled();
		});
		it('remote Download remains full-snapshot only, never client-controlled selection', async () => {
			mockBackupService.generateBackupDownload.mockResolvedValue({ streaming: true });
			const response = await request(app)
				.post('/api/backups/backup-01/action/download')
				.send({ files: ['/srv/example-app/index.txt'] });
			expect(response.status).toBe(400);
			expect(response.body).toEqual({
				success: false,
				error: 'Remote downloads support only the complete exact snapshot.',
			});
		});
		it('valid remote preflight exposes only the streaming discriminator', async () => {
			mockBackupService.generateBackupDownload.mockResolvedValue({ streaming: true });
			const response = await request(app).post('/api/backups/backup-01/action/download');
			expect(response.status).toBe(200);
			expect(response.body).toEqual({ success: true, result: { streaming: true } });
		});
	});

	describe('DELETE /api/backups/:id/action/download', () => {
		it('should return 401 if not authenticated', async () => {
			setupAuthMock(false);

			const response = await request(app)
				.delete('/api/backups/backup-1/action/download')
				.query({ planId: 'plan-1' });

			expect(response.status).toBe(401);
		});

		it('should cancel backup download when authenticated', async () => {
			mockBackupService.cancelBackupDownload.mockResolvedValue({ success: true } as any);

			const response = await request(app)
				.delete('/api/backups/backup-1/action/download')
				.query({ planId: 'plan-1' })
				.set('Cookie', ['token=valid-token']);

			expect(response.status).toBe(200);
			expect(mockBackupService.cancelBackupDownload).toHaveBeenCalledWith('plan-1', 'backup-1');
		});
	});

	it('exposes saved path diagnostics only through an authenticated no-store progress response', async () => {
		const sourceFailure = {
			failureStage: 'restic-backup',
			failureCode: 'source-entry-inaccessible',
			sourceDiagnostics: {
				version: 1,
				origin: 'restic',
				problemCount: 1,
				countIsLowerBound: true,
				entries: [
					{
						relativePath: 'app/logs/id_rsa',
						entryType: 'unknown',
						errno: 'EACCES',
						excluded: false,
					},
				],
			},
		};
		mockBackupService.getBackupProgress.mockResolvedValue({ sourceFailure });
		const url = '/api/backups/backup-01/progress?sourceId=app-01&sourceType=device';
		setupAuthMock(false);
		for (const authorization of ['', 'Bearer synthetic-invalid-api-key']) {
			const response = await request(app).get(url).set('Authorization', authorization);
			expect(response.status).toBe(401);
			expect(JSON.stringify(response.body)).not.toContain('app/logs/id_rsa');
		}
		expect(mockBackupService.getBackupProgress).not.toHaveBeenCalled();
		setupAuthMock(true);
		const response = await request(app).get(url);
		expect(response.status).toBe(200);
		expect(response.headers['cache-control']).toBe('private, no-store');
		expect(response.body.sourceFailure).toEqual(sourceFailure);
	});
});

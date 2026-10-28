/** New OS process used only by the disposable lab's restart acceptance case. */
import assert from 'node:assert/strict';
import path from 'node:path';
import express from 'express';
import { BackupService } from '../../src/services/BackupServices';
import { BackupController } from '../../src/controllers/BackupController';
import { createBackupRouter } from '../../src/routes/backups';
import { RemoteRepositoryRecoveryService } from '../../src/services/RemoteRepositoryRecoveryService';
import { ManagedSftpRepositorySession } from '../../src/utils/restic/ManagedSftpRepositorySession';
assert.equal(process.getuid?.(), 1000);
assert(process.send, 'Requires private lab IPC.');
process.once('message', async (input: any) => {
	let service: RemoteRepositoryRecoveryService | undefined;
	try {
		assert(input.scratch.startsWith('/lab/run-'));
		assert.equal(path.dirname(input.scratch), '/lab');
		const ids = new Map<string, string>(input.snapshotIds),
			plan = input.plan,
			repo = input.repo;
		const backups = {
			getById: async (id: string) =>
				ids.has(id)
					? {
							...plan,
							id,
							planId: plan.id,
							status: 'completed',
							success: true,
							inProgress: false,
							completionStats: { snapshot_id: ids.get(id), sourcePaths: [input.source] },
						}
					: undefined,
		};
		const native = new ManagedSftpRepositorySession();
		service = new RemoteRepositoryRecoveryService(
			{ getByPlanId: async () => repo } as any,
			backups as any,
			{ getById: async () => plan } as any,
			{} as any,
			{ getSftpRecoveryOptions: async () => input.options },
			{ getAgentById: async () => ({ deviceId: 'app-01' }) } as any,
			input.holdIndex
				? {
						withSession: (access, consume, signal, limits) =>
							native.withSession(
								access,
								session =>
									consume({
										...session,
										streamFiles: (id, append) =>
											session.streamFiles(id, async node => {
												await append(node);
												if (!input.holdIndex) return;
												input.holdIndex = false;
												process.send!({ indexing: true });
												await new Promise<void>((resolve, reject) => {
													const abort = () => {
														clearTimeout(timer);
														reject(new Error('Fixture stopped'));
													};
													const timer = setTimeout(() => {
														signal?.removeEventListener('abort', abort);
														resolve();
													}, 5 * 60_000);
													signal?.addEventListener('abort', abort, { once: true });
													if (signal?.aborted) abort();
												});
											}),
									}),
								signal,
								limits
							),
					}
				: undefined,
			input.secret,
			path.join(input.scratch, 'staging')
		);
		const backupsApi = new BackupService(
			{} as any,
			{} as any,
			{} as any,
			backups as any,
			{} as any,
			{} as any,
			undefined,
			service
		);
		const app = express();
		app.use(express.json());
		app.use('/api/backups', createBackupRouter(new BackupController(backupsApi)));
		const server = app.listen(0, '127.0.0.1');
		await new Promise<void>(r => server.once('listening', r));
		process.send!({ port: (server.address() as any).port });
		process.once('message', async () => {
			server.closeAllConnections();
			await new Promise<void>(r => server.close(() => r()));
			await service!.close();
			process.send!({ closed: true, nodePeakRssBytes: process.resourceUsage().maxRSS * 1024 });
			process.disconnect();
		});
	} catch {
		await service?.close();
		process.send!({ failure: 'restart-fixture-failed' });
		process.disconnect();
		process.exitCode = 1;
	}
});

/** Only synthetic configuration received inside disposable Linux fixtures. */
import express from 'express';
import net from 'node:net';
import Cryptr from 'cryptr';
import { RemoteRepositoryRecoveryService } from '../../src/services/RemoteRepositoryRecoveryService';
import {
	ManagedSftpRepositorySession,
	type ManagedRepositorySessionProvider,
} from '../../src/utils/restic/ManagedSftpRepositorySession';
import { BackupService } from '../../src/services/BackupServices';
import { BackupController } from '../../src/controllers/BackupController';
import { createBackupRouter } from '../../src/routes/backups';
export type LinkFixtureConfig = {
	snapshots: Record<string, string>;
	source: string;
	secret: string;
	password: string;
	sftpPassword: string;
	port: number;
	staging: string;
};
export async function startLinkFixture(
	config: LinkFixtureConfig,
	sessions: ManagedRepositorySessionProvider = new ManagedSftpRepositorySession()
) {
	const plan = {
		id: 'plan-01',
		sourceId: 'app-01',
		sourceType: 'device',
		method: 'backup',
		storageId: 'storage-01',
		storagePath: 'application',
	};
	const repository = {
		id: 'repository-01',
		planId: plan.id,
		agentId: 'agent-01',
		storageId: plan.storageId,
		storagePath: plan.storagePath,
		initializedAt: new Date(),
		encryptedPassword: new Cryptr(config.secret).encrypt(config.password),
	};
	const backups = {
		getById: async (id: string) =>
			config.snapshots[id]
				? {
						...plan,
						id,
						planId: plan.id,
						status: 'completed',
						success: true,
						inProgress: false,
						completionStats: { snapshot_id: config.snapshots[id], sourcePaths: [config.source] },
					}
				: undefined,
	};
	const plans = { getById: async () => plan };
	const rows = new Map<string, any>();
	const restores = {
		isRestoreRunning: async () => false,
		create: async (row: any) => {
			rows.set(row.id, row);
			return row;
		},
		update: async (id: string, changes: any) => {
			const row = { ...rows.get(id), ...changes };
			rows.set(id, row);
			return row;
		},
	};
	const recovery = new RemoteRepositoryRecoveryService(
		{ getByPlanId: async () => repository } as any,
		backups as any,
		plans as any,
		restores as any,
		{
			getSftpRecoveryOptions: async () => ({
				host: '127.0.0.1',
				port: String(config.port),
				user: 'fixture-user',
				pass: config.sftpPassword,
			}),
		},
		{ getAgentById: async () => ({ deviceId: 'app-01' }) } as any,
		sessions,
		config.secret,
		config.staging
	);
	const backupService = new BackupService(
		{} as any,
		{} as any,
		plans as any,
		backups as any,
		restores as any,
		{} as any,
		undefined,
		recovery
	);
	const app = express();
	app.use(express.json());
	app.use('/api/backups', createBackupRouter(new BackupController(backupService)));
	const server = app.listen(0, '127.0.0.1');
	await new Promise<void>(resolve => server.once('listening', resolve));
	return {
		app,
		recovery,
		rows,
		base: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/api/backups`,
		close: async () => {
			await recovery.close();
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
}

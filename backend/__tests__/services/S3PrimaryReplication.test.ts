import Cryptr from 'cryptr';
import { ManagedReplicationService } from '../../src/services/ManagedReplicationService';
import { configService } from '../../src/services/ConfigService';
import { sftpRepositoryIdentity } from '../../src/utils/managedReplicaIdentity';

jest.mock('../../src/utils/logger', () => ({ serverLogger: { info: jest.fn(), warn: jest.fn() } }));

/** Stage 2 (docs/S3_PRIMARY_REPLICATION.md): an S3 primary replicates to SFTP on the server. */
const secret = 'synthetic-replication-test-secret';
const snapshotId = 'a'.repeat(64);
const encrypt = (values: Record<string, string>) =>
	Object.fromEntries(
		Object.entries(values).map(([key, value]) => [key, new Cryptr(configService.config.SECRET).encrypt(value)])
	);
const sftpMirror = (id: string, host = 'sftp.example.internal') => ({
	id,
	name: `SFTP ${id}`,
	type: 'sftp',
	settings: {},
	credentials: encrypt({ host, user: 'fixture', pass: 'synthetic-replica-password' }),
});
const replica = (id = '01', storagePath = `replicas/plan-01-${id}`) => ({
	replicationId: `replica-${id}`,
	storageId: `mirror-${id}`,
	storagePath,
	storageName: `Mirror ${id}`,
	storageType: 'sftp',
	addedAt: 1,
});

function fixture() {
	const plan: any = {
		id: 'plan-01',
		sourceId: 'device-01',
		sourceType: 'device',
		storageId: 'primary-s3',
		storagePath: 'bucket-01/agents/plan-01',
		method: 'backup',
		settings: { replication: { enabled: true, concurrent: false, recoveryPolicy: 'assisted', storages: [replica()] } },
	};
	const backup: any = {
		id: 'backup-01',
		planId: plan.id,
		sourceId: plan.sourceId,
		sourceType: 'device',
		method: 'backup',
		storageId: plan.storageId,
		storagePath: plan.storagePath,
		status: 'completed',
		inProgress: false,
		success: true,
		encryption: true,
		completionStats: { snapshot_id: snapshotId },
	};
	const repository = {
		id: 'repository-01',
		planId: plan.id,
		agentId: 'agent-01',
		storageId: plan.storageId,
		storagePath: plan.storagePath,
		initializedAt: new Date(),
		encryptedPassword: new Cryptr(secret).encrypt('synthetic-repository-password'),
	};
	const rows: any[] = [];
	const destinations = new Map<string, any>();
	const jobs: any = {
		listByBackup: jest.fn(() => rows),
		listRunnable: jest.fn(() => rows.filter(row => row.status === 'pending')),
		reserveDestination: jest.fn(binding => {
			const row = { ...binding, initState: 'uninitialized', actualRepositoryId: null };
			destinations.set(binding.destinationFingerprint, row);
			return row;
		}),
		enqueue: jest.fn(input => {
			const row = { ...input, status: 'pending', attempts: 0 };
			rows.push(row);
			return row;
		}),
		claim: jest.fn((id, token) => {
			const row = rows.find(item => item.id === id);
			Object.assign(row, { status: 'running', ownerToken: token, attempts: row.attempts + 1 });
			return row;
		}),
		getDestination: jest.fn(fp => destinations.get(fp)),
		beginInitialization: jest.fn(() => true),
		finalizeInitialization: jest.fn(() => true),
		finish: jest.fn((id, _token, result) => {
			Object.assign(rows.find(row => row.id === id), { ...result, lastErrorCode: result.failureCode });
			return true;
		}),
	};
	const storageRecords: Record<string, any> = {
		'primary-s3': { id: 'primary-s3', name: 'HCP', type: 's3compatible', settings: { hcp_mode: true } },
		'mirror-01': sftpMirror('mirror-01'),
		'mirror-02': sftpMirror('mirror-02', 'sftp-2.example.internal'),
	};
	const storages: any = { getById: jest.fn(async (id: string) => storageRecords[id]) };
	const remote = {
		getSftpRecoveryOptions: jest.fn(async () => ({
			host: 'sftp.example.internal',
			user: 'fixture',
			pass: 'synthetic-replica-password',
		})),
		getRepositoryAccessOptions: jest.fn(async () => ({
			type: 's3',
			endpoint: 'https://s3.example.internal',
			access_key_id: 'synthetic-access',
			secret_access_key: 'synthetic-secret',
			force_path_style: 'true',
			env_auth: 'false',
		})),
	};
	const proof = {
		repositoryConfigId: 'b'.repeat(64),
		snapshot: { id: snapshotId, tree: 'f'.repeat(64), paths: ['/srv/example-app'], tags: ['pluton-plan-plan-01', 'pluton-backup-backup-01'] },
	};
	const executor: any = {
		inspectSource: jest.fn(async () => proof),
		copy: jest.fn(async (input: any) => {
			await input.beginInitialization();
			await input.bindRepository('c'.repeat(64));
			return { snapshotId: 'e'.repeat(64), repositoryConfigId: 'c'.repeat(64) };
		}),
	};
	const service = new ManagedReplicationService(
		jobs,
		{ getById: jest.fn(async () => backup), update: jest.fn(async (_id: string, patch: any) => Object.assign(backup, patch)) } as any,
		{ getById: jest.fn(async () => plan), getAll: jest.fn(async () => []) } as any,
		{ getByPlanId: jest.fn(async () => repository) } as any,
		{ getAgentById: jest.fn(async () => ({ agentId: 'agent-01', deviceId: 'device-01' })) } as any,
		storages,
		remote,
		executor,
		secret
	);
	return { service, plan, backup, rows, jobs, storageRecords, remote, executor, destinations };
}

describe('S3 primary replication to SFTP (stage 2)', () => {
	it('accepts one or two SFTP replicas for an S3 primary', async () => {
		const f = fixture();
		await expect(f.service.validatePlan(f.plan)).resolves.toBeUndefined();
		f.plan.settings.replication.storages = [replica(), replica('02')];
		await expect(f.service.validatePlan(f.plan)).resolves.toBeUndefined();
		expect(f.remote.getSftpRecoveryOptions).toHaveBeenCalledWith('mirror-02');
	});

	it('refuses an S3 replica for an S3 primary and an SFTP replica for an SFTP primary', async () => {
		const f = fixture();
		f.storageRecords['mirror-01'] = { id: 'mirror-01', type: 's3compatible', settings: { hcp_mode: true } };
		await expect(f.service.validatePlan(f.plan)).rejects.toMatchObject({
			statusCode: 400,
			message: 'An S3 primary replicates to an SFTP destination.',
		});
		const g = fixture();
		g.storageRecords['primary-s3'] = { id: 'primary-s3', type: 'sftp', settings: {} };
		await expect(g.service.validatePlan(g.plan)).rejects.toMatchObject({
			statusCode: 400,
			message: 'Managed Agent replication requires an HTTPS S3-compatible destination.',
		});
	});

	it('refuses overlapping SFTP replica folders within the plan and across plans', async () => {
		const f = fixture();
		f.plan.settings.replication.storages = [replica('01', 'replicas/app'), { ...replica('02', 'replicas/app/child'), storageId: 'mirror-01' }];
		await expect(f.service.validatePlan(f.plan)).rejects.toMatchObject({ statusCode: 409 });
		const g = fixture();
		const other = { id: 'other-plan', storageId: 'mirror-01', storagePath: 'replicas', settings: {} };
		(g.service as any).plans.getAll.mockResolvedValue([other]);
		await expect(g.service.validatePlan(g.plan)).rejects.toMatchObject({ statusCode: 409 });
		other.storagePath = 'replicas-other';
		await expect(g.service.validatePlan(g.plan)).resolves.toBeUndefined();
	});

	it('copies from the S3 primary read path to the SFTP replica and records the verified receipt', async () => {
		const f = fixture();
		await f.service.enqueueBackup('backup-01');
		const identity = sftpRepositoryIdentity(f.storageRecords['mirror-01'], 'replicas/plan-01-01');
		expect(f.jobs.reserveDestination).toHaveBeenCalledWith(
			expect.objectContaining({
				destinationFingerprint: identity.fingerprint,
				destinationAuthority: 'sftp://fixture@sftp.example.internal:22/~',
				destinationPrefix: 'replicas/plan-01-01',
			})
		);
		expect(f.executor.inspectSource).toHaveBeenCalledWith(
			expect.objectContaining({
				access: expect.objectContaining({ options: expect.objectContaining({ type: 's3' }), repositoryPath: 'bucket-01/agents/plan-01' }),
				environment: expect.any(Object),
			}),
			expect.anything()
		);
		await f.service.tick();
		const input = f.executor.copy.mock.calls[0][0];
		expect(input.destination).toEqual({
			options: { host: 'sftp.example.internal', user: 'fixture', pass: 'synthetic-replica-password' },
			repositoryPath: 'replicas/plan-01-01',
		});
		expect(f.rows[0]).toMatchObject({ status: 'completed', destinationSnapshotId: 'e'.repeat(64) });
		expect(f.backup.mirrors).toEqual([
			expect.objectContaining({ replicationId: 'replica-01', storageType: 'sftp', status: 'completed', snapshotId: 'e'.repeat(64) }),
		]);
		expect(JSON.stringify(f.rows)).not.toMatch(/synthetic-(secret|replica-password|access)/);
	});

	it('refuses a copy when the SFTP storage was redirected to another host after admission', async () => {
		const f = fixture();
		await f.service.enqueueBackup('backup-01');
		f.storageRecords['mirror-01'] = sftpMirror('mirror-01', 'other.example.internal');
		await f.service.tick();
		expect(f.executor.copy).not.toHaveBeenCalled();
		expect(f.rows[0]).toMatchObject({ status: 'failed', lastErrorCode: 'destination-binding-changed' });
	});
});

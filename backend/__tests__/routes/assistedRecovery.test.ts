import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { configService } from '../../src/services/ConfigService';
import { AssistedRecoveryController } from '../../src/controllers/AssistedRecoveryController';
import { createAssistedRecoveryRouter } from '../../src/routes/assistedRecovery';
const cookie = 'token=' + jwt.sign({ user: 'fixture-owner' }, configService.config.SECRET!);
const job = 'a'.repeat(24),
	body = {
		planId: 'plan-01',
		backupId: 'backup-01',
		requestKey: '00000000-0000-4000-8000-000000000001',
		mode: 'manual-replica',
		includes: [],
		excludes: [],
	};
describe('assisted recovery API authorization and strict input boundary', () => {
	const service: any = {
		start: jest.fn(async () => ({ id: job })),
		list: jest.fn(() => []),
		get: jest.fn(() => ({ id: job })),
		approve: jest.fn(async () => ({ id: job })),
		cancel: jest.fn(async () => ({ id: job })),
	};
	const app = express();
	app.use(express.json());
	app.use(
		'/api/assisted-recovery',
		createAssistedRecoveryRouter(new AssistedRecoveryController(service))
	);
	beforeEach(() => jest.clearAllMocks());
	it.each(['get', 'post'])('requires an authenticated session for %s', async method => {
		await (
			method === 'get'
				? request(app).get('/api/assisted-recovery?planId=plan-01&backupId=backup-01')
				: request(app).post('/api/assisted-recovery').send(body)
		).expect(401);
		expect(service.start).not.toHaveBeenCalled();
		expect(service.list).not.toHaveBeenCalled();
	});
	it('read-only rediscovery accepts exact scope, hashes the signed owner and never creates work', async () => {
		const result = await request(app)
			.get('/api/assisted-recovery?planId=plan-01&backupId=backup-01')
			.set('Cookie', cookie)
			.expect(200);
		expect(result.headers['cache-control']).toBe('private, no-store');
		expect(service.list).toHaveBeenCalledWith(
			expect.stringMatching(/^[a-f0-9]{64}$/),
			'plan-01',
			'backup-01'
		);
		expect(service.start).not.toHaveBeenCalled();
	});
	it.each([
		'owner',
		'target',
		'overwrite',
		'delete',
		'endpoint',
		'password',
		'storageId',
		'snapshotId',
		'replicationId',
	])('rejects client override %s before admission', async field => {
		await request(app)
			.post('/api/assisted-recovery')
			.set('Cookie', cookie)
			.send({ ...body, [field]: 'untrusted' })
			.expect(400);
		expect(service.start).not.toHaveBeenCalled();
	});
	it('admits an explicit request, but neither GET nor close/view constitute approval', async () => {
		await request(app).post('/api/assisted-recovery').set('Cookie', cookie).send(body).expect(202);
		await request(app)
			.get('/api/assisted-recovery/' + job)
			.set('Cookie', cookie)
			.expect(200);
		expect(service.approve).not.toHaveBeenCalled();
		expect(service.cancel).not.toHaveBeenCalled();
		await request(app)
			.post('/api/assisted-recovery/' + job + '/approve')
			.set('Cookie', cookie)
			.send({ replicationId: 'replica-01', target: 'other' })
			.expect(400);
		await request(app)
			.post('/api/assisted-recovery/' + job + '/approve')
			.set('Cookie', cookie)
			.send({ replicationId: 'replica-01' })
			.expect(202);
		expect(service.approve).toHaveBeenCalledTimes(1);
	});
	it('requires complete read scope and refuses query overrides and malformed job IDs', async () => {
		await request(app)
			.get('/api/assisted-recovery?planId=plan-01')
			.set('Cookie', cookie)
			.expect(400);
		await request(app)
			.get('/api/assisted-recovery?planId=plan-01&backupId=backup-01&owner=other')
			.set('Cookie', cookie)
			.expect(400);
		await request(app).get('/api/assisted-recovery/invalid').set('Cookie', cookie).expect(400);
		expect(service.list).not.toHaveBeenCalled();
		expect(service.get).not.toHaveBeenCalled();
	});
});

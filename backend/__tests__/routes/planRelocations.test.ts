import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { configService } from '../../src/services/ConfigService';
import { PlanRepositoryRelocationController } from '../../src/controllers/PlanRepositoryRelocationController';
import { createPlanRelocationRouter } from '../../src/routes/planRelocations';
import { PlanService } from '../../src/services/PlanService';
import { AppError } from '../../src/utils/AppError';

const cookie = 'token=' + jwt.sign({ user: 'fixture-admin' }, configService.config.SECRET!);
const id = 'a'.repeat(24);

describe('plan repository relocation API boundary', () => {
	const service: any = {
		overview: jest.fn(async () => ({ supported: true, relocations: [] })),
		start: jest.fn(async () => ({ id })),
		get: jest.fn(async () => ({ id })),
		cancel: jest.fn(async () => ({ id })),
		switch: jest.fn(async () => ({ id })),
		revert: jest.fn(async () => ({ id })),
		deleteSourceCopy: jest.fn(async () => ({ id })),
	};
	const app = express();
	app.use(express.json());
	app.use('/api/plan-relocations', createPlanRelocationRouter(new PlanRepositoryRelocationController(service)));
	beforeEach(() => jest.clearAllMocks());

	it('requires an authenticated session', async () => {
		await request(app).get('/api/plan-relocations?planId=plan-01').expect(401);
		await request(app)
			.post('/api/plan-relocations')
			.send({ planId: 'plan-01', storageId: 'storage-02', storagePath: 'managed/x' })
			.expect(401);
		await request(app).post(`/api/plan-relocations/${id}/switch`).expect(401);
		await request(app).delete(`/api/plan-relocations/${id}/source-copy`).expect(401);
		expect(service.start).not.toHaveBeenCalled();
		expect(service.switch).not.toHaveBeenCalled();
		expect(service.deleteSourceCopy).not.toHaveBeenCalled();
	});

	it('starts with the exact three fields and answers 202', async () => {
		const response = await request(app)
			.post('/api/plan-relocations')
			.set('Cookie', cookie)
			.send({ planId: 'plan-01', storageId: 'storage-02', storagePath: 'managed/x' })
			.expect(202);
		expect(response.headers['cache-control']).toBe('private, no-store');
		expect(service.start).toHaveBeenCalledWith({
			planId: 'plan-01',
			storageId: 'storage-02',
			storagePath: 'managed/x',
		});
	});

	it.each([
		{ planId: 'plan-01', storageId: 'storage-02' },
		{ planId: 'plan-01', storageId: 'storage-02', storagePath: 'managed/x', skipVerification: true },
		{ planId: '../plan', storageId: 'storage-02', storagePath: 'managed/x' },
	])('rejects a malformed start request %#', async body => {
		await request(app).post('/api/plan-relocations').set('Cookie', cookie).send(body).expect(400);
		expect(service.start).not.toHaveBeenCalled();
	});

	it('rejects overrides on actions and malformed relocation IDs', async () => {
		await request(app)
			.post(`/api/plan-relocations/${id}/switch`)
			.set('Cookie', cookie)
			.send({ force: true })
			.expect(400);
		await request(app)
			.post(`/api/plan-relocations/${id}/revert?force=1`)
			.set('Cookie', cookie)
			.expect(400);
		await request(app).post('/api/plan-relocations/not-an-id/cancel').set('Cookie', cookie).expect(400);
		await request(app)
			.delete(`/api/plan-relocations/${id}/source-copy`)
			.set('Cookie', cookie)
			.send({})
			.expect(400);
		expect(service.switch).not.toHaveBeenCalled();
		expect(service.revert).not.toHaveBeenCalled();
		expect(service.cancel).not.toHaveBeenCalled();
		expect(service.deleteSourceCopy).not.toHaveBeenCalled();
	});

	it('maps actions and service errors', async () => {
		await request(app).post(`/api/plan-relocations/${id}/switch`).set('Cookie', cookie).expect(202);
		await request(app).post(`/api/plan-relocations/${id}/cancel`).set('Cookie', cookie).expect(200);
		await request(app)
			.delete(`/api/plan-relocations/${id}/source-copy`)
			.set('Cookie', cookie)
			.send({ confirmTitle: 'Fixture' })
			.expect(202);
		expect(service.deleteSourceCopy).toHaveBeenCalledWith(id, 'Fixture');
		service.revert.mockRejectedValueOnce(new AppError(409, 'A successful backup already exists.'));
		const refused = await request(app)
			.post(`/api/plan-relocations/${id}/revert`)
			.set('Cookie', cookie)
			.expect(409);
		expect(refused.body).toEqual({ success: false, error: 'A successful backup already exists.' });
		service.get.mockRejectedValueOnce(new Error('provider text with secrets'));
		const hidden = await request(app).get(`/api/plan-relocations/${id}`).set('Cookie', cookie).expect(500);
		expect(hidden.body.error).toBe('Repository relocation request failed safely.');
	});
});

describe('plan service while a repository relocation is active', () => {
	const plan = {
		id: 'plan-01',
		title: 'Fixture',
		sourceId: 'app-01',
		sourceType: 'device',
		method: 'backup',
		settings: {},
		isActive: false,
	};
	const planStore: any = {
		getById: jest.fn(async () => plan),
		hasActiveBackups: jest.fn(async () => false),
		beginSourceRemoval: jest.fn(() => () => undefined),
		setActive: jest.fn(),
		update: jest.fn(),
	};
	const relocations = { activeForPlan: jest.fn(() => ({ id })) };
	const service = new PlanService(
		{} as any,
		planStore,
		{} as any,
		{} as any,
		{} as any,
		{} as any,
		undefined,
		undefined,
		undefined,
		relocations as any
	);

	it.each([
		['resume', () => service.resumeBackup('plan-01'), 'resumes automatically'],
		['backup', () => service.performBackup('plan-01'), 'Backups resume'],
		['edit', () => service.updatePlan('plan-01', { title: 'Renamed' } as any), 'locked'],
		['remove', () => service.deletePlan('plan-01', false), 'relocation'],
	])('refuses %s with 409', async (_name, action, message) => {
		await expect(action()).rejects.toMatchObject({ statusCode: 409 });
		await expect(action()).rejects.toThrow(message);
		expect(planStore.setActive).not.toHaveBeenCalled();
		expect(planStore.update).not.toHaveBeenCalled();
	});
});

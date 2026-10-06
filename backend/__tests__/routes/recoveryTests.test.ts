import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import Cookies from 'cookies';
import { RecoveryTestController } from '../../src/controllers/RecoveryTestController';
import { createRecoveryTestRouter } from '../../src/routes/recoveryTests';
import { AppError } from '../../src/utils/AppError';
jest.mock('jsonwebtoken');
jest.mock('cookies');
jest.mock('../../src/services/ConfigService', () => ({
	configService: {
		config: { SECRET: 'synthetic-fixture-secret', APIKEY: 'synthetic-fixture-api-key' },
	},
}));
describe('Recovery API authentication, ownership and safe input', () => {
	let service: any, app: express.Express;
	function authenticate(yes: boolean) {
		(Cookies as jest.Mock).mockImplementation(() => ({
			get: () => (yes ? 'synthetic-token' : undefined),
		}));
		(jwt.verify as jest.Mock).mockImplementation((_token, _secret, callback) =>
			callback(yes ? null : new Error('invalid'))
		);
	}
	beforeEach(() => {
		service = Object.fromEntries(
			['configuration', 'savePolicy', 'saveTarget', 'list', 'get', 'enqueue', 'cancel'].map(
				name => [name, jest.fn(async () => ({ id: 'test-01' }))]
			)
		);
		app = express();
		app.use(express.json());
		app.use('/api/recovery-testing', createRecoveryTestRouter(new RecoveryTestController(service)));
		authenticate(true);
	});
	it.each([
		['get', 'configuration'],
		['put', 'policy'],
		['put', 'target'],
		['get', 'tests'],
		['post', 'tests'],
		['post', 'tests/lookup'],
		['get', 'tests/test-01'],
		['post', 'tests/test-01/cancel'],
	])('protects %s %s with UI-session authentication', async (method, path) => {
		authenticate(false);
		const response = await (request(app) as any)
			[method](`/api/recovery-testing/plan-01/${path}`)
			.send({ backupId: 'backup-01' });
		expect(response.status).toBe(401);
		for (const call of Object.values(service)) expect(call).not.toHaveBeenCalled();
	});
	it('does not permit API key access to recovery/import configuration', async () => {
		authenticate(false);
		expect(
			(
				await request(app)
					.get('/api/recovery-testing/plan-01/configuration')
					.set('Authorization', 'Bearer synthetic-fixture-api-key')
			).status
		).toBe(401);
	});
	it('runs only an exact backup; no latest, target path, command or credential override', async () => {
		for (const body of [
			{},
			{ backupId: 'backup-01', target: '/srv/example-app' },
			{ backupId: 'backup-01', command: 'sh' },
			{ backupId: '../backup-01' },
		]) {
			expect(
				(await request(app).post('/api/recovery-testing/plan-01/tests').send(body)).status
			).toBe(400);
		}
		expect(service.enqueue).not.toHaveBeenCalled();
		expect(
			(
				await request(app)
					.post('/api/recovery-testing/plan-01/tests')
					.send({ backupId: 'backup-01' })
			).status
		).toBe(202);
		expect(service.enqueue).toHaveBeenCalledWith('plan-01', 'backup-01');
	});
	it('preserves server-side scoped ownership for result/cancel and configuration', async () => {
		service.get.mockRejectedValue(new AppError(404, 'Recovery test not found.'));
		expect((await request(app).get('/api/recovery-testing/plan-other/tests/test-01')).status).toBe(
			404
		);
		expect(service.get).toHaveBeenCalledWith('plan-other', 'test-01');
		await request(app).post('/api/recovery-testing/plan-01/tests/test-01/cancel');
		expect(service.cancel).toHaveBeenCalledWith('plan-01', 'test-01');
	});
	it('never forwards an unexpected database error or credential', async () => {
		service.saveTarget.mockRejectedValue(new Error('synthetic-private-password and raw SQL'));
		const response = await request(app)
			.put('/api/recovery-testing/plan-01/target')
			.send({ password: 'synthetic-private-password' });
		expect(response.status).toBe(500);
		expect(JSON.stringify(response.body)).not.toContain('synthetic-private-password');
	});
	it('looks up visible backup results within the plan scope with bounded strict input', async () => {
		for (const body of [
			{},
			{ backupIds: ['../backup'] },
			{ backupIds: ['backup-01'], planId: 'plan-other' },
			{ backupIds: Array(1000).fill('backup-01') },
		])
			expect(
				(await request(app).post('/api/recovery-testing/plan-01/tests/lookup').send(body)).status
			).toBe(400);
		expect(service.list).not.toHaveBeenCalled();
		expect(
			(
				await request(app)
					.post('/api/recovery-testing/plan-01/tests/lookup')
					.send({ backupIds: ['backup-01', 'backup-01', 'backup-other'] })
			).status
		).toBe(200);
		expect(service.list).toHaveBeenCalledWith('plan-01', ['backup-01', 'backup-other']);
	});
});

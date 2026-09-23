import express, { type Express } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import Cookies from 'cookies';

jest.mock('jsonwebtoken');
jest.mock('cookies');
jest.mock('../../src/services/ConfigService', () => ({
	configService: {
		config: {
			SECRET: 'legacy-routes-test-secret',
			APIKEY: 'legacy-routes-test-api-key',
		},
	},
}));

import { LegacyRepositoryController } from '../../src/controllers/LegacyRepositoryController';
import { createLegacyRepositoryRouter } from '../../src/routes/legacyRepositories';
import type { LegacyRepositoryService } from '../../src/services/LegacyRepositoryService';

describe('Legacy repository routes', () => {
	let app: Express;
	let service: {
		getAll: jest.Mock;
		getById: jest.Mock;
		register: jest.Mock;
		validate: jest.Mock;
		listSnapshots: jest.Mock;
		getSnapshot: jest.Mock;
		getStats: jest.Mock;
		deleteRegistration: jest.Mock;
	};

	const setAuthenticatedSession = (authenticated: boolean) => {
		(Cookies as jest.MockedClass<typeof Cookies>).mockImplementation(
			() => ({ get: jest.fn().mockReturnValue(authenticated ? 'test-session' : undefined) }) as never
		);
		(jwt.verify as jest.Mock).mockImplementation((_token, _secret, callback) => {
			callback(authenticated ? null : new Error('invalid session'));
		});
	};

	beforeEach(() => {
		jest.clearAllMocks();
		service = {
			getAll: jest.fn(),
			getById: jest.fn(),
			register: jest.fn(),
			validate: jest.fn(),
			listSnapshots: jest.fn(),
			getSnapshot: jest.fn(),
			getStats: jest.fn(),
			deleteRegistration: jest.fn(),
		};
		app = express();
		app.use(express.json());
		app.use(
			'/api/legacy-repositories',
			createLegacyRepositoryRouter(new LegacyRepositoryController(service as unknown as LegacyRepositoryService))
		);
		setAuthenticatedSession(true);
	});

	it('requires an authenticated UI session', async () => {
		setAuthenticatedSession(false);

		const response = await request(app).get('/api/legacy-repositories');

		expect(response.status).toBe(401);
		expect(service.getAll).not.toHaveBeenCalled();
	});

	it('does not grant a legacy repository route to an API key', async () => {
		setAuthenticatedSession(false);

		const response = await request(app)
			.get('/api/legacy-repositories')
			.set('Authorization', 'Bearer legacy-routes-test-api-key');

		expect(response.status).toBe(401);
		expect(service.getAll).not.toHaveBeenCalled();
	});

	it('lists public registration data without credentials', async () => {
		service.getAll.mockResolvedValue([
			{
				id: 'legacy-fixture',
				displayName: 'Fixture legacy repository',
				repositoryPath: 'C:\\fixtures\\legacy-restic-repository',
				backend: 'local',
				isReadOnly: true,
				validationStatus: 'available',
				lastValidatedAt: null,
				createdAt: new Date('2026-01-01T00:00:00.000Z'),
				updatedAt: null,
			},
		]);

		const response = await request(app).get('/api/legacy-repositories');

		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ success: true });
		expect(JSON.stringify(response.body)).not.toContain('password');
	});

	it('passes exact snapshot filters to the read-only service', async () => {
		service.listSnapshots.mockResolvedValue([]);

		const response = await request(app)
			.get('/api/legacy-repositories/legacy-fixture/snapshots')
			.query({ tag: 'application', path: 'C:\\fixtures\\source', host: 'fixture-host' });

		expect(response.status).toBe(200);
		expect(service.listSnapshots).toHaveBeenCalledWith('legacy-fixture', {
			tag: 'application',
			path: 'C:\\fixtures\\source',
			host: 'fixture-host',
		});
	});
});

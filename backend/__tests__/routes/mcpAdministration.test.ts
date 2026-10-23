import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { mcpBrowserAdministrator } from '../../src/mcp/browserAdministrator';
import { webAccess } from '../../src/middlewares/webAccess';
import { parseWebOrigins } from '../../src/utils/webOrigins';
const origin = 'https://backup.example.internal';
const secret = 'synthetic-mcp-session-fixture-secret';
jest.mock('../../src/services/ConfigService', () => ({
	configService: {
		config: {
			APP_URL: 'https://backup.example.internal',
			SECRET: 'synthetic-mcp-session-fixture-secret',
			APIKEY: 'synthetic-api-key',
			USER_NAME: 'fixture-administrator',
		},
	},
}));
describe('MCP browser administrator permission boundary', () => {
	const app = () =>
		express()
			.use(webAccess(parseWebOrigins({ APP_URL: origin })))
			.use(express.json())
			.use(mcpBrowserAdministrator)
			.all('/api/mcp-admin/policy', (_req, res) =>
				res.json({ actor: res.locals.mcpAdministrator })
			);
	const cookie = (user: string, webOrigin = origin) =>
		`token=${jwt.sign({ user, webOrigin }, secret, { expiresIn: '1m' })}`;
	it('refuses anonymous and machine/API credentials', async () => {
		for (const key of ['', 'synthetic-api-key'])
			expect(
				(
					await request(app())
						.get('/api/mcp-admin/policy')
						.set('Host', 'backup.example.internal')
						.set('Authorization', `Bearer ${key}`)
				).status
			).toBe(401);
	});
	it('requires the actual local administrator and an origin-bound signed cookie', async () => {
		for (const [user, webOrigin, status] of [
			['fixture-administrator', origin, 200],
			['other-user', origin, 403],
			['fixture-administrator', 'https://other.example.internal', 401],
		]) {
			const response = await request(app())
				.get('/api/mcp-admin/policy')
				.set('Host', 'backup.example.internal')
				.set('Cookie', cookie(user, webOrigin));
			expect(response.status).toBe(status);
		}
	});
	it('refuses cross-origin/missing-origin writes and accepts same-origin JSON', async () => {
		for (const submittedOrigin of ['', 'https://evil.example.internal', origin]) {
			const action = request(app())
				.put('/api/mcp-admin/policy')
				.set('Host', 'backup.example.internal')
				.set('Cookie', cookie('fixture-administrator'))
				.send({});
			if (submittedOrigin) action.set('Origin', submittedOrigin);
			expect((await action).status).toBe(submittedOrigin === origin ? 200 : 403);
		}
	});
});

import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerSpaFallback } from '../../src/utils/spaFallback';
describe('bundled public documentation deep links', () => {
	let directory: string;
	beforeAll(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pluton-docs-'));
		await fs.writeFile(
			path.join(directory, 'index.html'),
			'<!doctype html><div id="root">static documentation bundle</div>'
		);
	});
	afterAll(async () => {
		await fs.rm(directory, { recursive: true, force: true });
	});
	it.each(['/docs', '/docs/backup-plans/incremental', '/docs/unknown', '/login'])(
		'serves SPA entry without application inventory for direct refresh %s',
		async route => {
			const app = express();
			registerSpaFallback(app, directory);
			const result = await request(app).get(route).expect(200);
			expect(result.headers['content-type']).toContain('text/html');
			expect(result.text).toContain('static documentation bundle');
		}
	);
	it('does not intercept registered authenticated API routes', async () => {
		const app = express();
		app.get('/api/settings', (_req, res) =>
			res.status(401).json({ error: 'Authentication required.' })
		);
		registerSpaFallback(app, directory);
		await request(app).get('/api/settings').expect(401).expect('Content-Type', /json/);
	});
});

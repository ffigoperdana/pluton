import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import * as deviceSchema from '../../src/db/schema/devices';
import { DeviceStore } from '../../src/stores/DeviceStore';
import { DeviceService } from '../../src/services/DeviceService';
import { DeviceController } from '../../src/controllers/DeviceController';
import { createDeviceRouter } from '../../src/routes/devices';
import { configService } from '../../src/services/ConfigService';
import { webAccess } from '../../src/middlewares/webAccess';

describe('remote device rename regression through the real router and SQLite', () => {
	let sqlite: Database.Database;
	let store: DeviceStore;
	let service: DeviceService;
	let app: express.Express;
	beforeEach(() => {
		sqlite = new Database(':memory:');
		const db = drizzle(sqlite, { schema: { ...deviceSchema } });
		migrate(db, { migrationsFolder: './drizzle' });
		store = new DeviceStore(db as any);
		db.insert(deviceSchema.devices)
			.values({ id: 'device-01', name: 'app-01', settings: null })
			.run();
		// Use the actual RemoteStrategy, whose UPDATE_SETTINGS capability is not implemented.
		service = new DeviceService({} as any, store, {} as any, {} as any);
		app = express();
		app.use(express.json());
		app.use(
			webAccess({ canonical: 'https://example.internal', origins: ['https://example.internal'] })
		);
		app.use('/api/devices', createDeviceRouter(new DeviceController(service)));
	});
	afterEach(() => sqlite?.close());
	const update = (body: unknown) =>
		request(app)
			.put('/api/devices/device-01')
			.set('Host', 'example.internal')
			.set('Origin', 'https://example.internal')
			.set('Cookie', 'token=' + jwt.sign({ user: 'synthetic-user' }, configService.config.SECRET!))
			.send(body);

	it('renames a remote device when the existing form sends an empty settings object', async () => {
		const response = await update({ name: 'app-01 renamed', settings: {} });
		expect(response.status).toBe(200);
		expect((await store.getById('device-01'))?.name).toBe('app-01 renamed');
	});

	it.each([
		undefined,
		null,
		{},
		{ general: {} },
		{ general: { tempDir: '' } },
		{ general: { tempDir: '   ' } },
		{ general: { tempDir: '/srv/example-app' }, rclone: { retries: 3 } },
	])('preserves omitted, empty and unchanged optional settings: %j', async settings => {
		const saved = {
			general: { tempDir: '/srv/example-app' },
			rclone: { retries: 3, configPass: 'opaque-test-value' },
		};
		await store.update('device-01', { settings: saved, tags: ['keep'] });
		const strategy = jest.spyOn(service, 'getSystemStrategy');
		const response = await update({
			name: 'app-01 renamed',
			...(settings === undefined ? {} : { settings }),
		});
		expect(response.status).toBe(200);
		expect((await store.getById('device-01'))?.settings).toEqual(saved);
		expect((await store.getById('device-01'))?.tags).toEqual(['keep']);
		expect(response.text).not.toContain('opaque-test-value');
		expect(strategy).not.toHaveBeenCalled();
	});

	it('rejects real remote runtime edits explicitly and atomically, without sending an Agent command', async () => {
		const strategy = jest.spyOn(service, 'getSystemStrategy');
		expect(
			(
				await update({
					name: 'must not persist',
					settings: { general: { tempDir: '/srv/example-app' } },
				})
			).status
		).toBe(501);
		expect((await store.getById('device-01'))?.name).toBe('app-01');
		expect(strategy).not.toHaveBeenCalled();
	});

	it.each(['', '   ', 'x'.repeat(101), 'bad\nname', 'bad\u0000name', 'bad\u007fname', null, 42])(
		'rejects invalid names without persistence: %j',
		async name => {
			const response = await update({ name });
			expect(response.status).toBe(400);
			expect((await store.getById('device-01'))?.name).toBe('app-01');
		}
	);

	it.each([
		null,
		[],
		{ settings: [] },
		{ settings: { general: null } },
		{ settings: { unexpected: {} } },
		{ settings: { restic: { maxProcessor: -1 } } },
		{ tags: null },
		{ name: 'valid', agentId: 'forged' },
		{ id: 'forged' },
		{ key: 'forged' },
		{ selectedRoots: ['/srv/example-app'] },
	])('rejects malformed and identity-changing bodies: %j', async body => {
		expect((await update(body)).status).toBe(400);
	});

	it('returns a conflict without modifying either device, but allows an unchanged name', async () => {
		await store.create({ id: 'device-02', name: 'app-02' });
		expect((await update({ name: ' APP-02 ' })).status).toBe(409);
		expect((await store.getById('device-01'))?.name).toBe('app-01');
		expect((await update({ name: 'app-01' })).status).toBe(200);
		expect((await update({ name: '  Aplikasi üji  ' })).status).toBe(200);
		expect((await store.getById('device-01'))?.name).toBe('Aplikasi üji');
	});

	it('serializes colliding metadata writes in SQLite', async () => {
		await store.create({ id: 'device-02', name: 'app-02' });
		const results = await Promise.allSettled([
			store.updateMetadata('device-01', { name: 'shared' }),
			store.updateMetadata('device-02', { name: 'shared' }),
		]);
		expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
		expect((results[1] as PromiseRejectedResult).reason.statusCode).toBe(409);
	});

	it('does not force existing duplicate display names to migrate on an unchanged update', async () => {
		await store.create({ id: 'device-02', name: 'app-01' });
		expect((await update({ name: 'app-01', settings: {} })).status).toBe(200);
		expect((await store.getById('device-02'))?.name).toBe('app-01');
	});

	it('preserves metadata for an empty patch and only clears tags on an explicit empty array', async () => {
		await store.update('device-01', { tags: ['keep'] });
		const before = await store.getById('device-01');
		expect((await update({})).status).toBe(200);
		expect(await store.getById('device-01')).toEqual(before);
		expect((await update({ tags: [] })).status).toBe(200);
		expect((await store.getById('device-01'))?.tags).toEqual([]);
	});

	it.each(['online', 'offline'])(
		'preserves identity, approvals, enrollment, queue and plan associations while %s',
		async status => {
			sqlite
				.prepare('UPDATE devices SET agent_id = ?, status = ? WHERE id = ?')
				.run('agent-01', status, 'device-01');
			sqlite
				.prepare(
					`INSERT INTO agent_identities (agent_id,device_id,encrypted_secret,hostname,os,architecture,agent_version,capabilities)
         VALUES ('agent-01','device-01','opaque-test-value','app-01','linux','x64','0.7.1','{}')`
				)
				.run();
			sqlite
				.prepare(
					`INSERT INTO agent_enrollment_tokens (id,token_hash,device_name,expires_at) VALUES ('enrollment-01','opaque-test-hash','app-01',1)`
				)
				.run();
			sqlite
				.prepare(
					`INSERT INTO agent_source_access_state (agent_id,report,selected_roots,latest_report_timestamp,received_at)
         VALUES ('agent-01','{}','["/srv/example-app"]',1,1)`
				)
				.run();
			sqlite
				.prepare(
					`INSERT INTO plans (id,title,source_id,source_config,settings) VALUES ('plan-01','Synthetic plan','device-01','{}','{}')`
				)
				.run();
			sqlite
				.prepare(
					`INSERT INTO agent_commands (id,agent_id,type,payload,idempotency_key) VALUES ('command-01','agent-01','PING','{}','command-01')`
				)
				.run();
			const tables = [
				'agent_identities',
				'agent_enrollment_tokens',
				'agent_source_access_state',
				'plans',
				'agent_commands',
			];
			const before = tables.map(table => sqlite.prepare(`SELECT * FROM ${table}`).all());
			const deviceBefore = await store.getById('device-01');
			const strategy = jest.spyOn(service, 'getSystemStrategy');
			expect((await update({ name: 'Friendly display name', settings: {} })).status).toBe(200);
			expect(tables.map(table => sqlite.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
			expect(await store.getById('device-01')).toEqual({
				...deviceBefore,
				name: 'Friendly display name',
				updatedAt: expect.any(Date),
			});
			expect(strategy).not.toHaveBeenCalled();
		}
	);

	it('keeps local section values on partial updates and treats blank numeric inputs as omitted, not zero', async () => {
		await store.create({
			id: 'main',
			name: 'Local',
			settings: { general: { tempDir: '/srv/example-app' }, rclone: { retries: 3, transfers: 4 } },
		});
		const apply = jest.fn().mockResolvedValue({ success: true });
		jest.spyOn(service, 'getSystemStrategy').mockReturnValue({ updateSettings: apply } as any);
		const result = await service.updateDevice('main', {
			settings: { general: { tempDir: '' }, rclone: { retries: '', transfers: 0 } },
		});
		expect(result?.settings).toEqual({
			general: { tempDir: '/srv/example-app' },
			rclone: { retries: 3, transfers: 0 },
		});
		expect(apply).toHaveBeenCalledWith(result?.settings);
	});

	it('keeps authentication, fixed-origin CSRF and missing-identity protection', async () => {
		expect(
			(
				await request(app)
					.put('/api/devices/device-01')
					.set('Host', 'example.internal')
					.set('Origin', 'https://example.internal')
					.send({ name: 'forged' })
			).status
		).toBe(401);
		const token = jwt.sign({ user: 'synthetic-user' }, configService.config.SECRET!);
		expect(
			(
				await request(app)
					.put('/api/devices/device-01')
					.set('Host', 'example.internal')
					.set('Origin', 'https://evil.example')
					.set('Cookie', 'token=' + token)
					.send({ name: 'forged' })
			).status
		).toBe(403);
		// There is no ID-less update contract; never infer an identity from name or body.
		expect(
			(
				await request(app)
					.put('/api/devices/')
					.set('Host', 'example.internal')
					.set('Origin', 'https://example.internal')
					.set('Cookie', 'token=' + token)
					.send({ name: 'missing id' })
			).status
		).toBe(404);
		expect(
			(
				await request(app)
					.put('/api/devices/missing')
					.set('Host', 'example.internal')
					.set('Origin', 'https://example.internal')
					.set('Cookie', 'token=' + token)
					.send({ name: 'missing device' })
			).status
		).toBe(404);
		expect((await store.getById('device-01'))?.name).toBe('app-01');
	});

	it('does not expose SQLite errors in HTTP responses', async () => {
		jest.spyOn(store, 'updateMetadata').mockRejectedValue(new Error('private SQLite detail'));
		const response = await update({ name: 'app-01 renamed' });
		expect(response.status).toBe(500);
		expect(response.body).toEqual({ success: false, error: 'Failed to update device' });
		expect(response.text).not.toContain('private SQLite detail');
	});

	it('rejects invalid/expired cookies and bearer-only writes without modifying metadata', async () => {
		for (const cookie of [
			'invalid-test-token',
			jwt.sign({ user: 'synthetic-user' }, configService.config.SECRET!, { expiresIn: -1 }),
		]) {
			expect(
				(
					await request(app)
						.put('/api/devices/device-01')
						.set('Host', 'example.internal')
						.set('Origin', 'https://example.internal')
						.set('Cookie', 'token=' + cookie)
						.send({ name: 'forged' })
				).status
			).toBe(401);
		}
		expect(
			(
				await request(app)
					.put('/api/devices/device-01')
					.set('Host', 'example.internal')
					.set('Origin', 'https://example.internal')
					.set('Authorization', 'Bearer inert-test-value')
					.send({ name: 'forged' })
			).status
		).toBe(401);
		expect((await store.getById('device-01'))?.name).toBe('app-01');
	});

	it('does not echo legacy key material in a successful metadata response', async () => {
		await store.update('device-01', { key: 'opaque-test-value' });
		const response = await update({ name: 'app-01 renamed' });
		expect(response.status).toBe(200);
		expect(response.body.result).not.toHaveProperty('key');
		expect(response.text).not.toContain('opaque-test-value');
		expect((await store.getById('device-01'))?.key).toBe('opaque-test-value');
	});
});

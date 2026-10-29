/** Compiled application startup in a disposable, network-none runtime. Synthetic
 * configuration only; no provider probe, real repository or credential input. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import jwt from 'jsonwebtoken';

if (process.env.PLUTON_EXPORT_RUNTIME_FIXTURE !== '1' || process.getuid?.() !== 10001)
	throw new Error('Disposable UID 10001 runtime fixture only.');
Object.assign(process.env, {
	NODE_ENV: 'production',
	PLUTON_DATA_DIR: '/data',
	USER_NAME: 'fixture-admin',
	USER_PASSWORD: crypto.randomBytes(32).toString('hex'),
	SECRET: crypto.randomBytes(32).toString('hex'),
	ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
	APP_URL: 'http://127.0.0.1:5173',
	MANAGED_EXPORT_ENABLED: 'true',
	MANAGED_EXPORT_ALLOW_SHARED_NAMESPACE: 'true',
	MANAGED_EXPORT_ENDPOINT: 'https://s3.example.invalid',
	MANAGED_EXPORT_REGION: 'us-east-1',
	MANAGED_EXPORT_BUCKET: 'example-backup',
	MANAGED_EXPORT_PREFIX: 'pluton-temporary-exports',
	MANAGED_EXPORT_ACCESS_KEY_ID: crypto.randomBytes(16).toString('hex'),
	MANAGED_EXPORT_SECRET_ACCESS_KEY: crypto.randomBytes(32).toString('hex'),
	MANAGED_EXPORT_CA_FILE: '',
	MANAGED_EXPORT_SESSION_TOKEN: '',
	MANAGED_EXPORT_TTL_SECONDS: '259200',
});
let shutdown: (() => Promise<void>) | undefined, server: http.Server | undefined;
let code = 1;
let stage = 'compiled-import';
const originalLog = console.log,
	originalError = console.error;
try {
	console.log = () => {};
	console.error = () => {};
	const runtime = await import(new URL('../../dist/index.js', import.meta.url).href);
	stage = 'migrations';
	migrate(runtime.db, { migrationsFolder: '/app/backend/drizzle' });
	stage = 'initial-setup';
	await runtime.initSetup(runtime.db);
	stage = 'create-application';
	const application = await runtime.createApp();
	shutdown = application.shutdown;
	stage = 'listen';
	server = http.createServer(application.app);
	await new Promise<void>(resolve => server!.listen(5173, '127.0.0.1', resolve));
	const base = 'http://127.0.0.1:5173/api';
	const headers = {
		'Origin': 'http://127.0.0.1:5173',
		'Cookie':
			'token=' +
			jwt.sign({ user: 'fixture-admin' }, runtime.configService.config.SECRET, { expiresIn: '5m' }),
		'Content-Type': 'application/json',
	};
	stage = 'authenticated-configuration';
	assert.equal((await fetch(base + '/managed-exports/configuration')).status, 401);
	const response = await fetch(base + '/managed-exports/configuration', { headers });
	assert.equal(response.status, 200);
	const config = ((await response.json()) as any).result;
	assert.equal(config.enabled, true);
	assert.equal(config.configured, true);
	assert.equal(config.sharedNamespaceEnabled, true);
	assert.equal(config.credentialsConfigured, true);
	stage = 'admission-gate';
	const admission = await fetch(base + '/backups/fixture-no-backup/exports', {
		method: 'POST',
		headers,
		body: '{}',
	});
	assert.equal(admission.status, 409);
	assert.equal(((await admission.json()) as any).reason, 'security-capability-missing');
	stage = 'operator-check-admission';
	for (const kind of ['inventory-checks', 'preflights']) {
		const response = await fetch(base + '/managed-exports/' + kind, {
			method: 'POST',
			headers,
			body: '{}',
		});
		assert.equal(response.status, 202);
		const id = ((await response.json()) as any).result.id;
		const cancelled = await fetch(base + '/managed-exports/' + kind + '/' + id, {
			method: 'DELETE',
			headers,
			body: '{}',
		});
		assert.equal(cancelled.status, 200);
		assert.equal(((await cancelled.json()) as any).result.state, 'cancelled');
	}
	assert.equal(
		(await fetch(base + '/managed-exports/preflights/fixture-not-present', { headers })).status,
		404
	);
	assert.equal(
		(await fetch(base + '/managed-exports/inventory-checks/fixture-not-present', { headers }))
			.status,
		404
	);
	console.log = originalLog;
	console.error = originalError;
	console.log(
		JSON.stringify({
			event: 'managed_export_compiled_runtime',
			enabledStartup: 'PASS',
			authenticatedConfiguration: 'PASS',
			preflightRoutes: 'PASS',
			admissionWithoutGoRefused: 'PASS',
			uid: 10001,
			readOnlyRoot: true,
			externalNetwork: false,
		})
	);
	code = 0;
} catch (error) {
	console.error = originalError;
	const e = error as any;
	console.error(
		JSON.stringify({
			event: 'managed_export_compiled_runtime',
			result: 'FAIL',
			stage,
			code: [
				'ERR_MODULE_NOT_FOUND',
				'MODULE_NOT_FOUND',
				'ENOENT',
				'EACCES',
				'ERR_ASSERTION',
				'SQLITE_ERROR',
			].includes(e.code)
				? e.code
				: undefined,
			actualStatus:
				typeof e.actual === 'number' || typeof e.actual === 'boolean' ? e.actual : undefined,
		})
	);
} finally {
	await shutdown?.().catch(() => {});
	server?.closeAllConnections();
	server?.close();
	process.exit(code); // independent application timers belong to this disposable process
}

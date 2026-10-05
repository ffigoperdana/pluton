import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { plans } from '../../src/db/schema/plans';
import { remotePlanDatabaseCredentials } from '../../src/db/schema/remotePlanCredentials';
import { PlanStore } from '../../src/stores/PlanStore';
import type { DatabaseType } from '../../src/db';

// Disposable in-memory database only. No application singleton or live DB opens.
const scenario = process.argv[2];
const sqlite = new Database(':memory:');
try {
	const db = drizzle(sqlite, { schema: { plans, remotePlanDatabaseCredentials } });
	migrate(db, { migrationsFolder: path.join(process.cwd(), 'drizzle') });
	sqlite.pragma('foreign_keys = ON');
	const store = new PlanStore(db as DatabaseType);
	const data = {
		id: 'plan-01',
		title: 'Example plan',
		sourceId: 'agent-01',
		sourceType: 'device',
		sourceConfig: { includes: ['/srv/example-app'], excludes: [] },
		settings: { remoteLifecycle: { version: 1, database: { passwordConfigured: true } } },
	} as any;
	if (scenario === 'persistence') {
		const created = await store.create(data, 'synthetic-ciphertext-01');
		assert.ok(!JSON.stringify(created).includes('synthetic-ciphertext'));
		assert.equal(await store.getDatabaseCredential('plan-01'), 'synthetic-ciphertext-01');
		await store.update('plan-01', { title: 'Updated' }, 'synthetic-ciphertext-02');
		assert.equal(await store.getDatabaseCredential('plan-01'), 'synthetic-ciphertext-02');
		await store.update('plan-01', { settings: { remoteLifecycle: { version: 1 } } as any }, null);
		assert.equal(await store.getDatabaseCredential('plan-01'), null);
		await store.update('plan-01', { title: 'Updated again' }, 'synthetic-ciphertext-03');
		await store.create({ ...data, id: 'plan-02' }, 'synthetic-ciphertext-other');
		await store.delete('plan-01');
		assert.equal(await store.getDatabaseCredential('plan-01'), null);
		assert.equal(await store.getDatabaseCredential('plan-02'), 'synthetic-ciphertext-other');
	} else if (scenario === 'plan-write-failure' || scenario === 'credential-write-failure') {
		const table = scenario === 'plan-write-failure' ? 'plans' : 'remote_plan_database_credentials';
		sqlite.exec(
			`CREATE TRIGGER reject_fixture_write BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'Synthetic insertion failure'); END;`
		);
		await assert.rejects(store.create(data, 'synthetic-ciphertext'));
		assert.deepEqual(sqlite.prepare('SELECT count(*) AS count FROM plans').get(), { count: 0 });
		assert.equal(await store.getDatabaseCredential('plan-01'), null);
	} else if (scenario === 'phase4') {
		await store.create({ ...data, settings: { encryption: true } });
		await store.update('plan-01', { title: 'Filesystem-only' });
		assert.equal(await store.getDatabaseCredential('plan-01'), null);
	} else {
		throw new Error('Unknown synthetic migration test.');
	}
	console.log(`PASS ${scenario}`);
} finally {
	sqlite.close();
}

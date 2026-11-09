import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'path';
import { eq } from 'drizzle-orm';
import { BackupStore } from '../../src/stores/BackupStore';
import { backups } from '../../src/db/schema/backups';
describe('bounded chronological comparison history query', () => {
	let sqlite: Database.Database, db: ReturnType<typeof drizzle>, store: BackupStore;
	const at = new Date('2026-01-01T10:00:10Z');
	beforeEach(() => {
		sqlite = new Database(':memory:');
		db = drizzle(sqlite);
		migrate(db, { migrationsFolder: path.resolve('drizzle') });
		sqlite.exec(
			"INSERT INTO storages(id,name,credentials,settings) VALUES('storage-01','Example','{}','{}'),('storage-02','Other','{}','{}');" +
				"INSERT INTO plans(id,title,source_id,source_config,storage_id,storage_path,settings) VALUES('plan-01','Example','app-01','{}','storage-01','application','{}'),('plan-other','Other','app-01','{}','storage-01','application','{}');"
		);
		store = new BackupStore(db as any);
	});
	afterEach(() => sqlite.close());
	const base = (id: string) => ({
		id,
		planId: 'plan-01',
		sourceId: 'app-01',
		sourceType: 'device' as const,
		method: 'backup',
		storageId: 'storage-01',
		storagePath: 'application',
		status: 'completed',
		success: true,
		inProgress: false,
		createdAt: at,
		ended: at,
	});
	test('same-time ties, ended/started/created fallback and all ownership/success filters are enforced', async () => {
		db.insert(backups)
			.values([
				base('current'),
				base('before-a'),
				base('before-b'),
				base('zz-future-tie'),
				{ ...base('future'), ended: new Date(at.getTime() + 1000) },
				{ ...base('fallback-started'), ended: null, started: new Date(at.getTime() - 1000) },
				{
					...base('fallback-created'),
					ended: null,
					started: null,
					createdAt: new Date(at.getTime() - 2000),
				},
				{ ...base('other-plan'), planId: 'plan-other' },
				{ ...base('other-source'), sourceId: 'app-02' },
				{ ...base('other-source-type'), sourceType: 'storage' as any },
				{ ...base('other-storage'), storageId: 'storage-02' },
				{ ...base('other-path'), storagePath: 'another' },
				{ ...base('failed'), success: false },
				{ ...base('running'), inProgress: true },
				{ ...base('wrong-state'), status: 'failed' },
				{ ...base('wrong-method'), method: 'sync' },
			])
			.run();
		const current = db.select().from(backups).where(eq(backups.id, 'current')).get()!;
		expect((await store.comparisonCandidates(current)).map(b => b.id)).toEqual([
			'before-b',
			'before-a',
			'fallback-started',
			'fallback-created',
		]);
	});
	test('history admission is capped at the 32 nearest earlier rows', async () => {
		db.insert(backups)
			.values([
				base('current'),
				...Array.from({ length: 40 }, (_, i) => ({
					...base('older-' + i),
					ended: new Date(at.getTime() - (i + 1) * 1000),
				})),
			])
			.run();
		const current = db.select().from(backups).where(eq(backups.id, 'current')).get()!;
		const result = await store.comparisonCandidates(current);
		expect(result).toHaveLength(32);
		expect(result[0].id).toBe('older-0');
		expect(result[31].id).toBe('older-31');
	});
});

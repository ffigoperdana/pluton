import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database, { type Database as SqliteDatabase } from 'better-sqlite3';
import path from 'path';
import { plans, plansRelations } from './schema/plans';
import { storageRelations, storages } from './schema/storages';
import { deviceRelations, devices } from './schema/devices';
import { restoreRelations, restores } from './schema/restores';
import { backupRelations, backups } from './schema/backups';
import { settings } from './schema/settings';
import { legacyRepositories } from './schema/legacyRepositories';
import { legacyRestoreJobRelations, legacyRestoreJobs } from './schema/legacyRestoreJobs';
import { appPaths } from '../utils/AppPaths';

const dbPath = path.join(appPaths.getDbDir(), 'pluton.db');
export const sqlite: SqliteDatabase = new Database(dbPath);
export const dbFilePath = dbPath;
sqlite.pragma('journal_mode = WAL');

export const db = drizzle(sqlite, {
	schema: {
		plans,
		plansRelations,
		storages,
		storageRelations,
		devices,
		deviceRelations,
		restores,
		restoreRelations,
		backups,
		backupRelations,
		settings,
		legacyRepositories,
		legacyRestoreJobs,
		legacyRestoreJobRelations,
	},
});
export type DatabaseType = typeof db;

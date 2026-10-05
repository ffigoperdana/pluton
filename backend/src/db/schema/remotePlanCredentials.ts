import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { plans } from './plans';

/** Not joined into public plan/device queries. Encrypted using the server SECRET. */
export const remotePlanDatabaseCredentials = sqliteTable('remote_plan_database_credentials', {
	planId: text('plan_id')
		.primaryKey()
		.notNull()
		.references(() => plans.id, { onDelete: 'cascade' }),
	encryptedPassword: text('encrypted_password').notNull(),
});

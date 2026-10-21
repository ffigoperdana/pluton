import test from 'node:test';
import assert from 'node:assert/strict';
import { planDatabaseSummary } from '../src/utils/planDatabase.ts';
import type { RemoteDatabaseBackup } from '../src/@types/plans';

test('filesystem-only and hook-only plans do not acquire a database badge or a success claim', () => {
   assert.deepEqual(planDatabaseSummary(), { count: 0, card: '', detail: 'Not configured' });
   assert.equal(planDatabaseSummary({ remoteLifecycle: { version: 2, databases: [] } }).count, 0);
});

test('configuration summaries support legacy and mixed DB collections without leaking identifiers or claiming successful snapshots', () => {
   const database: RemoteDatabaseBackup = {
      engine: 'mariadb',
      host: 'localhost',
      port: 3306,
      tls: 'local',
      database: 'synthetic-private-name',
      username: 'synthetic-user',
      password: 'synthetic-private-marker',
      dumpFilename: 'app.sql',
      timeoutSeconds: 30,
      maxDumpBytes: 1024,
      includeRoutines: false,
      includeEvents: false,
   };
   assert.deepEqual(planDatabaseSummary({ remoteLifecycle: { version: 1, database } }), {
      count: 1,
      card: 'DB · MariaDB',
      detail: 'MariaDB · 1 configured',
   });
   for (const backupStatus of ['failed', 'completed', undefined]) {
      const settings = {
         remoteLifecycle: {
            version: 2 as const,
            databases: [
               { ...database, engine: 'mysql' as const },
               { ...database, engine: 'postgresql' as const },
            ],
         },
         backupStatus,
      };
      const summary = planDatabaseSummary(settings);
      assert.equal(summary.count, 2);
      assert.equal(summary.detail, 'MySQL + PostgreSQL · 2 configured');
      assert.equal(summary.card, 'DB · 2 configured');
      assert.doesNotMatch(JSON.stringify(summary), /synthetic|success|verified|tested|backed up/i);
   }
   assert.equal(planDatabaseSummary({ remoteLifecycle: { version: 2, databases: [database, database] } }).detail, 'MariaDB · 2 configured');
});

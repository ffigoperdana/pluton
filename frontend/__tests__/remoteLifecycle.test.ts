import assert from 'node:assert/strict';
import test from 'node:test';
import { remoteLifecycleValidation } from '../src/utils/remoteLifecycle.ts';

const database = {
   engine: 'mariadb' as const,
   host: 'localhost',
   port: 3306,
   tls: 'local' as const,
   database: 'example_db',
   username: 'backup_reader',
   dumpFilename: 'app.sql',
   timeoutSeconds: 60,
   maxDumpBytes: 1024 ** 3,
   includeRoutines: false,
   includeEvents: false,
};
test('existing plans have no new required lifecycle configuration', () => assert.equal(remoteLifecycleValidation(), undefined));
test('saved secret is retained without displaying/filling a password', () => {
   assert.equal(remoteLifecycleValidation({ version: 1, database: { ...database, passwordConfigured: true } }), undefined);
   assert.ok(remoteLifecycleValidation({ version: 1, database }));
});
test('valid declarative database and deployed hooks are accepted', () =>
   assert.equal(
      remoteLifecycleValidation({
         version: 1,
         database: { ...database, password: 'synthetic-test-password' },
         preHook: { id: 'prepare-app', args: ['app-01'], timeoutSeconds: 30 },
      }),
      undefined,
   ));
test('dangerous paths/shell syntax and nonlocal plaintext DB do not pass UI validation', () => {
   for (const patch of [{ dumpFilename: '../escape.sql' }, { host: 'db.example.internal' }])
      assert.ok(remoteLifecycleValidation({ version: 1, database: { ...database, passwordConfigured: true, ...patch } }));
   for (const arg of ['--command', '$(id)', '../escape'])
      assert.ok(remoteLifecycleValidation({ version: 1, preHook: { id: 'prepare', args: [arg], timeoutSeconds: 30 } }));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
   agentHostOperatorSteps,
   agentHostOptionsUrl,
   agentHostRequestBody,
   agentHostRestoreNameProblem,
   agentHostRestoreScope,
   agentHostRestoreTarget,
   agentHostRootLabel,
   agentHostSelectionProblem,
} from '../src/utils/agentHostRestore.ts';

test('folder names follow the Agent rule and never end in .partial', () => {
   for (const name of ['app-01-20261120-01234567', 'a', 'restore.v2_1']) assert.equal(agentHostRestoreNameProblem(name), undefined);
   for (const name of ['', '.hidden', '../x', 'a/b', 'a b', 'x'.repeat(101)]) assert.match(agentHostRestoreNameProblem(name) || '', /folder name|letters/);
   assert.match(agentHostRestoreNameProblem('restore.partial') || '', /\.partial/);
});

test('selections mirror the server and Agent parser', () => {
   assert.equal(agentHostSelectionProblem({ includes: [], excludes: [] }), undefined);
   assert.equal(agentHostSelectionProblem({ includes: ['/srv/example-app/filestore'], excludes: [] }), undefined);
   assert.equal(agentHostSelectionProblem({ includes: [], excludes: ['/pluton'] }), undefined);
   assert.match(agentHostSelectionProblem({ includes: ['/srv/a*'], excludes: [] }) || '', /exact snapshot paths/);
   assert.match(agentHostSelectionProblem({ includes: ['/srv/a/../b'], excludes: [] }) || '', /exact snapshot paths/);
   assert.match(agentHostSelectionProblem({ includes: ['/srv/a'], excludes: ['/srv/a/b'] }) || '', /not both/);
   assert.match(agentHostSelectionProblem({ includes: ['/srv/a', '/srv/a/b'], excludes: [] }) || '', /inside another/);
});

test('request bodies, targets and labels', () => {
   assert.equal(agentHostRestoreTarget('/srv/pluton-restore', 'app-01'), '/srv/pluton-restore/app-01');
   assert.equal(agentHostRootLabel({ path: '/srv/pluton-restore', availableBytes: 3 * 1024 ** 3 }), '/srv/pluton-restore (3.0 GiB free)');
   assert.equal(agentHostRootLabel({ path: '/srv/pluton-restore' }), '/srv/pluton-restore');
   assert.equal(
      agentHostOptionsUrl('https://pluton.example.internal/api', 'backup 01', 'plan&01'),
      'https://pluton.example.internal/api/restores/agent-host/options?backupId=backup+01&planId=plan%2601',
   );
   assert.deepEqual(agentHostRequestBody({ backupId: 'b', planId: 'p', root: '/srv/r', name: 'n', includes: ['/srv/a'], databaseId: 'db_odoo' }), {
      backupId: 'b',
      planId: 'p',
      root: '/srv/r',
      name: 'n',
      databaseId: 'db_odoo',
   });
   assert.deepEqual(agentHostRequestBody({ backupId: 'b', planId: 'p', root: '/srv/r', name: 'n' }), {
      backupId: 'b',
      planId: 'p',
      root: '/srv/r',
      name: 'n',
      includes: [],
      excludes: [],
   });
   assert.equal(agentHostRestoreScope({ includes: [], excludes: [] }), 'the whole snapshot');
   assert.equal(agentHostRestoreScope({ includes: ['/a', '/b'], excludes: [] }), '2 selected items');
   assert.equal(agentHostRestoreScope({ includes: [], excludes: ['/a'] }), 'the whole snapshot except 1 deselected item');
   assert.equal(agentHostRestoreScope({ includes: [], excludes: [] }, '/pluton/database/odoo.sql'), 'the database dump /pluton/database/odoo.sql');
});

test('operator steps never chown in place and quote the target', () => {
   const steps = agentHostOperatorSteps("/srv/pluton-restore/app-01", '/pluton/database/odoo.sql');
   assert.equal(steps.length, 3);
   assert.ok(steps[0].startsWith("sudo ls -la '/srv/pluton-restore/app-01'"));
   assert.ok(steps[1].includes("'/srv/pluton-restore/app-01'/pluton/database/odoo.sql"));
   assert.ok(steps[2].startsWith('sudo rm -rf --one-file-system '));
   assert.ok(agentHostOperatorSteps('/srv/x').every((step) => !/chown -R/.test(step)));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { waitForFixtureCapacity } from '../../backend/__tests__/integration/mysqlAutomaticRecovery.capacity.mjs';

const refusal = () => Object.assign(new Error('sanitized refusal'), { code: 'internal-resources-insufficient' });

test('ready admission starts immediately without a stability sleep or SQL retry', async () => {
   let checks = 0, sleeps = 0;
   await waitForFixtureCapacity({ check: async () => { checks++; }, delay: async () => { sleeps++; } });
   assert.equal(checks, 1);
   assert.equal(sleeps, 0);
});

test('transient measured refusal is awaited before any import, never accepted as its outcome', async () => {
   let time = 0, checks = 0, notices = 0, imports = 0;
   await waitForFixtureCapacity({
      check: async () => { if (++checks < 3) throw refusal(); },
      blocked: () => { notices++; }, now: () => time, delay: async ms => { time += ms; },
   });
   imports++;
   assert.equal(time, 4000);
   assert.equal(checks, 3);
   assert.equal(notices, 2);
   assert.equal(imports, 1);
});

test('sustained resource shortage remains a bounded failure, not a negative-scenario PASS', async () => {
   let time = 0, checks = 0, imports = 0;
   const run = async () => {
      await waitForFixtureCapacity({
         check: async () => { checks++; throw refusal(); },
         now: () => time, delay: async ms => { time += ms; }, timeoutMs: 5000,
      });
      imports++;
   };
   await assert.rejects(run(), { code: 'fixture-resource-admission-blocked' });
   assert.equal(time, 5000);
   assert.equal(checks, 4);
   assert.equal(imports, 0);
});

test('missing observation/programming failures are not silently retried', async () => {
   let sleeps = 0;
   await assert.rejects(waitForFixtureCapacity({
      check: async () => { throw new TypeError('fixture bug'); }, delay: async () => { sleeps++; },
   }), TypeError);
   assert.equal(sleeps, 0);
});

test('a later import refusal still fails the scenario, without retrying the import', async () => {
   let imports = 0;
   await assert.rejects((async () => {
      await waitForFixtureCapacity({ check: async () => {} });
      imports++; throw refusal();
   })(), { code: 'internal-resources-insufficient' });
   assert.equal(imports, 1);
});

test('native fixture waits on the real guard and preserves exact negative-scenario assertions and bounded cgroups', () => {
   const smoke = fs.readFileSync(new URL('../../backend/__tests__/integration/mysqlAutomaticRecovery.smoke.mjs', import.meta.url), 'utf8');
   const runner = fs.readFileSync(new URL('../validate-mysql-automatic-recovery.ps1', import.meta.url), 'utf8');
   const workflow = fs.readFileSync(new URL('../../.github/workflows/container.yml', import.meta.url), 'utf8');
   assert(smoke.includes("import { assertInternalMysqlCapacity } from '/app/backend/dist/mysql-worker/internal.js'"));
   assert(smoke.includes('check: () => assertInternalMysqlCapacity(readCapacity)'));
   assert(smoke.indexOf('await waitForFixtureCapacity(') < smoke.indexOf('inspection = await importer.restore('));
   assert(smoke.indexOf('await waitForFixtureCapacity(') < smoke.indexOf('await client.importDatabase('));
   assert.equal(smoke.match(/if \(expected\) assert\.equal\(failed\?\.code, expected\)/g)?.length, 2);
   assert.equal(smoke.match(/'invalid-marker': '(?:restore-purpose-guard-mismatch|recovery-target-unsafe)'/g)?.length, 2);
   assert(smoke.includes("'resource-refused': 'internal-resources-insufficient'"));
   assert(smoke.includes("assert.equal(entry.importValidation, 'failed')"));
   assert(smoke.includes('await client.verifyEmptyTarget(target, c.id)'));
   assert(runner.includes("$observerMemory=if($scenario -eq 'resource-refused'){'2g'}else{'4g'}"));
   assert(runner.includes('--memory 384m --memory-swap 384m --cpus 0.5 --pids-limit 64'));
   assert(runner.includes('--memory 2g --memory-swap 2g --cpus 1 --pids-limit 128'));
   assert(runner.includes('capacity.mjs,readonly'));
   assert(workflow.includes('scripts/__tests__/mysqlAutomaticRecoveryCapacity.test.mjs'));
   assert(!/--privileged|SYS_ADMIN|docker\.sock|--publish|--network host/.test(runner));
});

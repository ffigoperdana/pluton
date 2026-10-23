import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { inventory, render } from '../api-inventory.mjs';
test('all route modules are mounted and inventoried, including custom features and expanded lifecycle routes', () => {
  const entries = inventory();
  const files = fs
    .readdirSync(new URL('../../backend/src/routes/', import.meta.url))
    .filter((file) => file.endsWith('.ts') && file !== 'index.ts');
  for (const file of files)
    assert.ok(
      entries.some(
        (entry) => entry.routeSource === `backend/src/routes/${file}`,
      ),
      file,
    );
  assert.equal(
    new Set(entries.map((entry) => `${entry.method} ${entry.route}`)).size,
    entries.length,
  );
  for (const route of [
    '/api/plans/schedule-preview',
    '/api/agent-admin/devices/:id/source-access/requests',
    '/api/backups/:id/action/replication-retry',
    '/api/database-restores/:id/resume',
    '/api/v1/operations/plans/:planId/recovery-tests',
    '/mcp',
  ])
    assert.ok(
      entries.some((entry) => entry.route === route),
      route,
    );
  assert.equal(
    entries.filter((entry) => entry.feature === 'scoped operations').length,
    12,
  );
  assert.equal(
    fs.readFileSync(
      new URL('../../docs/api-inventory.json', import.meta.url),
      'utf8',
    ),
    JSON.stringify(entries, null, 2) + '\n',
  );
  assert.equal(
    fs.readFileSync(
      new URL('../../docs/API_COVERAGE_MATRIX.md', import.meta.url),
      'utf8',
    ),
    render(entries),
  );
});

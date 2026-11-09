import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

test('production PWA navigation fallback excludes every API attachment/session/error path and preserves app routing', () => {
   const config = fs.readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
   // Evaluate the literal passed to Workbox, not a duplicate of its policy.
   const literal = /navigateFallbackDenylist:\s*(\[[^\n]+\])/.exec(config)?.[1];
   assert(literal);
   const denied: RegExp[] = vm.runInNewContext(literal, {}, { timeout: 1000 });
   for (const route of ['/api', '/api?unknown=1', '/api/', '/api/backups/backup-01/exports/example/link', '/api/backups/backup-01/exports/example/content',
      '/api/backups/example/action/download', '/api/user/validate', '/API/missing', '/docs', '/docs/getting-started'])
      assert(denied.some((rule) => rule.test(route)), route);
   for (const route of ['/', '/login', '/plans/example', '/api-like-page', '/documentation'])
      assert(!denied.some((rule) => rule.test(route)), route);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { recoveryTone, type AssistedRecoveryJob } from '../src/utils/assistedRecovery.ts';

// Presentation contracts for Assisted Recovery and Mirror Details. Recovery
// behaviour itself is covered by assistedRecovery.test.ts and is unchanged.
const require = createRequire(new URL('../package.json', import.meta.url));
const sass = require('sass-embedded');
const src = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const css = (path: string) => sass.compile(fileURLToPath(new URL(`../src/${path}`, import.meta.url))).css as string;
const job = (patch: Partial<AssistedRecoveryJob>) =>
   ({ status: 'checking', cleanupPending: false, expired: false, expiresAt: Date.now() + 60000, ...patch }) as AssistedRecoveryJob;

test('every recovery state maps to one status tone; colour never upgrades an unfinished state', () => {
   assert.equal(recoveryTone(job({ status: 'checking' })), 'progress');
   assert.equal(recoveryTone(job({ status: 'running' })), 'progress');
   assert.equal(recoveryTone(job({ status: 'awaiting-approval' })), 'attention');
   assert.equal(recoveryTone(job({ status: 'awaiting-approval', expired: true })), 'attention');
   assert.equal(recoveryTone(job({ status: 'completed' })), 'success');
   assert.equal(recoveryTone(job({ status: 'primary-ready' })), 'success');
   assert.equal(recoveryTone(job({ status: 'failed' })), 'error');
   assert.equal(recoveryTone(job({ status: 'uncertain' })), 'error');
   assert.equal(recoveryTone(job({ status: 'cancelled' })), 'neutral');
   // Cleanup pending outranks a finished status and is never shown as success.
   assert.equal(recoveryTone(job({ status: 'cancelled', cleanupPending: true })), 'attention');
   assert.equal(recoveryTone(job({ status: 'completed', cleanupPending: true })), 'attention');
});

test('Assisted Recovery uses its themed module instead of browser defaults and inline styles', () => {
   const view = src('components/Restore/AssistedRecovery/AssistedRecovery.tsx');
   assert.match(view, /import classes from '\.\/AssistedRecovery\.module\.scss'/);
   assert.ok(!/style=\{\{/.test(view), 'no inline style objects');
   assert.match(view, /className=\{`\$\{classes\.status\} \$\{classes\[recoveryTone\(job\)\]\}`\}/);
   assert.match(view, /className=\{classes\.primary\}[\s\S]{0,400}?Continue with S3 Replica/);
   assert.match(view, /className=\{classes\.replica\}/);
   assert.match(view, /className=\{classes\.meta\}/);
   const styles = css('components/Restore/AssistedRecovery/AssistedRecovery.module.scss');
   assert.ok(!/#[0-9a-f]{3,8}\b|(?<![\w-])(?:white|black)(?![\w-])/i.test(styles), 'theme tokens only');
   for (const token of ['--field-bg', '--primary-color', '--success-text-color', '--warning-text-color', '--error-text-color'])
      assert.ok(styles.includes(`var(${token})`), `uses ${token}`);
});

test('Mirror Details lists replicas before recovery controls and drops hard-coded colours', () => {
   const view = src('components/Plan/Mirrors/MirrorDetails.tsx');
   assert.ok(view.indexOf('classes.mirrorList') < view.indexOf('<AssistedRecovery'), 'mirror information comes first');
   assert.match(view, /className=\{classes\.recovery\}/);
   assert.match(view, /<img alt="" /);
   const styles = css('components/Plan/Mirrors/MirrorDetails.module.scss');
   assert.ok(!/#[0-9a-f]{3,8}\b|(?<![\w-])(?:white|black)(?![\w-])/i.test(styles), 'theme tokens only');
});

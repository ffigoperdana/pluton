import assert from 'node:assert/strict';
import test from 'node:test';
import {
   affectedSourcePlans,
   buildAgentInstallCommand,
   effectiveSourceRoots,
   hostApprovalCommand,
   parseSourceRoots,
   sourceInsideRoot,
   sourcePathError,
   sourceAuthorizationMode,
   sourceMaximumRoots,
   currentSourceValidation,
   hostModeSetupCommand,
} from '../src/utils/agentSourceAccess.ts';
import type { SourceAccessView } from '../src/@types/agentSourceAccess.ts';

const revision = 'a'.repeat(64);
const root = '/srv/example-app';
const view: SourceAccessView = {
   supported: true,
   online: true,
   reportFresh: true,
   report: {
      version: 1,
      hostPolicyRevision: revision,
      effectiveVersion: 1,
      approvedRoots: [root, '/srv/example-worker'],
      effectiveRoots: [root],
      rootStatuses: [{ path: root, status: 'readable' }],
   },
   requests: [],
   affectedPlans: [],
};

test('bulk roots normalize trailing slash and reject duplicates, overlaps and resource limits', () => {
   assert.deepEqual(parseSourceRoots('/srv/example-app/\r\n/srv/example-worker\n'), { roots: [root, '/srv/example-worker'] });
   for (const input of ['', `${root}\n${root}/`, `${root}\n${root}/public`, Array.from({ length: 33 }, (_, index) => `/srv/app-${index}`).join('\n')])
      assert.ok(parseSourceRoots(input).error);
   assert.ok(sourcePathError('/srv/' + 'a'.repeat(1024)));
});

test('new roots cannot name broad/system paths, relative paths, traversal or control syntax', () => {
   for (const input of [
      '/',
      '/home',
      '/srv',
      '/var/www',
      '/opt',
      '/mnt',
      '/media',
      '/run',
      '/etc/app',
      '/proc/self',
      '/sys/class',
      '/dev/sda',
      '/boot/app',
      '/root/app',
      '/var/lib/pluton-agent/state',
      '/opt/pluton-agent/app',
      'srv/app',
      '//srv/app',
      '/srv/../app',
      '/srv/./app',
      '/srv/app\nother',
      '/srv/app\t',
      '/srv/app\\other',
      '/srv/app,other',
   ])
      assert.ok(sourcePathError(input), input);
   assert.equal(sourcePathError(root), undefined);
   assert.equal(sourcePathError('/home', true), undefined, 'existing static policy remains representable');
   for (const input of [
      '/usr',
      '/usr/local',
      '/usr/share',
      '/usr/lib',
      '/bin',
      '/sbin',
      '/lib',
      '/lib64',
      '/var/lib',
      '/var/log',
      '/var/cache',
      '/tmp',
      '/var/tmp',
      '/run/user',
      '/lost+found',
      '/var/lib/pluton-agent-upgrades/private',
      '/srv//example-app',
   ])
      assert.ok(sourcePathError(input), input);
   assert.equal(sourcePathError('/var/lib/example-app'), undefined);
});

test('only fresh online readable effective roots are selectable; approved or pending roots do not become effective', () => {
   assert.deepEqual(effectiveSourceRoots(view), [root]);
   assert.deepEqual(effectiveSourceRoots({ ...view, online: false }), []);
   assert.deepEqual(effectiveSourceRoots({ ...view, reportFresh: false }), []);
   assert.deepEqual(effectiveSourceRoots({ ...view, supported: false }), []);
   assert.deepEqual(effectiveSourceRoots({ ...view, report: { ...view.report!, policyError: 'policy-invalid' } }), []);
   assert.deepEqual(effectiveSourceRoots({ ...view, report: { ...view.report!, rootStatuses: [{ path: root, status: 'unreadable' }] } }), []);
});

test('removal warnings use directory containment and exact plan identity', () => {
   assert.equal(sourceInsideRoot('/srv/example-app-2', root), false);
   assert.equal(sourceInsideRoot(`${root}/public`, root), true);
   const plans = [
      { id: 'plan-01', title: 'Application', sourcePath: `${root}/public`, isActive: false },
      { id: 'plan-02', title: 'Worker', sourcePath: '/srv/example-worker', isActive: true },
   ];
   assert.deepEqual(affectedSourcePlans(plans, [root]), [plans[1]]);
   assert.deepEqual(affectedSourcePlans(plans, []), plans);
});

test('enrollment emits repeated shell-quoted roots and keeps secure command token-free', () => {
   const roots = [root, "/srv/example-app's worker"];
   const secure = buildAgentInstallCommand('https://example.internal', roots, false);
   assert.equal(secure.match(/--allowed-root/g)?.length, 2);
   assert.match(secure, /example-app'\\''s worker/);
   assert.doesNotMatch(secure, /--token|--allow-insecure-http/);
   const quick = buildAgentInstallCommand('http://example.internal', roots, true, 'synthetic-enrollment-token');
   assert.match(quick, /--token 'synthetic-enrollment-token'/);
   assert.match(quick, /--allow-insecure-http$/);
});

test('host approval command binds local config, identity and revision without resetting static roots', () => {
   const command = hostApprovalCommand('agent-01', revision, [root, '/srv/example-worker']);
   assert.match(command, /source-access approve/);
   assert.match(command, /--config-file \/etc\/pluton-agent.env/);
   assert.match(command, /--agent-id 'agent-01'/);
   assert.ok(command.includes(`--expected-host-policy-revision '${revision}'`));
   assert.equal(command.match(/--root /g)?.length, 2);
   assert.doesNotMatch(command, /--allowed-roots|password|token/);
});

test('absent mode stays strict and delegated fields authorize nothing without current host delegation', () => {
   const report = { ...view.report!, delegatedRoots: ['/srv/example-apps'] };
   assert.equal(sourceAuthorizationMode(report), 'host-approved');
   assert.deepEqual(sourceMaximumRoots(report), [root, '/srv/example-worker']);
   assert.deepEqual(sourceMaximumRoots({ ...report, authorizationMode: 'server-managed' }), [root, '/srv/example-worker', '/srv/example-apps']);
   for (const secret of ['/srv/example-app/.ssh', '/srv/example-app/.aws/credentials', '/srv/example-app/.gnupg', '/srv/example-app/.kube'])
      assert.ok(sourcePathError(secret));
});

test('current validation binds exact input and host selection before canonical Apply', () => {
   const request = {
      id: 'validate-01',
      requestId: 'validate-01',
      kind: 'validate' as const,
      status: 'validated' as const,
      roots: ['/srv/example-alias'],
      expectedVersion: 1,
      expectedHostPolicyRevision: revision,
      validation: [{ requestedPath: '/srv/example-alias', canonicalPath: '/srv/example-apps/app-01', status: 'approved' as const }],
      createdAt: '2026-01-01T00:00:00Z',
   };
   const data = { ...view, requests: [request] };
   assert.deepEqual(currentSourceValidation(data, request.requestId, request.roots), request.validation);
   assert.equal(currentSourceValidation(data, request.requestId, ['/srv/other']), undefined);
   assert.equal(currentSourceValidation({ ...data, report: { ...data.report!, effectiveVersion: 2 } }, request.requestId, request.roots), undefined);
   assert.equal(
      currentSourceValidation({ ...data, report: { ...data.report!, hostPolicyRevision: 'b'.repeat(64) } }, request.requestId, request.roots),
      undefined,
   );
});

test('one-time mode command binds immutable receipt and deliberate drain without changing config or identity', () => {
   const request = {
      id: 'setup-01',
      requestId: 'setup-01',
      kind: 'mode-setup' as const,
      requestedMode: 'server-managed' as const,
      status: 'pending-host-setup' as const,
      roots: ['/srv/example-apps', '/srv/example-workers'],
      expectedVersion: 1,
      expectedHostPolicyRevision: revision,
      createdAt: '2026-01-01T00:00:00Z',
   };
   const command = hostModeSetupCommand('agent-01', request);
   assert.match(command, /source-access delegate/);
   assert.match(command, /--request-id 'setup-01'/);
   assert.match(command, /--confirm-delegation/);
   assert.match(command, /--confirm-drained/);
   assert.equal(command.match(/--root /g)?.length, 2);
   assert.doesNotMatch(command, /enroll|--token|--allowed-roots|password/);
   const strict = hostModeSetupCommand('agent-01', { ...request, requestedMode: 'host-approved', roots: [] });
   assert.match(strict, /source-access host-approved/);
   assert.doesNotMatch(strict, /--root |--confirm-delegation/);
});

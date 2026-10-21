import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStandaloneAgentCommand, type AgentDistribution } from '../src/utils/agentEnrollment.ts';

const distribution: AgentDistribution = {
   repositoryUrl: 'https://git.example.internal/agents/pluton-agent.git',
   commit: 'a'.repeat(40),
   version: '0.7.0',
   contract: 'pluton-agent-standalone-v1',
};
const generate = (value: AgentDistribution | undefined = distribution, url = 'https://example.internal', roots = ['/srv/example-app']) =>
   buildStandaloneAgentCommand(value, url, roots);

test('complete fail-fast clone/pin/version/install block uses standalone root installer and no secret arguments', () => {
   const script = generate({ ...distribution, caFile: '/etc/ssl/example CA.pem' }, 'https://example.internal:8443', [
      "/srv/example-app's worker",
      '/srv/$(not-executed)',
   ]);
   assert.ok(script.startsWith('(\n  set -euo pipefail'));
   assert.ok(script.endsWith('\n)'));
   assert.match(script, /git clone --no-checkout -- 'https:\/\/git.example.internal\/agents\/pluton-agent.git' pluton-agent/);
   assert.match(script, /git checkout --detach 'a{40}'/);
   assert.match(script, /git rev-parse HEAD/);
   assert.match(script, /git status --porcelain/);
   assert.match(script, /package.get\('version'\)/);
   assert.match(script, /AGENT_VERSION/);
   assert.match(script, /sudo bash install-agent.sh/);
   assert.equal(script.match(/--allowed-root /g)?.length, 2);
   assert.ok(script.includes("'/srv/example-app'\\''s worker'"));
   assert.ok(script.includes("'/srv/$(not-executed)'"));
   assert.match(script, /--ca-file '\/etc\/ssl\/example CA.pem'/);
   assert.doesNotMatch(script, /--token|--re-enroll|allow-insecure|installers\/install-agent|uninstall|curl|wget/);
   assert.ok(script.indexOf('git checkout') < script.indexOf('sudo bash'));
});

test('unconfigured, old server, moving refs, incompatible versions and unsafe distribution fail closed', () => {
   assert.throws(() => buildStandaloneAgentCommand(undefined, 'https://example.internal', ['/srv/example-app']));
   for (const patch of [
      { commit: '' },
      { commit: 'main' },
      { commit: 'a'.repeat(12) },
      { commit: '0'.repeat(40) },
      { version: '0.8.0' },
      { contract: 'old-monorepo' },
      ...[
         'http://example.internal/a.git',
         'https://user@example.internal/a.git',
         'https://example.internal/a.git?credential=synthetic',
         'https://example.internal/a.git#main',
         'https://example.internal/a/../b.git',
         'file:///tmp/a.git',
         'https://example.internal/a.git\n',
      ].map((repositoryUrl) => ({ repositoryUrl })),
      ...['relative', '/etc/../ca.pem', '/tmp/ca\n.pem'].map((caFile) => ({ caFile })),
   ]) {
      assert.throws(() => generate({ ...distribution, ...patch } as AgentDistribution), JSON.stringify(patch));
   }
});

test('HTTP exceptions never weaken new-install TLS; invalid roots, URL credentials and control payloads refuse', () => {
   for (const url of [
      'http://example.internal',
      'https://user:synthetic@example.internal',
      'https://example.internal/path',
      'https://example.internal?token=synthetic',
   ])
      assert.throws(() => generate(distribution, url));
   for (const roots of [
      [],
      [''],
      ['/'],
      ['/etc'],
      ['/srv/../app'],
      ['/srv/app\n/srv/other'],
      ['/srv/app', '/srv/app'],
      ['/srv/app', '/srv/app/child'],
   ])
      assert.throws(() => generate(distribution, 'https://example.internal', roots));
});

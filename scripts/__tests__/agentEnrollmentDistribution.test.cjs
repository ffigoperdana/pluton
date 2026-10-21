const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.join(__dirname, '../..');

test('fresh-enrollment distribution configuration is explicitly forwarded without mutable or personal defaults', () => {
  const compose = fs.readFileSync(path.join(root, 'deploy/compose.yml'), 'utf8');
  const templates = ['.env.template', 'deploy/.env.example'].map(file => fs.readFileSync(path.join(root, file), 'utf8'));
  for (const name of ['AGENT_INSTALL_REPOSITORY_URL', 'AGENT_INSTALL_COMMIT', 'AGENT_INSTALL_VERSION', 'AGENT_INSTALL_CA_FILE']) {
    assert.ok(compose.includes(`${name}: "\${${name}:-}"`), name);
    for (const template of templates) assert.ok(template.includes(`# ${name}=`), name);
  }
  const enrollment = fs.readFileSync(path.join(root, 'frontend/src/components/Device/AgentEnrollment/AgentEnrollment.tsx'), 'utf8');
  assert.doesNotMatch(enrollment, /github\.com\/ffigoperdana|installers\/install-agent|Quick install|uninstall|--purge|--token /);
  assert.match(enrollment, /buildStandaloneAgentCommand/);
});

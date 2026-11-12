import { writeFileSync } from 'node:fs';
import { buildStandaloneAgentCommand } from '../../../frontend/src/utils/agentEnrollment.ts';
const [commit, target, version] = process.argv.slice(2);
if (!version) throw new Error('Usage: generate.mjs <reviewed-commit> <context> <reviewed-version>');
const script = buildStandaloneAgentCommand({ repositoryUrl: 'https://localhost:18443/git/pluton-agent.git',
  commit, version, contract: 'pluton-agent-standalone-v1', caFile: '/opt/test-trust/ca.pem' },
  'https://localhost:18443', ['/srv/example app', '/srv/example-worker']);
writeFileSync(target + '/generated.sh', script + '\n');
writeFileSync(target + '/expected-commit', commit + '\n');
writeFileSync(target + '/expected-version', version + '\n');

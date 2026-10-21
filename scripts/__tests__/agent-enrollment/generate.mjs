import { writeFileSync } from 'node:fs';
import { buildStandaloneAgentCommand } from '../../../frontend/src/utils/agentEnrollment.ts';
const [commit, target] = process.argv.slice(2);
const script = buildStandaloneAgentCommand({ repositoryUrl: 'https://localhost:18443/git/pluton-agent.git',
  commit, version: '0.7.0', contract: 'pluton-agent-standalone-v1', caFile: '/opt/test-trust/ca.pem' },
  'https://localhost:18443', ['/srv/example app', '/srv/example-worker']);
writeFileSync(target + '/generated.sh', script + '\n');
writeFileSync(target + '/expected-commit', commit + '\n');

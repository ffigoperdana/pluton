import { parseSourceRoots } from './agentSourceAccess.ts';

export type AgentDistribution = {
   repositoryUrl: string;
   commit: string;
   version: string;
   contract: 'pluton-agent-standalone-v1';
   caFile?: string;
};
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const hasControl = (value: string) => Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

/** Validate again at the rendering boundary; an older/misconfigured Server has no fallback. */
export function buildStandaloneAgentCommand(distribution: AgentDistribution | undefined, serverUrl: string, roots: string[]): string {
   if (
      !distribution ||
      distribution.contract !== 'pluton-agent-standalone-v1' ||
      distribution.version !== '0.7.0' ||
      !/^[a-f0-9]{40}$/.test(distribution.commit) ||
      /^0+$/.test(distribution.commit)
   )
      throw new Error('Standalone Agent distribution is unavailable.');
   const repo = new URL(distribution.repositoryUrl);
   const server = new URL(serverUrl);
   if (
      repo.protocol !== 'https:' ||
      distribution.repositoryUrl.length > 2048 ||
      hasControl(distribution.repositoryUrl) ||
      repo.username ||
      repo.password ||
      repo.search ||
      repo.hash ||
      distribution.repositoryUrl.includes('?') ||
      distribution.repositoryUrl.includes('#') ||
      repo.href !== distribution.repositoryUrl ||
      !/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\.git$/.test(repo.pathname) ||
      server.protocol !== 'https:' ||
      server.username ||
      server.password ||
      server.search ||
      server.hash ||
      server.pathname !== '/'
   )
      throw new Error('A credential-free HTTPS repository and HTTPS Agent server are required.');
   if (!roots.length || roots.some((root) => root.includes('\n') || root.includes('\r')) || parseSourceRoots(roots.join('\n')).error)
      throw new Error('Review the planned source roots.');
   const ca = distribution.caFile;
   if (
      ca &&
      (!ca.startsWith('/') ||
         ca.length > 1024 ||
         ca.includes('\\') ||
         hasControl(ca) ||
         ca
            .slice(1)
            .split('/')
            .some((p) => !p || p === '.' || p === '..'))
   )
      throw new Error('Review the approved host CA file path.');
   return [
      '(',
      '  set -euo pipefail',
      '  command -v git >/dev/null',
      '  command -v python3 >/dev/null',
      '  if [ -e /opt/pluton-agent ] || [ -e /etc/pluton-agent.env ] || [ -e /var/lib/pluton-agent/identity.json ]; then',
      "    printf '%s\\n' 'Existing Agent detected. Use its reviewed upgrade path.' >&2; exit 1",
      '  fi',
      `  git clone --no-checkout -- ${quote(distribution.repositoryUrl)} pluton-agent`,
      '  cd pluton-agent',
      `  git checkout --detach ${quote(distribution.commit)}`,
      `  test "$(git rev-parse HEAD)" = ${quote(distribution.commit)}`,
      '  test -z "$(git status --porcelain --untracked-files=all)"',
      '  test -f install-agent.sh && test ! -L install-agent.sh',
      `  python3 - ${quote(distribution.version)} <<'PLUTON_AGENT_VERSION'`,
      'import json, pathlib, re, sys',
      "package = json.loads(pathlib.Path('agent/package.json').read_text())",
      'runtime = re.search(r"export const AGENT_VERSION = [\'\\"]([^\'\\"]+)[\'\\"]", pathlib.Path(\'agent/src/inventory.ts\').read_text())',
      "if package.get('name') != '@plutonhq/pluton-agent' or package.get('version') != sys.argv[1] or not runtime or runtime[1] != sys.argv[1]:",
      "    raise SystemExit('Reviewed Agent version does not match the distribution.')",
      'PLUTON_AGENT_VERSION',
      '  sudo bash install-agent.sh \\',
      `    --server ${quote(server.origin)} \\`,
      ...roots.map((root, index) => `    --allowed-root ${quote(root)}${index < roots.length - 1 || ca ? ' \\' : ''}`),
      ...(ca ? [`    --ca-file ${quote(ca)}`] : []),
      ')',
   ].join('\n');
}

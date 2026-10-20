const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..', '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
test('native argument inspection detects password flags, not unrelated protocol/public-key options', async () => {
  const { isPasswordArgument } = await import('../../backend/__tests__/integration/mysqlRecoveryWorker.observe.mjs');
  for (const value of ['--protocol=tcp', '--port=3306', '--get-server-public-key', '--defaults-file=/tmp/pluton-mysql-fixture/credentials.cnf']) assert.equal(isPasswordArgument(value), false);
  for (const value of ['-p', '-psynthetic-fixture', '--password=synthetic-fixture', '--password', '--password2=synthetic-fixture']) assert.equal(isPasswordArgument(value), true);
});
test('worker uses a pinned glibc base and official, signature-verified, SHA-pinned Oracle LTS packages', () => {
  const docker = read('Dockerfile.mysql-recovery-worker');
  assert.match(docker, /node:24\.16\.0-bookworm-slim@sha256:[a-f0-9]{64}/);
  assert.match(docker, /signed-by=\/usr\/share\/keyrings\/mysql-community.gpg/);
  assert.match(docker, /BCA43417C3B485DD128EC6D4B7B3B788A8D3785C/);
  for (const [name, hash] of [
    ['mysql-community-client-core', '19c6e1d38f95fa77ebb675c01c0b3c50554026adc5ed0c114cee2a72520c2fea'],
    ['mysql-community-client-plugins', '95b66f6ba68e2b064e175fa7368ae6d6d52919b92b7d69e6b48d949af642eb07'],
  ]) {
    assert(docker.includes(`https://repo.mysql.com/apt/debian/pool/mysql-8.4-lts/m/mysql-community/${name}_8.4.11-1debian12_amd64.deb`));
    assert(docker.includes(`${hash}  /tmp/${name}_8.4.11-1debian12_amd64.deb`));
    for (const field of ['Package', 'Version', 'Architecture']) assert(docker.includes(`${name}_8.4.11-1debian12_amd64.deb ${field})`));
  }
  assert.match(docker, /sha256sum -c/);
  assert.equal((docker.match(/apt-get update --error-on=any/g) || []).length, 2);
  assert.match(docker, /--proto '=https' --proto-redir '=https' --tlsv1\.2/);
  assert(!/allow-unauthenticated|trusted=yes|AllowInsecureRepositories|FROM mysql:|install[^\n]*mysql-community-server/.test(docker));
  assert.match(docker, /USER 10001:10001\s+RUN node/);
  assert(!/EXPOSE|VOLUME|Dockerfile.source/.test(docker));
});

// Run the actual Dockerfile archive-install chain with synthetic network/APT
// adapters. SHA-256 and shell short-circuiting are real; no packages are installed.
const shell = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'bin', 'bash.exe')
  : '/bin/sh';
for (const scenario of ['rolling-index', 'index-failure', 'download-failure', 'corrupt-download', 'wrong-package', 'wrong-version', 'wrong-architecture', 'dependency-failure']) {
  test(`pinned archive installation: ${scenario}`, t => {
    assert(fs.existsSync(shell), 'A POSIX shell is required for package installation regressions');
    const temporaryRoot = path.join(root, 'tmp');
    fs.mkdirSync(temporaryRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'mysql-worker-packages-'));
    t.after(() => {
      assert(directory.startsWith(temporaryRoot + path.sep));
      fs.rmSync(directory, { recursive: true, force: true });
    });
    for (const name of ['bin', 'archives', 'downloads']) fs.mkdirSync(path.join(directory, name));
    let chain = read('Dockerfile.mysql-recovery-worker').match(/&& (curl [^\n]*https:\/\/repo\.mysql\.com\/apt\/debian\/pool\/mysql-8\.4-lts\/m\/mysql-community\/[\s\S]+?)\s+&& apt-get purge/)[1];
    chain = read('Dockerfile.mysql-recovery-worker').match(/&& (apt-get update --error-on=any)/)[1] + ' && ' + chain;
    chain = chain.replace(/\\\r?\n\s*/g, ' ').replaceAll('/tmp/', './downloads/');
    for (const [name, reviewedHash] of [
      ['mysql-community-client-core', '19c6e1d38f95fa77ebb675c01c0b3c50554026adc5ed0c114cee2a72520c2fea'],
      ['mysql-community-client-plugins', '95b66f6ba68e2b064e175fa7368ae6d6d52919b92b7d69e6b48d949af642eb07'],
    ]) {
      const bytes = Buffer.from(`synthetic archive for ${name}\n`);
      fs.writeFileSync(path.join(directory, 'archives', `${name}_8.4.11-1debian12_amd64.deb`), bytes);
      chain = chain.replaceAll(reviewedHash, createHash('sha256').update(bytes).digest('hex'));
    }
    const adapters = {
      curl: `#!/bin/sh
set -eu
printf 'download\\n' >> commands.log
[ "$TEST_MODE" != download-failure ] || exit 22
output=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then output="$2"; shift; fi
  shift
done
[ -n "$output" ]
cp "./archives/\${output##*/}" "$output"
if [ "$TEST_MODE" = corrupt-download ]; then printf 'corrupt' >> "$output"; fi
`,
      'dpkg-deb': `#!/bin/sh
set -eu
printf 'metadata\\n' >> commands.log
[ "$1" = -f ]
name="\${2##*/}"
case "$3" in
  Package) if [ "$TEST_MODE" = wrong-package ]; then printf 'mysql-community-server'; else printf '%s' "\${name%_8.4.11-1debian12_amd64.deb}"; fi ;;
  Version) if [ "$TEST_MODE" = wrong-version ]; then printf '8.4.13-1debian12'; else printf '8.4.11-1debian12'; fi ;;
  Architecture) if [ "$TEST_MODE" = wrong-architecture ]; then printf 'arm64'; else printf 'amd64'; fi ;;
  *) exit 1 ;;
esac
`,
      'apt-get': `#!/bin/sh
set -eu
if [ "$1" = update ]; then
  [ "$2" = --error-on=any ]
  printf 'index\\n' >> commands.log
  [ "$TEST_MODE" != index-failure ] || exit 100
  exit 0
fi
mode=install
count=0
# Only 8.4.13 is in the synthetic index. Older packages must be explicit files.
for argument do
  case "$argument" in
    --download-only) mode=download ;;
    mysql-community-client-*=*) exit 100 ;;
    ./downloads/mysql-community-client-core_8.4.11-1debian12_amd64.deb|./downloads/mysql-community-client-plugins_8.4.11-1debian12_amd64.deb)
      [ -f "$argument" ]; count=$((count + 1)) ;;
  esac
done
[ "$count" = 2 ]
printf 'apt-%s\\n' "$mode" >> commands.log
[ "$TEST_MODE" != dependency-failure ] || exit 100
`,
    };
    for (const [name, contents] of Object.entries(adapters)) fs.writeFileSync(path.join(directory, 'bin', name), contents, { mode: 0o755 });
    const result = spawnSync(shell, ['-eu', '-c', `export PATH="./bin:$PATH"\n${chain}`], {
      cwd: directory, env: { ...process.env, TEST_MODE: scenario }, encoding: 'utf8', timeout: 10_000,
    });
    const calls = fs.readFileSync(path.join(directory, 'commands.log'), 'utf8');
    if (scenario === 'rolling-index') {
      assert.equal(result.status, 0, result.stderr);
      assert.match(calls, /metadata\napt-download\napt-install\n$/);
    } else {
      assert.notEqual(result.status, 0);
      if (scenario === 'dependency-failure') {
        assert.equal(result.status, 100);
        assert.match(calls, /apt-download\n$/);
      } else assert.doesNotMatch(calls, /apt-/);
      if (scenario === 'index-failure') assert.equal(calls, 'index\n');
      if (scenario === 'corrupt-download') assert.doesNotMatch(calls, /metadata/);
    }
  });
}
test('optional compose shares only private IPC, approved public target config and CA, never application state', () => {
  const overlay = read('deploy/compose.mysql-recovery-worker.yml');
  assert.match(overlay, /PLUTON_MYSQL_WORKER_IMAGE_REF:\?Set a reviewed worker image by digest/);
  assert.match(overlay, /cap_drop: \[ALL\]/);
  assert.match(overlay, /no-new-privileges:true/);
  assert.match(overlay, /user: "10001:10001"/);
  assert.match(overlay, /pluton-mysql-ipc:\/run\/pluton-mysql-worker:ro/);
  assert(!/\n\s+(?:ports|expose|privileged):|\/data|\/var\/run\/docker.sock|\.env|SECRET|ENCRYPTION_KEY/.test(overlay));
  assert(!read('deploy/compose.yml').includes('mysql-recovery-worker'));
});
test('workflow gates both immutable images on real native MySQL IPC imports without publishing PR builds', () => {
  const workflow = read('.github/workflows/container.yml');
  assert.match(workflow, /validate-mysql-recovery-worker.ps1 -RuntimeImage pluton-recovery-ci:local/);
  assert.match(workflow, /publish-mysql-worker:[\s\S]*needs: \[validate, build-pr\]/);
  assert.match(workflow, /ghcr.io\/\$\{\{ github.repository \}\}-mysql-recovery-worker/);
  assert.match(workflow, /file: Dockerfile.mysql-recovery-worker[\s\S]*push: false/);
});
test('native fixture targets only randomized private containers, never host services or supplied credentials', () => {
  const runner = read('scripts/validate-mysql-recovery-worker.ps1');
  assert.match(runner, /docker network create --internal/);
  assert.match(runner, /mysql:8\.4\.11@sha256:[a-f0-9]{64}/);
  assert.match(runner, /Unsafe fixture cleanup target/);
  assert(!/--privileged|--network host|--publish|--port|docker.sock|\[string\]\$(?:Password|Target|Host|Secret)/.test(runner));
});
test('persistent MySQL gate is required and Custom-only fixtures never request privileged mount infrastructure',()=>{
  const workflow=read('.github/workflows/container.yml');
  assert.match(workflow,/run: \.\/scripts\/validate-mysql-persistent-restore\.ps1 -WorkerImage pluton-mysql-worker:local -RuntimeImage pluton-recovery-ci:local/);
  const runner=read('scripts/validate-mysql-persistent-restore.ps1');
  for(const value of ['docker network create --internal',"--user '10001:10001'",'--cap-drop ALL','--network none','Unsafe fixture cleanup target.'])assert(runner.includes(value));
  assert(!/--privileged|SYS_ADMIN|loop-control|docker\.sock|--publish|--network host/.test(runner));
  const fixture=read('backend/__tests__/integration/mysqlPersistentRestore.smoke.mjs');
  assert.match(fixture,/attempt < 20/);assert.match(fixture,/database-target-preflight.*database-import/);
});

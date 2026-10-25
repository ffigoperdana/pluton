import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
assert.equal(process.getuid(), 10001);
assert.equal(process.getgid(), 10001);
const probe = spawnSync('/usr/bin/mysql', ['--no-defaults', '--commands=OFF', '--binary-mode', '--local-infile=0', '--version'], {
  encoding: 'utf8', timeout: 2000, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, shell: false,
});
assert.equal(probe.status, 0);
assert.match(probe.stdout, /Ver 8\.4\.11\b.*MySQL Community/);
assert.doesNotMatch(probe.stdout, /MariaDB/i);
const dump = spawnSync('/usr/bin/mysqldump', ['--no-defaults', '--version'], { encoding: 'utf8', timeout: 2000 });
assert.equal(dump.status, 0);
assert.match(dump.stdout, /Ver 8\.4\.11\b.*MySQL Community/);
assert.doesNotMatch(dump.stdout, /MariaDB/i);
for (const name of ['mysql-community-client-core', 'mysql-community-client-plugins']) {
  const result = spawnSync('/usr/bin/dpkg-query', ['-W', '-f=${Status}\t${Version}\t${Architecture}', name], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'install ok installed\t8.4.11-1debian12\tamd64');
}
for (const name of ['authentication_kerberos_client.so', 'authentication_ldap_sasl_client.so', 'authentication_oci_client.so', 'authentication_webauthn_client.so']) {
  const file = `/usr/lib/mysql/plugin/${name}`;
  assert.equal(statSync(file).uid, 0);
  assert.equal(statSync(file).mode & 0o022, 0);
  const dependencies = spawnSync('/usr/bin/ldd', [file], { encoding: 'utf8', timeout: 2000, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
  assert.equal(dependencies.status, 0);
  assert.doesNotMatch(dependencies.stdout + dependencies.stderr, /not found/);
}
for (const name of ['/usr/sbin/mysqld', '/usr/bin/mysqld', '/usr/bin/mariadbd', '/usr/lib/postgresql', '/var/run/docker.sock', '/data']) assert.equal(existsSync(name), false, name);
assert.equal(statSync('/app/worker.mjs').uid, 0);
assert.equal(statSync('/app/worker.mjs').mode & 0o022, 0);
// Exercise the actual standalone entrypoint, not only mysql --version. Missing
// config must reach its closed refusal; import/native dependency crashes may not.
const startup = spawnSync(process.execPath, ["/app/worker.mjs"], {
  encoding: "utf8",
  timeout: 5000,
  maxBuffer: 4096,
  env: { PATH: "/usr/bin:/bin", NODE_ENV: "production" },
  shell: false,
});
assert.equal(
  startup.status,
  1,
  "Worker must refuse missing synthetic configuration.",
);
assert.equal(
  startup.stdout,
  "",
  "Worker must not claim readiness without configuration.",
);
assert.equal(
  startup.stderr.trim(),
  JSON.stringify({
    event: "mysql-worker-startup",
    stage: "configuration",
    status: "refused",
  }),
  "Standalone worker must reach its guarded configuration stage.",
);
console.log('UID 10001: genuine Oracle MySQL Community 8.4.11 client-only worker verified.');

#!/usr/bin/env bash
set -Eeuo pipefail
[[ -f /opt/pluton-disposable-ubuntu-test && ${PLUTON_DISPOSABLE_INSTALL_TEST:-} == 1 && $EUID == 0 ]] || exit 90
[[ ! -e /opt/pluton-agent && ! -e /var/lib/pluton-agent/identity.json ]] || exit 91
if command -v node >/dev/null; then exit 92; fi
mkdir -p /opt/test-public/git /tmp/enrollment-private /opt/test-trust '/srv/example app' /srv/example-worker /run/systemd/system
chmod 0700 /tmp/enrollment-private
git clone --bare agent.bundle /opt/test-public/git/pluton-agent.git >/dev/null 2>&1
git -C /opt/test-public/git/pluton-agent.git update-server-info
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost' \
  -keyout /tmp/enrollment-private/key.pem -out /tmp/enrollment-private/cert.pem >/dev/null 2>&1
cp /tmp/enrollment-private/cert.pem /opt/test-trust/ca.pem
chmod 0644 /opt/test-trust/ca.pem
python3 -c 'import secrets;print(secrets.token_urlsafe(32))' > /tmp/enrollment-private/token
python3 control-plane.py &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
for attempt in {1..50}; do [[ ! -f /tmp/enrollment-private/ready ]] || break; sleep 0.1; done
[[ -f /tmp/enrollment-private/ready ]]
# Git trust is separate from the Agent --ca-file; never disable verification.
export GIT_SSL_CAINFO=/opt/test-trust/ca.pem
if curl --silent https://localhost:18443/git/pluton-agent.git/HEAD >/dev/null 2>&1; then exit 93; fi
git clone -q /opt/test-public/git/pluton-agent.git /tmp/enrollment-private/wrong-source
python3 - <<'PY'
import json
from pathlib import Path
p = Path('/tmp/enrollment-private/wrong-source/agent/package.json')
v = json.loads(p.read_text()); v['version'] = '0.7.1'; p.write_text(json.dumps(v))
PY
git -C /tmp/enrollment-private/wrong-source -c user.name='Synthetic Test' -c user.email='test@example.invalid' commit -qam 'Synthetic incompatible package'
git -C /tmp/enrollment-private/wrong-source push -q origin HEAD:refs/heads/synthetic-incompatible
git -C /opt/test-public/git/pluton-agent.git update-server-info
git -C /tmp/enrollment-private/wrong-source rev-parse HEAD > /tmp/enrollment-private/bad-commit
python3 - <<'PY'
from pathlib import Path
script = Path('generated.sh').read_text(); commit = Path('expected-commit').read_text().strip()
private = Path('/tmp/enrollment-private')
for label, text in [('version', script.replace(commit, private.joinpath('bad-commit').read_text().strip())),
                    ('missing-commit', script.replace(commit, 'f'*40)),
                    ('unavailable', script.replace('/git/pluton-agent.git', '/git/unavailable.git'))]:
    directory = private/label; directory.mkdir(); (directory/'generated.sh').write_text(text)
PY
for kind in version missing-commit unavailable; do
  if (cd "/tmp/enrollment-private/$kind" && bash generated.sh) > "/tmp/enrollment-private/$kind.log" 2>&1; then exit 95; fi
  [[ ! -e /opt/pluton-agent && ! -e /etc/pluton-agent.env ]]
done
grep -F 'Reviewed Agent version does not match' /tmp/enrollment-private/version.log >/dev/null
printf 'PASS generated flow refuses wrong package version, missing commit and unavailable distribution before installation\n'
python3 terminal.py
[[ ! -e pluton-agent/backend && ! -e pluton-agent/frontend ]]
test "$(git -C pluton-agent rev-parse HEAD)" = "$(cat expected-commit)"
node=/opt/pluton-agent/runtime/bin/node
[[ "$($node -v)" == v22.18.0 ]]
/opt/pluton-agent/bin/restic version | grep -F '0.19.1'
/opt/pluton-agent/bin/rclone version | head -n 1 | grep -F '1.75.1'
grep -Fx 'distribution=pluton-agent-standalone-v1' /opt/pluton-agent/.verified-install >/dev/null
[[ "$(stat -c '%u:%a' /etc/pluton-agent.env)" == 0:600 ]]
[[ "$(stat -c '%a' /var/lib/pluton-agent/identity.json)" == 600 ]]
before=$(sha256sum /etc/pluton-agent.env /var/lib/pluton-agent/identity.json /opt/pluton-agent/.verified-install)
if bash generated.sh > /tmp/enrollment-private/duplicate.log 2>&1; then exit 94; fi
grep -F 'Existing Agent detected' /tmp/enrollment-private/duplicate.log >/dev/null
[[ "$before" == "$(sha256sum /etc/pluton-agent.env /var/lib/pluton-agent/identity.json /opt/pluton-agent/.verified-install)" ]]
# Only fresh synthetic API requests; no real identity/state is changed on refusal.
python3 - <<'PY'
import json, ssl, urllib.request, urllib.error
from pathlib import Path
p = Path('/tmp/enrollment-private')
context = ssl.create_default_context(cafile='/opt/test-trust/ca.pem')
for token in ['synthetic-expired-token', p.joinpath('token').read_text().strip()]:
    request = urllib.request.Request('https://localhost:18443/api/agent/enroll', data=json.dumps({'token': token}).encode(), headers={'Content-Type':'application/json'})
    try:
        urllib.request.urlopen(request, context=context)
        raise AssertionError('expired/replayed token accepted')
    except urllib.error.HTTPError as error:
        assert error.code == 401
proof = json.loads(p.joinpath('proof.json').read_text())
assert proof == {'enrollments':1, 'heartbeats':1, 'polls':0, 'expired':1, 'replayed':1}, proof
print('PASS TLS refusal, token replay/expiry refusal, signed v0.7.0 capability/heartbeat, multiple roots with spaces, strict host boundary')
PY
cd pluton-agent
export PATH=/opt/pluton-agent/runtime/bin:$PATH
export COREPACK_HOME=/tmp/enrollment-private/corepack
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm --filter @plutonhq/pluton-agent build
corepack pnpm test:contracts
bash -n install-agent.sh upgrade-agent.sh installers/install-agent.sh
printf 'PASS existing-install refusal preserved identity/config/provenance; standalone contract tests unchanged\n'
printf 'LIMITATION: adapted systemctl; booted systemd and production server pairing NOT TESTED\n'

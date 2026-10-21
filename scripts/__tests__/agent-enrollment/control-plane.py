"""Disposable compatible TLS enrollment/HMAC server and read-only HTTPS Git mirror."""
import base64
import hashlib
import hmac
import http.server
import json
import secrets
import ssl
import time
from pathlib import Path

private = Path('/tmp/enrollment-private')
secret = secrets.token_hex(32)
token = private.joinpath('token').read_text().strip()
proof = {'enrollments': 0, 'heartbeats': 0, 'polls': 0, 'expired': 0, 'replayed': 0}
nonces = set()

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory='/opt/test-public', **kwargs)

    def log_message(self, *_):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        try:
            body = json.loads(raw)
            if self.path == '/api/agent/enroll':
                if body.get('token') == 'synthetic-expired-token':
                    proof['expired'] += 1
                    raise ValueError('expired')
                assert hmac.compare_digest(body['token'], token)
                if proof['enrollments']:
                    proof['replayed'] += 1
                    raise ValueError('replayed')
                assert body['inventory']['agentVersion'] == '0.7.0'
                assert body['inventory']['capabilities']['backupExclusionsVersion'] == 1
                # Identity-bound Source Access is first reported after enrollment.
                assert 'sourceAccess' not in body['inventory']
                proof['enrollments'] += 1
                result = dict(deviceId='synthetic-device', agentId='synthetic-agent', secret=secret, pollIntervalSeconds=15)
            else:
                assert self.path == '/api/agent/heartbeat'
                stamp, nonce = self.headers['x-pluton-agent-timestamp'], self.headers['x-pluton-agent-nonce']
                assert self.headers['x-pluton-agent-id'] == 'synthetic-agent'
                assert abs(time.time()*1000-int(stamp)) < 60000 and nonce not in nonces
                digest = base64.urlsafe_b64encode(hashlib.sha256(raw).digest()).decode().rstrip('=')
                canonical = '\n'.join([stamp, nonce, 'POST', self.path, digest])
                signature = base64.b64encode(hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).digest()).decode()
                assert hmac.compare_digest(signature, self.headers['x-pluton-agent-signature'])
                nonces.add(nonce)
                assert body['agentVersion'] == '0.7.0' and body['capabilities']['backupExclusionsVersion'] == 1
                assert body['capabilities']['sourceAccessVersion'] == 1
                report = body['sourceAccess']
                assert report['authorizationMode'] == 'host-approved'
                assert not report.get('delegatedRoots')
                assert set(report['approvedRoots']) == {'/srv/example app', '/srv/example-worker'}
                proof['heartbeats'] += 1
                result = {}
            response = json.dumps({'success': True, 'result': result}).encode()
            self.send_response(200)
        except Exception:
            response = b'{"success":false,"error":"Synthetic enrollment rejected"}'
            self.send_response(401)
        private.joinpath('proof.json').write_text(json.dumps(proof))
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(response)))
        self.end_headers()
        self.wfile.write(response)

server = http.server.HTTPServer(('127.0.0.1', 18443), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(private/'cert.pem', private/'key.pem')
server.socket = context.wrap_socket(server.socket, server_side=True)
private.joinpath('ready').touch()
server.serve_forever()

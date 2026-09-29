# Remote Agent foundation

This document describes the independently implemented, Apache-2.0 Phase 4
control-plane foundation for the community fork. It does not use or depend on
any proprietary Pluton implementation.

The agent is an outbound-only Node.js process intended to run as a dedicated,
non-root Linux user. It has no listener, does not need Docker, and does not
need inbound SSH. This foundation does **not** back up files, restore files,
run scripts, invoke an arbitrary shell, or perform repository maintenance.

## What it provides

```text
Administrator browser                 Pluton server                 Remote agent
---------------------                 -------------                 ------------
Create one-time token  ───────────►   stores token hash
                                                                  enrolls outbound ─►
                                    ◄─────────────────────────────────────────────
                                    device + agent identity + encrypted per-agent secret

                                                                  heartbeat / poll ─►
                                    ◄─────────────────────────────────────────────
                                    one leased PING or INVENTORY_REFRESH command
                                                                  ACK / event / completion ─►
```

Every agent request after enrollment includes its agent ID, a timestamp, a
cryptographically random nonce, and an HMAC-SHA256 signature over the HTTP
method, path, nonce, timestamp, and SHA-256 body hash. The server applies a
five-minute clock-skew limit and persists nonce hashes through that window.
Replaying a valid request is rejected. The server stores a different random
secret for every agent, encrypted with its local server secret; no API or UI
response exposes it after enrollment.

The server signs a leased command response with the same per-agent secret. The
agent verifies that signature before acknowledging it. Each delivery has a
random lease token, included in that signature, which must accompany its ACK,
event, and completion requests; a stale delivery cannot update a newer lease.
Commands have durable SQLite state, acknowledgement/completion timestamps,
attempt count, idempotency key, and monotonically increasing event sequence. An
expired lease returns to `queued`, so a server restart does not silently lose it.

Only `PING` and `INVENTORY_REFRESH` can be stored or executed in this phase.
Neither command runs a process or reads a workload path.

## Transport and TLS

Set the server address on the agent; it is not embedded in an enrollment token
or persisted identity:

```sh
PLUTON_SERVER_URL=https://pluton.example.internal
PLUTON_AGENT_DATA_DIR=/var/lib/pluton-agent
PLUTON_AGENT_ALLOWED_ROOTS=/srv/example-app
```

The normal mode is HTTPS with the system trust store. A private CA can be
provided through `PLUTON_AGENT_CA_FILE`. `PLUTON_AGENT_CLIENT_CERT_FILE` and
`PLUTON_AGENT_CLIENT_KEY_FILE` are transport hooks for a future mTLS rollout;
they are optional and do not enable a server-side mTLS requirement yet.

For a temporary trusted LAN pilot only, HTTP requires **both** settings:

```sh
# On the Pluton server
ALLOW_INSECURE_AGENT_HTTP=true

# On the agent
ALLOW_INSECURE_HTTP=true
PLUTON_SERVER_URL=http://192.0.2.10:5173
```

Never use HTTP agent mode across an untrusted or public network. Changing the
agent URL later to an HTTPS domain does not change enrollment, request signing,
polling, or future backup business logic.

## Enrollment

1. In **Sources**, select **Add Remote Machine**, give it a descriptive name,
   and create the one-time token.
2. Copy the command shown by the UI. The raw token is displayed only in that
   dialog and is stored on the server as a hash.
3. On the remote host, as the dedicated agent user, enroll it. A package
   installation exposes the `pluton-agent` command; a direct `dist` copy uses
   the Node.js entry point shown below:

   ```sh
   /usr/bin/node /opt/pluton-agent/index.js enroll --server https://pluton.example.internal --token '<one-time-token>'
   ```

4. Start the service. The remote device appears in Sources after enrollment;
   it reports `ONLINE` while heartbeats arrive, `OFFLINE` after the configured
   timeout, and `REVOKED` immediately after an administrator revokes it.

The agent writes its identity to `identity.json` under
`PLUTON_AGENT_DATA_DIR`, using directory mode `0700` and file mode `0600` on
Linux. Back up neither this file nor an enrollment token to source control.

## Build and install

The agent has no third-party runtime dependencies. Build it with Node.js 20 or
later from this repository, then copy the generated `agent/dist` directory to
the remote host:

```sh
pnpm --filter @plutonhq/pluton-agent build
```

For example, after placing that directory at `/opt/pluton-agent`, invoke it as
`/usr/bin/node /opt/pluton-agent/index.js run`. Keep the directory and its
identity data owned by the dedicated `pluton-agent` user.

## Filesystem policy

`PLUTON_AGENT_ALLOWED_ROOTS` is a comma- or newline-separated list of absolute
paths. It is a future filesystem-command boundary; the agent resolves each root
with `realpath` at startup. Future commands must use the same policy helper,
which rejects control/NUL characters, `..`, relative paths, sibling-prefix
escapes, and symlink escapes. It never relies on `startsWith()` for path
authorization.

No filesystem command is enabled in this phase, so configuring a root only
reports the capability and does not grant a remote caller file access.

## systemd example

Install the compiled `pluton-agent` executable/package using the repository's
normal release process, then adapt this intentionally generic unit:

```ini
[Unit]
Description=Pluton remote agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pluton-agent
Group=pluton-agent
EnvironmentFile=/etc/pluton-agent/agent.env
ExecStart=/usr/bin/node /opt/pluton-agent/index.js run
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

The user needs read access only to the explicitly configured future source
roots. Do not grant it repository credentials, root access, or shell sudo
privileges for this Phase 4 foundation.

## Revocation and limitations

Revoking a remote device immediately blocks heartbeat, poll, ACK, event, and
completion requests because authentication checks the durable revocation flag.
It does not merely hide the device in the UI.

The next scoped change can add a specifically designed filesystem backup
command. It must reuse the path policy, durable command lifecycle, HMAC
authentication, and explicit command allowlist. It must not turn this control
plane into generic remote shell access.

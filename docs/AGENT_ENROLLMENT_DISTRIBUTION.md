# Standalone Agent enrollment distribution

This contract changes **new Linux Agent instructions only**. Existing enrolled
Agents, one-time token consumption, HMAC/nonce verification, command leases,
identity, Source Access approval and upgrade/provenance files are unchanged.
The old modal hardcoded a personal Server fork, `cd pluton`, the monorepo
`installers/install-agent.sh`, token-in-argv Quick install, and uninstall/purge.
The new modal uses a separately reviewed standalone distribution with private
token prompting. It offers no destructive lifecycle command during enrollment.

## Server configuration

Set explicitly through the existing operator-controlled environment mechanism:

| Setting | Contract |
| --- | --- |
| `AGENT_INSTALL_REPOSITORY_URL` | Credential-free HTTPS Git `.git` URL, including private organization repositories. No embedded user/password, query, fragment, shell/control characters or ref. |
| `AGENT_INSTALL_COMMIT` | Full lowercase 40-character SHA of the reviewed standalone source available in that repository. No tag, branch or abbreviated SHA. |
| `AGENT_INSTALL_VERSION` | `0.7.0`, the currently reviewed standalone installer/protocol contract. Future versions require compatibility review. |
| `AGENT_INSTALL_CA_FILE` | Optional absolute PEM CA path already provisioned securely on the **Agent host** and readable by its service user. It does not configure Git trust. |
| `AGENT_SERVER_URL` | Optional existing Agent origin override; the generated new installation requires HTTPS. Existing explicitly approved HTTP Agent transport is not changed. |

`.env.template` and `deploy/.env.example` contain placeholders only. Official
`deploy/compose.yml` forwards all four distribution settings. Custom deployment
systems must forward them explicitly. Missing/invalid metadata returns sanitized
HTTP 503 **before** a new token is created, without stopping the server or changing
existing Agents. Enrollment response uses `Cache-Control: no-store`; no secret is
added to environment examples, Git metadata, generated commands or browser storage.
No server configuration file is rewritten by this feature.

Review standalone source/CI, ownership/installer contract and the exact full SHA
before supplying the values. A version/revision label alone is insufficient.
The Server does not fetch or execute that repository: actual availability and
commit/version are checked on the new host. A failed clone/checkout/version check
stops the entire generated Bash subshell before sudo; there is no fallback.

## Generated workflow

The UI produces one complete fail-fast Bash block. Conceptually (placeholders
below are intentionally not executable):

```sh
git clone --no-checkout -- '<configured-HTTPS-standalone-repository.git>' pluton-agent
cd pluton-agent
git checkout --detach '<reviewed-full-commit-sha>'
# Verify exact HEAD, clean checkout, root installer and package/runtime version.
sudo bash install-agent.sh \
  --server 'https://pluton.example.internal' \
  --allowed-root '/srv/example app' \
  --allowed-root '/srv/example-worker'
```

Use **Copy installation commands** for the actual complete block, including its
fail-fast wrapper and checks. Host prerequisites: supported Ubuntu 22.04/Linux
x86_64/systemd, Bash, Git, Python 3, sudo, outbound HTTPS, readable canonical roots,
and trusted CA. Private Node/Corepack, pinned pnpm, Restic/Rclone and app build are
provided by the standalone installer; no global Node or pnpm is required.

Use the normal host administrator's approved Git credential manager/helper or
temporary interactive read-only authorization for a private repository. Do not
put a long-lived credential in the repository URL, configuration or terminal
history. Git private CA trust is separate from the Agent CA option. Direct private
artifact/archive installation is **not implemented** by this Git-based generator;
it needs its own reviewed immutable artifact and integrity contract.

Initial roots are quoted individually, including spaces/apostrophes. UI rejects
empty, broad/system, traversal, duplicate and overlapping paths. The host remains
authoritative for realpath, symlink, ownership and readability checks. Planned
Server-Managed scope grants no access: install remains Host-Approved, then requires
receipt-bound host setup and current Validate/Apply/effective acknowledgement.
No `--re-enroll`, force, HTTP exception, shell download pipe, TLS bypass or automatic
policy delegation is generated. Token remains in temporary UI memory, hidden by
default, and is pasted into the installer's private prompt. Expired tokens disable
the command preview; used/revoked tokens are still rejected authoritatively by the
server. A failed revoke is reported as possibly still active.

## Lifecycle compatibility

| Installation origin | Supported path |
| --- | --- |
| New standalone | Reviewed standalone root `install-agent.sh`; refuses existing installation. |
| Existing standalone | Root `upgrade-agent.sh` from its reviewed standalone checkout, per that repository's compatibility/drain procedure. |
| Existing monorepo | Keep monorepo `installers/upgrade-agent.sh` and its provenance contract; see [AGENT_UPGRADE.md](AGENT_UPGRADE.md). |
| Monorepo → standalone | Separate state-preserving migration design and authorization required; this change does not migrate it. |

## Focused disposable validation

From Pluton, with a clean separately reviewed standalone checkout and Docker:

```powershell
./scripts/validate-agent-enrollment.ps1 -AgentCheckout <standalone-checkout> -AgentCommit <reviewed-full-sha>
```

This exports that commit read-only into an ignored unique Pluton test context.
An isolated pinned Ubuntu 22.04 image runs the **actual UI command generator**,
HTTPS Git clone/immutable checkout, exact source version checks, real standalone
installer/private tools/build and hidden TTY token prompt. Synthetic compatible
TLS enrollment/HMAC heartbeat checks version/capabilities, multiple roots including
spaces, strict host policy, token expiry/replay refusal and no command polling.
Missing commit/distribution and wrong package version are rejected before install.
Reinstall refusal preserves config/identity/provenance. Independent standalone
contract tests are executed unchanged. The task image is removed in finally;
private synthetic context and ordinary build cache stay local/ignored for audit.
No host mounts, Docker socket, privileged containers or production access are used.

Systemctl is an explicitly labelled container adapter. This does **not** prove a
booted systemd/cgroup service, real private Git organization access, or production
server pairing. Actual token store/enrollment/nonce/security regression tests run
against disposable SQLite separately; the compatible TLS fixture is not production
acceptance. Review these limits before scheduling a controlled real enrollment.

### Local validation record

Validated on the Pluton feature branch based on Server main
`9021b1274f3ea084a887446e321bc6984a688497`, with a read-only export of standalone
Agent `056b8272198de3b5532a7bdd2ef257c67661d0dc` (0.7.0):

- Backend focused enrollment/configuration/token/Source Access/origin: **177 passed**.
- Complete frontend Node regression set: **268 passed**.
- Documentation article validation: **15 passed**; documentation renderer: **8 passed**.
- Deployment forwarding/origin wiring: **4 passed**.
- Backend and frontend TypeScript/production builds: **passed**.
- Backend ESLint and patch whitespace: **passed**.
- Pinned Ubuntu 22.04 actual generated HTTPS clone/install/hidden prompt/enrollment/
  heartbeat/negative-version/missing-distribution/duplicate-install checks: **passed**.
- Unmodified standalone protocol/docs/release contract tests in that Ubuntu checkout:
  **6 passed, zero skipped**.
- Frontend ESLint: **blocked by the pre-existing ESLint 10/typescript-eslint
  configuration loader error** (`extends: "eslint-config-prettier"`). No check was
  disabled and no unrelated lint configuration was changed.

Initial disposable-harness failures were corrected in the test setup: sudo strips
the adapter's environment flag; Source Access is reported after identity enrollment;
contract tests require compiled source artifacts and the private Corepack invocation.
The standalone installer/protocol and Pluton security guards were not modified to
make these tests pass. No production access, policy change, deployment or publication
was performed. The standalone working checkout was not changed.

# Agent S3 probe (stage 0)

Stage 0 of [S3_AGENT_REPOSITORY_DESIGN.md](S3_AGENT_REPOSITORY_DESIGN.md) (section 5). Before an
S3-compatible store (Hitachi Content Platform) is used as a Managed Agent repository, the operator
runs `scripts/diagnostics/agent-s3-probe.sh` on the future Agent host, the ERP host first. It answers
five questions with closed facts: does the endpoint resolve, does its certificate verify, can this
host authenticate, write, read back and delete an object, and how fast.

Nothing is deployed. No migration, no server or Agent change, no Agent update or re-enrollment, and
no deploy order. The probe needs neither Node nor the Pluton Agent.

## What the probe does

1. **Rclone.** Uses `--rclone PATH` (it must contain a `/`, for example `./rclone`) when given, otherwise the Agent's private Rclone at
   `/opt/pluton-agent/bin/rclone`, otherwise downloads the release the Agent installer pins
   (Rclone 1.75.1, `linux-amd64`, from `downloads.rclone.org`) into its temporary directory and
   checks the installer's SHA-256 before running it. It reports the version.
2. **DNS.** Resolves the endpoint host with the system resolver (`getent ahosts`) and reports the
   number of addresses and the time taken. Rclone resolves with its own resolver over the same
   `/etc/hosts` and `/etc/resolv.conf`.
3. **TLS.** Sends one unauthenticated HTTPS request to the endpoint origin with `curl`, first with
   the system trust store, then with `S3_PROBE_CA_FILE` when set. Certificate checks are never
   switched off. Any HTTP status counts: only the handshake and the certificate are judged.
4. **Auth.** Lists `<bucket>/<prefix>` with `rclone lsf --max-depth 1`, a read-only check of the key
   pair before anything is written. A prefix that does not exist yet counts as `PASS`: Rclone 1.75.1
   lists an empty or missing prefix with exit status 0, and status 3 (an HTTP 404 on the listing, in
   practice a missing bucket) is accepted too. Without this step a refusal sent while the body is still uploading can look like a
   connection reset.
5. **Write.** Uploads one random object of `S3_PROBE_SIZE_MIB` MiB (default 64) to
   `<bucket>/<prefix>/pluton-probe-<UTC time>-<random>` as a single PUT of known size
   (`rclone rcat --size`; at most 192 MiB, below Rclone's 200 MiB multipart cutoff), the way Restic hands a pack to Rclone. It reports MiB/s.
6. **Read.** Reads the object back in full (`rclone cat`) and reports MiB/s.
7. **Compare.** Compares the size and SHA-256 of both copies.
8. **Delete.** Deletes the object (`rclone deletefile`) and confirms it is no longer listed.

Rclone runs with the settings stage 1 uses for HCP: `provider = Other`, path-style addressing,
`use_accept_encoding_gzip = false` (see [HCP_RANGE_GZIP_FIX.md](HCP_RANGE_GZIP_FIX.md)),
`no_check_bucket = true` and `env_auth = false`. It is configured only through
`RCLONE_CONFIG_PROBE_*` environment variables with `RCLONE_CONFIG=/dev/null`, with one low-level
retry, a 30-second connect timeout, a 120-second I/O idle timeout and at most one hour per transfer.

The S3 checks (DNS, TLS, Rclone) run in an empty environment, like the Agent's own children: no proxy
variables and no inherited `RCLONE_*`, `SSL_*` or `CURL_*` settings. Only the optional Rclone download
uses the operator's environment and proxy. When `S3_PROBE_CA_FILE` is set, Rclone
gets it as `SSL_CERT_FILE`, which is how stage 1 passes `PLUTON_AGENT_STORAGE_CA_FILE`.

**On the host** the probe creates one temporary directory (`mktemp`, mode 0700, under `TMPDIR` or
`/tmp`) for the random payload, its read-back copy and, when downloaded, Rclone. The directory is
removed on every exit. It needs twice the object size plus 16 MiB free, and about 100 MiB more when
Rclone is downloaded. The keys stay in memory and in the environment of the Rclone child: never
printed, never written to a file and never passed as an argument, so other non-root users cannot
see them in `ps`.

**In the bucket** the probe writes only the one test object under the prefix, and never the bucket
root. It deletes the object on success, after any failed check and after Ctrl-C, `TERM` or `HUP`
(for a lone `TERM` or `HUP` the cleanup starts after the running Rclone call returns). If the
deletion fails, it prints the object key so you can remove it. The key pair therefore needs
permission to list the prefix: both the `auth` check and the cleanup list it.

The probe prints nothing during the write and the read: for 64 MiB at 0.5 MiB/s each takes about two
minutes. After Ctrl-C the cleanup can take up to about two minutes (each cleanup call is limited to 60
seconds); its Rclone calls run outside the terminal's process group, so a second Ctrl-C does not
abort the deletion.

`SIGKILL` cannot be caught, so no cleanup runs after it. After a `SIGKILL` (for example `kill -9` or
the out-of-memory killer), list the prefix and delete any leftover `pluton-probe-` object by hand.

## Running it (operator)

Requirements: Ubuntu 22.04 or 24.04 on amd64 with `bash`, `curl` and `ca-certificates` (present on
Ubuntu Server). `unzip` is needed only when Rclone has to be downloaded
(`sudo apt-get install unzip`; the Agent installer needs it anyway), and outbound HTTPS to
`downloads.rclone.org` only for that download. Run as a normal user; no `sudo`.

1. Copy the script from the reviewed commit and check that the copy is intact. On a workstation with
   a checkout of the repository:

   ```sh
   git show <reviewed-commit>:scripts/diagnostics/agent-s3-probe.sh > agent-s3-probe.sh
   sha256sum agent-s3-probe.sh
   scp agent-s3-probe.sh <user>@<agent-host>:
   ```

   On the Agent host, `sha256sum ~/agent-s3-probe.sh` must print the same digest.

2. Enter the values and run the probe inside a `( ... )` subshell, so that later commands in your
   shell do not inherit the keys. `read` is a shell builtin, so what you type is not stored in the
   shell history; `-s` hides the keys while you type:

   ```sh
   (
     read -r -p 'S3 endpoint (https://...): ' S3_PROBE_ENDPOINT
     read -r -p 'Bucket (HCP namespace): ' S3_PROBE_BUCKET
     read -rs -p 'Access key ID: ' S3_PROBE_ACCESS_KEY_ID; echo
     read -rs -p 'Secret access key: ' S3_PROBE_SECRET_ACCESS_KEY; echo
     export S3_PROBE_ENDPOINT S3_PROBE_BUCKET S3_PROBE_ACCESS_KEY_ID S3_PROBE_SECRET_ACCESS_KEY
     bash ~/agent-s3-probe.sh
   )
   ```

   Use the same endpoint origin (the tenant host, path-style) and the same bucket (HCP namespace) and
   key pair as the existing Pluton S3 storage that stage 1 will use. Optional, before `bash`:
   `export S3_PROBE_PREFIX=probe` (the default; an empty prefix is refused),
   `export S3_PROBE_CA_FILE=/path/to/ca.pem` and `export S3_PROBE_SIZE_MIB=64` (1 to 192).

   Choose a prefix outside every Pluton export or replica prefix: HCP can leave an empty `probe/`
   directory marker behind, and the export preflight blocks nested markers. On a namespace with
   versioning or retention the delete leaves a noncurrent version or fails.

3. If `/tmp` is mounted `noexec` and Rclone has to be downloaded, give the probe a temporary
   directory on an executable filesystem: `mkdir -m 700 ~/probe-tmp`, run the subshell above with
   `export TMPDIR=~/probe-tmp` before `bash`, then `rmdir ~/probe-tmp`.

4. The values were set only inside the subshell, so there is nothing to unset. If you exported them
   in your own shell instead, remove them:
   `unset S3_PROBE_ENDPOINT S3_PROBE_BUCKET S3_PROBE_ACCESS_KEY_ID S3_PROBE_SECRET_ACCESS_KEY S3_PROBE_CA_FILE`.

5. Share the output. It contains no key, endpoint or bucket; only the prefix appears, in an
   `object_key` fact when a deletion failed.

Exit status: `0` every check passed, `1` a check failed, `2` the input was refused before anything
was contacted, `130`, `143` or `129` interrupted by `INT`, `TERM` or `HUP`.

## Reading the result

Example (synthetic):

```text
pluton-agent-s3-probe/1 started=2026-11-15T09:30:00Z size_mib=64
PASS rclone version=v1.75.1 source=download pinned=yes
PASS dns addresses=2 ipv4=2 ipv6=0 elapsed_ms=12
PASS tls system_trust=no ca_file=yes
PASS auth
PASS write bytes=67108864 elapsed_ms=5120 mib_per_s=12.50
PASS read bytes=67108864 elapsed_ms=2010 mib_per_s=31.84
PASS compare sha256=match
PASS delete object=removed
RESULT PASS storage_ca_file_needed=yes
```

Each check prints one line: `PASS`, `FAIL` with a `reason`, or `SKIP`. `SKIP` means the check was
not run: `earlier-failure` (a check it depends on failed), `auth-failed` (for `write` only: the
`auth` check failed, so nothing was written) or, for `delete`, `not-created` (nothing was written,
so there is nothing to delete). After a failed `auth` the output is `FAIL auth`, `SKIP write` with
`auth-failed`, `SKIP read` and `SKIP compare` with `earlier-failure`, and `SKIP delete` with
`not-created`.

| Check | `PASS` facts | `FAIL` reasons and what to do |
| --- | --- | --- |
| `rclone` | `version`; `source` is `argument`, `agent` or `download`; `pinned=yes` when it is the installer's 1.75.1 | `download-failed`: no HTTPS to `downloads.rclone.org`; copy the binary and use `--rclone`. `checksum-mismatch`: the download is not the pinned release; stop and do not use it. `unzip-missing`: install `unzip`. `unsupported-architecture`: the Agent supports amd64 only. `extract-failed`: the archive did not contain Rclone. `not-executable`: the temporary directory is `noexec` (see step 3) or the binary is for another architecture. `no-version`: the binary did not report a version. `version-mismatch`: the download reported another version |
| `dns` | `addresses`, `ipv4`, `ipv6`, `elapsed_ms` | `not-found` or `timeout`: the host's resolver cannot resolve the endpoint. A public resolver may not know an internal HCP name; use the site resolver. Fix this first |
| `tls` | `system_trust` (`yes` or `no`) and `ca_file` (`not-set`, `yes` or `no`) | `certificate-not-trusted`: the issuer is unknown; rerun with `S3_PROBE_CA_FILE`. `hostname-mismatch`: the certificate does not name the endpoint host; a CA file does not help. `certificate-expired`, `certificate-not-yet-valid`, `certificate-rejected`: the certificate itself is wrong. `ca-file-unreadable`: curl could not load `S3_PROBE_CA_FILE`. `handshake`, `connection`, `timeout`, `dns`, `other`: the HTTPS connection failed before the certificate was judged |
| `auth` | none (the line is just `PASS auth`) | The same reasons as `write` (`authentication`, `access-denied`, `tls`, `dns`, `connection`, `timeout`, `server-error`, `other`). `access-denied` here may also mean the key cannot list the prefix, which the probe needs. A bucket that does not exist still shows `PASS auth` and fails at `write` with `bucket-not-found` |
| `write` | `bytes`, `elapsed_ms`, `mib_per_s` | `authentication`: wrong key pair. `access-denied`: the key may not write under this prefix. A `connection` reason right after `PASS auth` can also be a write-permission refusal (the 403-and-reset race the `auth` check works around). `bucket-not-found`: wrong bucket. `tls`: Rclone rejected a certificate that curl accepted (for example one without a subjectAltName); the Agent would fail the same way. `dns`, `connection`, `timeout`, `server-error`, `other`: transport or endpoint failure; rerun once, then escalate with the UTC time. `insufficient-temp-space`, `payload-failed`: the temporary directory is too small or not writable |
| `read` | `bytes`, `elapsed_ms`, `mib_per_s` | Same reasons as `write` |
| `compare` | `sha256=match` | `size-mismatch` or `sha256-mismatch`: the endpoint returned different bytes. Stop and escalate; stage 1 must not start |
| `delete` | `object=removed`, or `object=absent` when it was already gone | Any reason above, `listing-failed` (the check listing failed) or `still-listed`, with `object_key`: delete that one object by hand. A key without delete permission cannot be used, because Restic deletes its lock files |
| `cleanup` | `object=removed` or `object=absent` | Printed only after an interruption; reasons and action as for `delete` |
| `RESULT` | `PASS` only when every check passed; `storage_ca_file_needed`; `interrupted=yes` after `INT`, `TERM` or `HUP` | |

## Is `PLUTON_AGENT_STORAGE_CA_FILE` needed?

The `tls` line decides it, and `RESULT` repeats the answer as `storage_ca_file_needed`:

| `storage_ca_file_needed` | Meaning | Action for stage 1 |
| --- | --- | --- |
| `no` | `system_trust=yes`: the host's trust store verifies the endpoint | Leave `PLUTON_AGENT_STORAGE_CA_FILE` unset |
| `yes` | `system_trust=no` with `certificate-not-trusted`, and either no CA file was given or it verified (`ca_file=yes`) | Install the CA file that gave `ca_file=yes` on the Agent host (root-owned, mode 0644) and set `PLUTON_AGENT_STORAGE_CA_FILE` to its path in the Agent environment file. If you have not yet run with `S3_PROBE_CA_FILE`, do so first to prove the file |
| `unknown` | TLS failed for a reason a CA file does not fix, the given CA file did not verify either, or DNS failed first | Fix the certificate, the name or the network, then rerun |

## From upload rate to first-backup time

hours ≈ GB × 1,000,000,000 ÷ (`mib_per_s` × 1,048,576) ÷ 3,600. For 300 GB: about 6.4 hours at
12.5 MiB/s, about 5.5 days at 0.6 MiB/s.

Treat this as an estimate. The probe measures one stream; Restic uploads up to five packs at once
through Rclone, which helps when one stream is limited by latency but not when the link is full.
Restic also compresses and deduplicates, which helps little for files that are already compressed
(images, PDF, archives), and the first backup also reads the whole source disk.

## Validation

`scripts/validate-agent-s3-probe.py` (Windows: `py -3 scripts/validate-agent-s3-probe.py`; Linux and
CI: `python3 ...`) builds `pluton-agent-s3-probe-lab:ubuntu-22.04` from
`scripts/diagnostics/test/agent-s3-probe/`: Ubuntu with `curl`, `ca-certificates`, `unzip` and
`openssl`, plus Rclone 1.75.1 checked against the Agent installer's SHA-256. It creates an internal
Docker network, a throwaway private CA and an HTTPS `rclone serve s3` fixture at
`s3.example.internal:9443` with the synthetic key pair `SYNTHETICKEY01`. The probe runs as UID 1000
on a read-only root filesystem, in most scenarios with `--rclone` pointing at the fixture's Rclone.

Scenarios (19): nine refused inputs (empty prefix, `/` prefix, `..` segment, `http://` endpoint,
endpoint with a path, size 2048, size 193, `--rclone` with a bare name, missing secret), TLS without the CA file, a host name the
certificate does not name, an unknown host, success with the default 64 MiB, a wrong secret key,
a failed read after a successful write, Ctrl-C during the read (the test double sends `SIGINT` to
the probe's process group), a second Ctrl-C during the cleanup delete (a second test double signals the
probe's process group; the object must still be removed), the Agent's private Rclone found at `/opt/pluton-agent/bin/rclone`, and
the pinned download failing closed without Internet access. `--with-download` replaces the last one
with a real download and checksum check of the pinned release.

Every scenario also checks that each output line is a closed fact; that no key, endpoint host name,
bucket or provider error text appears in stdout or stderr; that, in the scenarios that use the recording test doubles, Rclone never received a key as an
argument; that the probe's temporary directory is gone; and that the bucket holds no object
afterwards. Expected last line: `PASS agent-s3-probe lab: 19/19 scenarios`.
`--base-image ubuntu:24.04` runs the same scenarios on Ubuntu 24.04. `--static-only` runs only the
checks that need no Docker (line endings, no disabled TLS verification in curl calls, the Rclone pin
matching the lab image, and every `reason` documented here). The lab is run manually; CI does not run
it.

## Limitations

- One object, one stream, one run: no concurrency, no multipart upload (`S3_PROBE_SIZE_MIB` is capped
  at 192, below Rclone's 200 MiB upload cutoff, so an interrupted run cannot leave an invisible
  multipart upload) and no long-run stability.
- Range reads are not exercised. Restic reads packs with Range requests, and the earlier HCP gzip
  defect affected Range responses only; the probe reads the whole object with one plain GET.
- The probe sets no region; Rclone then signs requests for `us-east-1`.
- The TLS check uses curl (OpenSSL) and Rclone uses Go. A difference shows as `write` with
  `reason=tls`.
- No proxy is used for the S3 checks. If the host can reach the endpoint only through a proxy, the
  probe fails, as the Agent would, because the Agent does not pass proxy variables to Restic and
  Rclone.
- The lab does not reproduce HCP, its certificate chain or production network behavior.

## Rollback

Nothing is deployed. Delete `agent-s3-probe.sh` from the Agent host. If the probe printed
`FAIL delete` or `FAIL cleanup` with an `object_key`, delete that one object in the HCP namespace.

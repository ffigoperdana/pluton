# Application-encrypted Reliable Download

This optional mode encrypts the verified TAR inside Pluton before multipart
upload. The authenticated Pluton download returns the original TAR. It changes
neither SFTP backup plans nor S3 backup replication, Restore, Agent, legacy
repositories, or Standard Download. No namespace, database, external KMS, Agent
upgrade, or change to existing production secrets is required.

The default remains `MANAGED_EXPORT_ENABLED=false` and `MANAGED_EXPORT_MODE=auto`.
Auto preserves existing versioned and HCP write-once contracts, including SSE-S3
evidence. Only an explicit `application-encrypted-hcp` selection substitutes
application confidentiality for SSE-S3 evidence. This is not an automatic fallback
when an existing preflight fails. HTTPS, private access, credentials, destination
isolation, write-once/collision races, multipart publication, conditional Range,
ownership, enumeration, checksum readback and verified cleanup remain mandatory.

See [validation and rollout status](APPLICATION_ENCRYPTED_HCP_VALIDATION.md).
For an existing installation with an HCP root directory marker, follow the
[strict marker policy and controlled UAT](HCP_DIRECTORY_MARKER_UAT.md).
Local reference-provider tests are not production HCP certification. Independent
security/format review and an operator-run destination preflight remain rollout
gates. No production endpoint or credentials were accessed during implementation.

## Encryption format v1 and trust boundary

The implementation uses Node/OpenSSL AES-256-GCM, HKDF-SHA256 and HMAC-SHA256;
it implements framing and key management, not a cryptographic primitive. Node
requires authentication finalization before trusting decrypted data; Pluton
buffers each frame until `decipher.final()` succeeds. GCM uses explicit 128-bit
tags and 96-bit nonces. See [Node crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html)
and [NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final).

Each export gets a fresh 32-byte random root key, 32-byte random HKDF salt and
8-byte random nonce prefix. Each frame uses its own 32-byte key derived with
HKDF-SHA256, salt from the manifest, and UTF-8 info
`pluton-export-frame-v1:<decimal-index>`. The 12-byte nonce is the prefix followed
by the big-endian uint32 chunk index. There is no reused root/nonce schedule on
retry: interrupted jobs fail/reconcile; a new export gets a new job/key.

Plaintext chunks are 4 MiB except the final shorter chunk. The object is the
concatenation of `ciphertext || 16-byte-tag` frames, with no plaintext TAR header
or plaintext manifest in S3. No padding or per-frame file metadata is required.
The maximum plaintext size remains 128 GiB (32,768 frames), supporting the
requested 20–80 GB range without enlarging the part buffer or metadata journal.

The immutable private manifest contains:

| Field                            | Contract                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| version / algorithm              | `1` / `AES-256-GCM-HKDF-SHA256`                                                                                                             |
| chunkBytes                       | 4,194,304                                                                                                                                   |
| plaintextBytes / ciphertextBytes | Verified TAR size / plaintext size plus 16 bytes per frame                                                                                  |
| plaintextSha256                  | SHA-256 from the independently verified TAR preparation                                                                                     |
| noncePrefix / salt               | Lowercase hex, 8 / 32 bytes                                                                                                                 |
| context                          | SHA-256 of a versioned binding to job ID, session owner, destination fingerprint, exact object key and backup/snapshot/content-mode binding |

Canonical manifest encoding is a compact JSON array in the table's field order:
`[version,algorithm,chunkBytes,plaintextBytes,ciphertextBytes,plaintextSha256,noncePrefix,salt,context]`.
Strings are ASCII/UTF-8; numbers are exact positive JSON integers. Unknown fields,
versions, algorithms, lengths, context or summary mismatches are refused.

Frame AAD is compact JSON
`["pluton-export-frame-v1",sha256(canonical-manifest),index,actual-plaintext-frame-length]`.
This binds order, format, job/snapshot, final length and the expected full TAR
hash. Reorder, omission, truncation and cross-export substitution fail closed.

The root key is wrapped with AES-256-GCM under a dedicated keyring slot using
a fresh random 12-byte IV. Wrap AAD is UTF-8 `pluton-wrap-v1:` followed by the
canonical manifest. The private envelope stores only slot ID, IV, encrypted
32-byte root and tag as hex. Manifest authentication uses a separate HKDF key
with info `pluton-export-manifest-v1` and HMAC-SHA256 over compact JSON
`[canonical-manifest-string,[keyId,iv,wrappedRoot,wrapTag]]`. Manifest MAC comparison
uses a timing-safe comparison. The transport ciphertext SHA-256 is separately
recorded before completion and bound to the durable storage ownership proof;
it does not replace manifest authentication or decrypted full-TAR verification.

The envelope, manifest and MAC live only in the private durable export journal.
S3 receives job/binding/nonce markers, a format marker, purpose marker and the
manifest MAC, not plaintext keys or the original TAR hash. URLs, public job
responses and logs contain no keyring contents, wrapped root, envelope or private
manifest. The application still holds plaintext while reading/decrypting data;
this protects storage confidentiality, not a compromised application/host or
administrator-controlled process memory. Owned key/plaintext buffers are wiped
on completion/error where JavaScript permits; no claim of guaranteed VM-memory
erasure is made.

## Streaming, verification and resume

One 16 MiB multipart buffer and bounded 4 MiB encryption/decryption frames are
used with byte-stream backpressure. Neither plaintext nor ciphertext TAR is
spooled to the application filesystem. Progress and browser sizes remain in
original TAR bytes. Reservation accounts for ciphertext/tag overhead; plaintext
size and existing global quota ceilings remain enforced.

Before Ready, Pluton verifies successful publication identity, complete encrypted
readback, every frame tag, full plaintext byte count and the original SHA-256.
Partially uploaded or unverifiable archives never become Ready. A restart keeps
completed journal identity; interrupted work is failed and ownership-cleaned,
never resumed by reusing encryption nonces or guessing a lost completion result.

Only the authenticated proxy serves encrypted exports. There is no ciphertext
presigned download URL. For plaintext offset `p`, frame index is
`floor(p / 4194304)`. Ciphertext offsets use frame stride `4194304 + 16`.
One conditional provider GET fetches all complete frames covering the selected
plaintext range; each whole frame authenticates before any requested slice is
released. The browser receives plaintext Content-Length/Content-Range and
`"sha256-<original TAR SHA-256>"` ETag. A matching If-Range yields 206; a stale
If-Range returns the complete 200 response, as in the versioned download path.
Legacy unencrypted HCP If-Range behavior remains unchanged.

Range verification covers selected frames, not a new whole-file hash of skipped
data. Ready records the prior full verification. After assembling a resumed
download the operator/client must check final TAR size, SHA-256 and extraction.
A bad later frame terminates the response; previously authenticated prefix bytes
cannot be withdrawn and must not be mistaken for a completed archive.

## Persistent keyring and exact deployment inputs

| Variable                           | Default / use                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `MANAGED_EXPORT_MODE`              | `auto`; select `application-encrypted-hcp` explicitly                                                    |
| `MANAGED_EXPORT_KEYRING_FILE`      | Empty by default; application path to the protected keyring                                              |
| `MANAGED_EXPORT_KEYRING_HOST_FILE` | Operator-only absolute host path, used by optional overlay; never forwarded into application environment |

Existing eleven export settings remain unchanged. Production Compose forwards
all thirteen application fields and compares effective inputs with running
container values privately, without printing secrets. Use
`compose.managed-export-keys.yml` to mount exactly one existing file read-only at
`/run/secrets/pluton-managed-export-keyring.json`, with `create_host_path:false`.
The existing data volume, read-only root filesystem, capability drop, no-new-
privileges and optional public CA mount are preserved.

Keyring schema: version 1, an active slot ID and a map of 1–16 slot IDs to
canonical base64 32-byte keys. Slot IDs are bounded `[A-Za-z0-9_-]` strings.
The loader rejects relative paths, symlinks, nonregular/oversized files,
malformed keys, insecure POSIX modes and untrusted ownership. The application
does not generate or silently replace a missing production keyring.

The Linux operator provisions the file locally using the reviewed bundle:

```sh
sudo install -d -m 0700 /etc/pluton/secrets
sudo python3 /opt/pluton/managed-export-keys.py create /etc/pluton/secrets/managed-export-keyring-v1.json
sudo chown 10001:10001 /etc/pluton/secrets/managed-export-keyring-v1.json
sudo chmod 0400 /etc/pluton/secrets/managed-export-keyring-v1.json
```

The command refuses an existing output and prints no key values. Never put JSON
key material in `.env`, Git, command arguments, CI artifacts, screenshots or logs.
This secret is independent of the existing `ENCRYPTION_KEY`, backup credentials,
S3 credentials and private CA. Do not change any of those existing secrets.

Back up the full keyring through an independently protected/encrypted operator
secret-backup process. Preserve a consistent backup of `/data/temporary-exports/`
including `jobs.sqlite`, plus the ordinary installation configuration and its
existing protected secrets. Keyring alone or ciphertext alone is insufficient:
the authenticated private manifests/envelopes and original ownership journal are
required. Keep keys outside the ordinary exported data source and outside the
public host bundle. Test restore with disposable data before production use.

## Controlled activation and historical cleanup

1. Publish the local branch and verify hosted Backend Test and Container Image CI.
   Review this format, key management and the security tests independently.
2. Upgrade only the explicitly approved host bundle if necessary. The bundle
   includes the key overlay and `managed-export-keys.py`; it never includes keys.
   The exact prior public Compose digest is recognized; unknown customized
   templates still require explicit reviewed reconciliation. Record rollback
   image/configuration and retain the existing export journal.
3. Resolve the historical cleanup-pending probe through the
   [read-only diagnostic/reconciliation procedure](HCP_PREFLIGHT_CLEANUP_DIAGNOSTICS.md).
   Do not adopt/delete it from its key, HEAD, timestamp, marker or ETag. Do not
   change its old integrity mode, seed ownership proof, clear the journal or
   delete a prefix. Application encryption does not establish ownership of this
   old plaintext probe. Independent HCP administrator attribution and separately
   authorized recovery may be necessary; otherwise retain NO-GO.
4. Provision and independently back up the keyring. In the VM-only configuration,
   retain the existing HTTPS endpoint, bucket, credentials, CA and reserved prefix.
   Set the host keyring path, append only `compose.managed-export-keys.yml` after
   existing approved overlays, and review the private effective Compose JSON.
5. Use `python3 managed-export-keys.py approve /opt/pluton <private-effective-config>`
   to review without writing. This allows only the one new read-only file mount;
   all old project/data/CA mounts and image must be unchanged. After the operator's
   explicit pinned-image reapply and health check, the optional fourth argument
   `<private-container-inspect>` records the approved mount contract. Keep inputs
   private; do not print expanded Compose or inspect environment. Approval never
   deploys or restarts a container itself.
   For an existing installation, first install the reviewed format-v1-capable
   image with the existing mounts. Temporarily pause new export admission during
   the mount-only operation; preserve the journal and retained keys. Keep the
   image digest unchanged until the new mount contract has been recorded. The
   ordinary deployment tool intentionally refuses an unapproved mount, so this
   is the explicit narrow operator procedure (same central Compose invocation):

   ```sh
   umask 077
   work=$(mktemp -d /opt/pluton/.export-key-review.XXXXXX)
   python3 /opt/pluton/compose-tools.py snapshot /opt/pluton "$work"
   python3 /opt/pluton/compose-tools.py compose /opt/pluton "$work" config --format json > "$work/effective.json" 2> "$work/compose-errors"
   python3 /opt/pluton/managed-export-keys.py approve /opt/pluton "$work/effective.json"
   ```

   Require `export-keys-change-reviewed-no-write`. After the operator approves
   that concrete mount-only change, recreate only the application from the same
   private snapshot, using `compose-tools.py compose /opt/pluton "$work" up -d
--no-deps --force-recreate pluton`. Verify health, capture its one container
   inspection into a private file, and pass that file as the final argument to
   `managed-export-keys.py approve` to persist the contract. Require
   `export-keys-contract-approved-existing-mounts-preserved` before resuming the
   normal deploy/reapply workflow. Never edit/delete the original contract to
   bypass the gate. Retain the `.before-export-keys` records and reviewed old
   Compose/configuration for reversal; remove private review files after the
   transaction using the installation's approved cleanup procedure.

6. Set `MANAGED_EXPORT_MODE=application-encrypted-hcp`,
   `MANAGED_EXPORT_ENABLED=true` and the existing shared-prefix flag. Deploy the
   reviewed pinned application image through the normal approved process. The
   host verification must confirm all thirteen export fields and the exact
   read-only keyring mount. Do not relax namespace overwrite, TLS or permissions.
7. Run read-only inventory. Unknown historical objects/uploads must still refuse
   isolation. Run the new mode's disposable preflight only after inventory is
   safe. Require genuine `GO`, `application-encryption`,
   `authenticated-readback`, all existing write-once provider checks, successful
   cleanup and `cleanupPending:false`. SSE-S3 is not a required check in this
   mode. No real backup contents are read before these gates.
8. Use a selected 120 MB UAT snapshot. Test Full and Regular Files Only; verify
   original TAR size/SHA-256, structure and extracted file/link contents. Interrupt
   and resume at several non-chunk-aligned offsets using an authenticated session,
   renew the link, then verify the final whole TAR again.
9. Monitor CPU/RSS, private index disk, process count, network throughput and
   cleanup on the 2-vCPU/4-GiB VM. Scale gradually; no 20–80 GB production claim
   follows from smaller local/native fixtures. Confirm backups and replicas
   independently remain healthy and unchanged.

## Rotation, recovery and rollback

`managed-export-keys.py rotate <old-file> <new-file>` creates a new active random
slot in a new private file while retaining every old slot. It never overwrites
the old file. Set reviewed ownership/mode on the new file, back up both versions,
and redeploy the read-only mount deliberately. Atomic host rename does not update
an existing file bind mount; remount/redeploy is required. Retained old slots
decrypt live exports across restart and rotation. New capability binding requires
a fresh operator preflight for new exports; no old live export is silently
re-encrypted. Rotate well before 2^24 root-key wraps under one slot. Retirement is
an explicit review, not automatic: the helper refuses a seventeenth slot. Never
remove a slot required by a live/uncleaned job or its recovery backups.

Lost/malformed keyring, missing slot, invalid envelope/MAC or frame tag fails
closed. Restore the original protected keyring and matching journal; do not
generate replacement material under an old slot ID. Cryptographic verification
does not authorize adopting an object with a lost creation/complete response.
Cleanup still requires the original complete durable storage ownership proof;
known uploads use only durably recorded exact upload IDs.

For rollback that preserves live downloads, keep an image supporting format v1,
the same destination, metadata volume and full keyring. Selecting `auto` blocks
new encrypted admission until a matching fresh preflight, while existing ready
encrypted jobs remain proxy-readable by their recorded mode and retained keys.
Do not set `MANAGED_EXPORT_ENABLED=false` while live downloads must stay available.
For application-code rollback, use a reviewed previous **format-v1-capable** image.
An image predating this format cannot serve these exports: drain/expire/cancel
and verify cleanup before such a downgrade, or restore the compatible image.
This compatibility limit cannot be removed by a setting. Never delete job metadata
or key slots to make rollback appear successful.

If HCP cannot establish collision protection, exact identity, conditional reads,
privacy, enumeration or cleanup, retain NO-GO and involve its administrator.
Application confidentiality does not repair missing provider integrity/ownership
guarantees, retention restrictions, or unknown historical probe ownership.

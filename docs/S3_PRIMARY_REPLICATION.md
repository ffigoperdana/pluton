# Stage 2: replicate an S3 primary to SFTP

Status: implemented on branch `claude/s3-primary-replication`. Stage 2 of
[S3_AGENT_REPOSITORY_DESIGN.md](S3_AGENT_REPOSITORY_DESIGN.md) section 3.

## 1. Goal

Stage 1 lets a Managed Agent plan use S3 (HCP) as its primary repository, but such a plan has no
second copy: `Enable Replication` is refused. Stage 2 adds the mirror image of the existing
SFTP primary to S3 replica flow:

| Primary | Replica destinations | Status |
| --- | --- | --- |
| SFTP | 0 to 2 S3 repositories | unchanged |
| S3 | 0 to 2 SFTP repositories | **new** |

Restoring from a verified replica (Assisted Failover, Automatic Failover, manual replica
recovery) works in both directions. Continuing backups to another repository while the primary is
down is stage 3 and is out of scope.

## 2. Decisions

| Topic | Decision | Reason |
| --- | --- | --- |
| Where the copy runs | On the Pluton server, like the existing replication | No Agent change, no Agent upgrade, no replica credentials on the Agent host |
| Replica type | Opposite of the primary type only (S3 to SFTP, SFTP to S3) | A replica on the same storage type adds little independence; same-type copies stay out of scope |
| Restic operation | Unchanged: `init --from-repo --copy-chunker-params`, then `copy` of one full snapshot ID, then snapshot, tree, tag and SQL artifact verification | The verified workflow is backend-agnostic; only the rclone remotes change |
| Replica identity | SFTP: `sftp://<user>@<host>:<port>` plus the normalized repository path | Same ownership, overlap and fingerprint rules as S3 identities |
| Empty-target proof | `rclone lsf` must list nothing; for SFTP, exit code 3 (directory not found) also counts as empty | An absent SFTP directory is empty; any listed object still refuses initialization |

## 3. Server changes

- `utils/managedReplicaIdentity.ts`: `replicaRepositoryIdentity` and `replicaRepositoryScope`
  dispatch on storage type. SFTP identities read host, port and user from the storage settings
  and decrypted credentials. Relative and absolute SFTP paths are different prefixes (the home
  directory of the account is unknown to the server), so the empty-target proof remains the
  final guard.
- `ManagedReplicationService.validatePlan`: the required replica type follows the primary type.
  Destination options are validated with the existing allowlists (`destinationOptions` for S3,
  `getSftpRecoveryOptions` for SFTP). Overlap is checked against other plans' primaries and
  replicas of the same type.
- `ManagedReplicationService.source`: the source access comes from
  `getRepositoryAccessOptions`, so an S3 primary is read with its storage credentials (the same
  read path as Browse and Restore of an S3 primary).
- `ManagedReplicationExecutor`: the source remote may be S3 (allowlisted options, HTTPS
  endpoint, path style, no gzip, explicit credentials) and the destination remote may be SFTP
  (`host`, `port`, `user`, obscured `pass`). Operator CA trust applies to the S3 side in either
  direction. No repair, unlock, forget, prune or purge command exists.
- `managedReplicationPolicy.ts` and `StorageStore`: the scope resolver also resolves SFTP
  storages, so a registered SFTP replica prefix cannot be reused by another plan and an SFTP
  storage bound to a replica cannot be redirected to another host, port or account.
- `VerifiedReplicaRecoveryService`: accepts an S3 primary with an SFTP replica. The replica is
  read with `ManagedSftpRepositorySession` and the same identity, receipt, snapshot and tree
  checks as an S3 replica.
- `RemoteBackupService`: no longer refuses replication settings on an S3 primary plan.

## 4. UI changes

- The replication destination picker offers SFTP storages for an S3 primary and S3 storages for
  an SFTP primary.
- Failover policy wording names "replica" instead of "S3 replica".

## 5. Tests

| Area | Coverage |
| --- | --- |
| Identity and ownership | `backend/__tests__/utils/managedReplicaIdentity.test.ts`: normalization, home-relative versus absolute namespaces, unsafe folders and accounts, plan and reservation overlap in the real SQLite write transactions, refusal to redirect a bound SFTP storage |
| Executor | `backend/__tests__/utils/ManagedReplicationExecutor.test.ts`: S3 source with trust and SFTP destination with an obscured password, absent SFTP folder (exit 3) versus listed objects, same-type and unsafe option refusals before any Restic command |
| Service | `backend/__tests__/services/S3PrimaryReplication.test.ts`: replica type follows the primary, overlap, S3 read path to SFTP copy and receipt, redirect after admission |
| Replica recovery | `backend/__tests__/services/S3PrimaryReplicaRecovery.test.ts`: SFTP session and allowlist, refusals for wrong type, changed account and missing option provider |
| Real Restic | `backend/__tests__/integration/replicaRecovery.lab.ts` (Docker, network none): Restic-written HTTPS S3 primary copied to `rclone serve sftp`, occupied folder refused, idempotent repeat, staged restore from the SFTP replica with SHA-256 checks and no replica mutation |

## 6. Limits that remain

- Replica prune, purge and retention are not available (unchanged).
- The first copy of a large S3 primary reads it from S3 through the Pluton server and writes it
  to SFTP through the same server; its speed is bounded by the server links.
- Replication is serialized globally on the server (unchanged).
- Stage 3 (backup failover) and stage 4 (switching the primary) are not implemented.

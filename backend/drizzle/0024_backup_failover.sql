-- Stage 3 backup failover (docs/BACKUP_FAILOVER.md). Additive; no secret values.
-- One row per failover backup: written by the Agent into a verified replica while the primary
-- was unreachable, verified by the server, then copied back to the primary.
CREATE TABLE managed_backup_failovers (
 backup_id TEXT PRIMARY KEY NOT NULL,
 failed_backup_id TEXT NOT NULL UNIQUE,
 plan_id TEXT NOT NULL,
 repository_id TEXT NOT NULL,
 agent_id TEXT NOT NULL,
 replication_id TEXT NOT NULL,
 destination_storage_id TEXT NOT NULL,
 destination_storage_path TEXT NOT NULL,
 destination_fingerprint TEXT NOT NULL,
 primary_repository_config_id TEXT NOT NULL CHECK(length(primary_repository_config_id)=64),
 replica_repository_config_id TEXT NOT NULL CHECK(length(replica_repository_config_id)=64),
 status TEXT NOT NULL CHECK(status IN ('queued','backup-failed','verify-pending','verifying','verified','copying','copied-back','failed')),
 replica_snapshot_id TEXT CHECK(replica_snapshot_id IS NULL OR length(replica_snapshot_id)=64),
 primary_snapshot_id TEXT CHECK(primary_snapshot_id IS NULL OR length(primary_snapshot_id)=64),
 owner_token TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL DEFAULT 0,
 last_error_code TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 verified_at INTEGER,
 copied_back_at INTEGER
);
--> statement-breakpoint
CREATE INDEX managed_backup_failovers_due ON managed_backup_failovers(status,next_attempt_at,created_at);
--> statement-breakpoint
CREATE INDEX managed_backup_failovers_plan ON managed_backup_failovers(plan_id);
--> statement-breakpoint
-- An open failover still needs its plan, backup row, primary binding and replica to copy back.
CREATE TRIGGER managed_backup_failover_plan_delete BEFORE DELETE ON plans
WHEN EXISTS(SELECT 1 FROM managed_backup_failovers WHERE plan_id=OLD.id AND status NOT IN ('backup-failed','copied-back','failed'))
BEGIN SELECT RAISE(ABORT,'MANAGED_FAILOVER_BUSY'); END;
--> statement-breakpoint
CREATE TRIGGER managed_backup_failover_backup_delete BEFORE DELETE ON backups
WHEN EXISTS(SELECT 1 FROM managed_backup_failovers WHERE backup_id=OLD.id AND status NOT IN ('backup-failed','copied-back','failed'))
BEGIN SELECT RAISE(ABORT,'MANAGED_FAILOVER_BUSY'); END;
--> statement-breakpoint
CREATE TRIGGER managed_backup_failover_plan_binding BEFORE UPDATE OF storage_id,storage_path,source_id,source_type ON plans
WHEN EXISTS(SELECT 1 FROM managed_backup_failovers WHERE plan_id=OLD.id AND status NOT IN ('backup-failed','copied-back','failed'))
BEGIN SELECT RAISE(ABORT,'MANAGED_FAILOVER_BUSY'); END;
--> statement-breakpoint
CREATE TRIGGER managed_backup_failover_relocation BEFORE INSERT ON plan_repository_relocations
WHEN EXISTS(SELECT 1 FROM managed_backup_failovers WHERE plan_id=NEW.plan_id AND status NOT IN ('backup-failed','copied-back','failed'))
BEGIN SELECT RAISE(ABORT,'MANAGED_FAILOVER_BUSY'); END;

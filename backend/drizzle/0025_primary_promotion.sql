-- Stage 4 primary promotion (docs/PRIMARY_PROMOTION.md). Additive; no secret values.
-- One row per promotion of a verified replica to primary. The previous primary becomes the
-- replica in the same replication slot; nothing is deleted.
CREATE TABLE managed_primary_promotions (
 id TEXT PRIMARY KEY NOT NULL,
 plan_id TEXT NOT NULL,
 repository_id TEXT NOT NULL,
 replication_id TEXT NOT NULL,
 previous_storage_id TEXT NOT NULL,
 previous_storage_path TEXT NOT NULL,
 previous_repository_config_id TEXT NOT NULL CHECK(length(previous_repository_config_id)=64),
 promoted_storage_id TEXT NOT NULL,
 promoted_storage_path TEXT NOT NULL,
 promoted_fingerprint TEXT NOT NULL CHECK(length(promoted_fingerprint)=64),
 promoted_repository_config_id TEXT NOT NULL CHECK(length(promoted_repository_config_id)=64),
 status TEXT NOT NULL CHECK(status IN ('catching-up','switching','switched','failed','cancelled')),
 plan_was_active INTEGER,
 total_backups INTEGER NOT NULL DEFAULT 0,
 copied_backups INTEGER NOT NULL DEFAULT 0,
 retried TEXT NOT NULL DEFAULT '[]',
 left_behind TEXT NOT NULL DEFAULT '[]',
 last_error_code TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 switched_at INTEGER
);
--> statement-breakpoint
CREATE UNIQUE INDEX managed_primary_promotion_active ON managed_primary_promotions(plan_id) WHERE status IN ('catching-up','switching');
--> statement-breakpoint
CREATE INDEX managed_primary_promotion_plan ON managed_primary_promotions(plan_id,created_at);
--> statement-breakpoint
-- 1 when the replica holds the original snapshot and the primary holds the copy: after a
-- promotion swapped the roles, or after a failover copy-back (docs/BACKUP_FAILOVER.md).
ALTER TABLE managed_replication_jobs ADD COLUMN destination_original INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE managed_replication_jobs SET destination_original=1 WHERE status='completed' AND (source_snapshot_id=destination_snapshot_id OR EXISTS(SELECT 1 FROM managed_backup_failovers f WHERE f.backup_id=managed_replication_jobs.backup_id AND f.replication_id=managed_replication_jobs.replication_id AND f.status='copied-back' AND f.replica_snapshot_id=managed_replication_jobs.destination_snapshot_id AND f.primary_snapshot_id=managed_replication_jobs.source_snapshot_id));
--> statement-breakpoint
-- A promotion needs its plan, its backups, both repository bindings and both storages until it
-- switches or ends. A relocation or a failover never runs at the same time.
CREATE TRIGGER managed_primary_promotion_plan_delete BEFORE DELETE ON plans
WHEN EXISTS(SELECT 1 FROM managed_primary_promotions WHERE plan_id=OLD.id AND status IN ('catching-up','switching'))
BEGIN SELECT RAISE(ABORT,'MANAGED_PROMOTION_ACTIVE'); END;
--> statement-breakpoint
CREATE TRIGGER managed_primary_promotion_backup_delete BEFORE DELETE ON backups
WHEN EXISTS(SELECT 1 FROM managed_primary_promotions WHERE plan_id=OLD.plan_id AND status IN ('catching-up','switching'))
BEGIN SELECT RAISE(ABORT,'MANAGED_PROMOTION_ACTIVE'); END;
--> statement-breakpoint
CREATE TRIGGER managed_primary_promotion_plan_binding BEFORE UPDATE OF storage_id,storage_path,source_id,source_type ON plans
WHEN EXISTS(SELECT 1 FROM managed_primary_promotions WHERE plan_id=OLD.id AND status IN ('catching-up','switching'))
BEGIN SELECT RAISE(ABORT,'MANAGED_PROMOTION_ACTIVE'); END;
--> statement-breakpoint
CREATE TRIGGER managed_primary_promotion_backup_guard BEFORE INSERT ON backups
WHEN EXISTS(SELECT 1 FROM managed_primary_promotions WHERE plan_id=NEW.plan_id AND status='switching')
BEGIN SELECT RAISE(ABORT,'MANAGED_PROMOTION_ACTIVE'); END;
--> statement-breakpoint
CREATE TRIGGER managed_primary_promotion_resume_guard BEFORE UPDATE OF active ON plans
WHEN NEW.active=1 AND EXISTS(SELECT 1 FROM managed_primary_promotions WHERE plan_id=OLD.id AND status='switching')
BEGIN SELECT RAISE(ABORT,'MANAGED_PROMOTION_ACTIVE'); END;
--> statement-breakpoint
CREATE TRIGGER managed_primary_promotion_storage_binding BEFORE UPDATE OF credentials,settings,type ON storages
WHEN EXISTS(SELECT 1 FROM managed_primary_promotions WHERE (previous_storage_id=OLD.id OR promoted_storage_id=OLD.id) AND status IN ('catching-up','switching'))
BEGIN SELECT RAISE(ABORT,'MANAGED_PROMOTION_ACTIVE'); END;
--> statement-breakpoint
CREATE TRIGGER managed_primary_promotion_storage_delete BEFORE DELETE ON storages
WHEN EXISTS(SELECT 1 FROM managed_primary_promotions WHERE (previous_storage_id=OLD.id OR promoted_storage_id=OLD.id) AND status IN ('catching-up','switching'))
BEGIN SELECT RAISE(ABORT,'MANAGED_PROMOTION_ACTIVE'); END;
--> statement-breakpoint
CREATE TRIGGER managed_primary_promotion_relocation BEFORE INSERT ON plan_repository_relocations
WHEN EXISTS(SELECT 1 FROM managed_primary_promotions WHERE plan_id=NEW.plan_id AND status IN ('catching-up','switching'))
BEGIN SELECT RAISE(ABORT,'MANAGED_PROMOTION_ACTIVE'); END;
--> statement-breakpoint
CREATE TRIGGER managed_primary_promotion_failover BEFORE INSERT ON managed_backup_failovers
WHEN EXISTS(SELECT 1 FROM managed_primary_promotions WHERE plan_id=NEW.plan_id AND status IN ('catching-up','switching'))
BEGIN SELECT RAISE(ABORT,'MANAGED_PROMOTION_ACTIVE'); END;
--> statement-breakpoint
CREATE TRIGGER managed_primary_promotion_exclusive BEFORE INSERT ON managed_primary_promotions
WHEN EXISTS(SELECT 1 FROM plan_repository_relocations WHERE plan_id=NEW.plan_id AND status IN ('copying','verifying','ready'))
 OR EXISTS(SELECT 1 FROM managed_backup_failovers WHERE plan_id=NEW.plan_id AND status NOT IN ('backup-failed','copied-back','failed'))
BEGIN SELECT RAISE(ABORT,'MANAGED_PROMOTION_BUSY'); END;

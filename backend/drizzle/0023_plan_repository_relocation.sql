-- Server-side relocation of one managed remote plan repository to another SFTP Storage.
-- Additive only: no secret values, no cascading deletion, history is never rewritten away.
CREATE TABLE plan_repository_relocations (
 id TEXT PRIMARY KEY NOT NULL,
 plan_id TEXT NOT NULL,
 repository_id TEXT NOT NULL,
 source_storage_id TEXT NOT NULL,
 source_storage_path TEXT NOT NULL,
 destination_storage_id TEXT NOT NULL,
 destination_storage_path TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('copying','verifying','ready','switched','reverted','failed','cancelled','source-deleted')),
 phase TEXT NOT NULL,
 plan_was_active INTEGER NOT NULL CHECK(plan_was_active IN (0,1)),
 failure_code TEXT,
 progress TEXT,
 evidence TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 verified_at INTEGER,
 switched_at INTEGER,
 reverted_at INTEGER,
 source_deleted_at INTEGER,
 audit TEXT NOT NULL DEFAULT '[]'
);
--> statement-breakpoint
-- Exact backup rows moved by a switch: revert and "new backup since switch" never rely on clocks.
CREATE TABLE plan_repository_relocation_backups (
 relocation_id TEXT NOT NULL,
 backup_id TEXT NOT NULL,
 PRIMARY KEY(relocation_id,backup_id)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE UNIQUE INDEX plan_relocation_active_plan ON plan_repository_relocations(plan_id) WHERE status IN ('copying','verifying','ready');
--> statement-breakpoint
-- One copy/verification workload globally: it reads and writes a whole repository.
CREATE UNIQUE INDEX plan_relocation_execution_slot ON plan_repository_relocations((1)) WHERE status IN ('copying','verifying');
--> statement-breakpoint
CREATE INDEX plan_relocation_plan ON plan_repository_relocations(plan_id,created_at);
--> statement-breakpoint
CREATE TRIGGER plan_relocation_backup_guard BEFORE INSERT ON backups
WHEN EXISTS(SELECT 1 FROM plan_repository_relocations WHERE plan_id=NEW.plan_id AND status IN ('copying','verifying','ready'))
BEGIN SELECT RAISE(ABORT,'PLAN_RELOCATION_ACTIVE'); END;
--> statement-breakpoint
CREATE TRIGGER plan_relocation_resume_guard BEFORE UPDATE OF active ON plans
WHEN NEW.active=1 AND EXISTS(SELECT 1 FROM plan_repository_relocations WHERE plan_id=OLD.id AND status IN ('copying','verifying','ready'))
BEGIN SELECT RAISE(ABORT,'PLAN_RELOCATION_ACTIVE'); END;
--> statement-breakpoint
CREATE TRIGGER plan_relocation_storage_binding BEFORE UPDATE OF credentials,settings,type ON storages
WHEN EXISTS(SELECT 1 FROM plan_repository_relocations WHERE (source_storage_id=OLD.id OR destination_storage_id=OLD.id) AND status IN ('copying','verifying','ready'))
BEGIN SELECT RAISE(ABORT,'PLAN_RELOCATION_ACTIVE'); END;
--> statement-breakpoint
CREATE TRIGGER plan_relocation_storage_delete BEFORE DELETE ON storages
WHEN EXISTS(SELECT 1 FROM plan_repository_relocations WHERE (source_storage_id=OLD.id OR destination_storage_id=OLD.id) AND status IN ('copying','verifying','ready'))
BEGIN SELECT RAISE(ABORT,'PLAN_RELOCATION_ACTIVE'); END;
--> statement-breakpoint
CREATE TRIGGER plan_relocation_plan_delete BEFORE DELETE ON plans
WHEN EXISTS(SELECT 1 FROM plan_repository_relocations WHERE plan_id=OLD.id AND status IN ('copying','verifying','ready'))
BEGIN SELECT RAISE(ABORT,'PLAN_RELOCATION_ACTIVE'); END;

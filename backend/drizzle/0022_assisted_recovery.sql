CREATE TABLE assisted_recovery_jobs (
 id TEXT PRIMARY KEY NOT NULL, owner TEXT NOT NULL, plan_id TEXT NOT NULL,
 backup_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 status TEXT NOT NULL, phase TEXT NOT NULL, payload TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 cleanup_pending INTEGER NOT NULL DEFAULT 0, failure_code TEXT, stats TEXT, audit TEXT NOT NULL DEFAULT '[]'
);
--> statement-breakpoint
CREATE UNIQUE INDEX assisted_recovery_idempotency ON assisted_recovery_jobs(owner,request_key);
--> statement-breakpoint
CREATE UNIQUE INDEX assisted_recovery_execution ON assisted_recovery_jobs((1)) WHERE status='running';
--> statement-breakpoint
CREATE INDEX assisted_recovery_owner ON assisted_recovery_jobs(owner,plan_id,backup_id,created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX assisted_recovery_plan_active ON assisted_recovery_jobs(plan_id) WHERE status IN ('checking','awaiting-approval','running') OR cleanup_pending=1;

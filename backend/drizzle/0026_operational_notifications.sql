-- Operational notifications (docs/OPERATIONAL_NOTIFICATIONS.md): a replica copy that failed or
-- needs review, and an Agent that stays offline. Additive; earlier failures are not replayed.
CREATE TABLE notification_agent_states (
 agent_id TEXT PRIMARY KEY NOT NULL,
 offline_since INTEGER,
 notified INTEGER NOT NULL DEFAULT 0,
 updated_at INTEGER NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO notification_sources(kind,job_id) SELECT 'replication',id FROM managed_replication_jobs;
--> statement-breakpoint
INSERT OR IGNORE INTO notification_observed SELECT s.id,j.status FROM notification_sources s JOIN managed_replication_jobs j ON s.kind='replication' AND s.job_id=j.id WHERE j.status IN ('failed','uncertain');
--> statement-breakpoint
CREATE TRIGGER notification_replication_created AFTER INSERT ON managed_replication_jobs BEGIN
 INSERT OR IGNORE INTO notification_sources(kind,job_id,ready) VALUES ('replication',NEW.id,CASE WHEN NEW.status IN ('failed','uncertain') THEN 1 ELSE 0 END);
END;
--> statement-breakpoint
CREATE TRIGGER notification_replication_terminal AFTER UPDATE OF status ON managed_replication_jobs
 WHEN NEW.status IN ('failed','uncertain') AND OLD.status IS NOT NEW.status BEGIN
 UPDATE notification_sources SET ready=1 WHERE kind='replication' AND job_id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER notification_replication_removed AFTER DELETE ON managed_replication_jobs BEGIN
 DELETE FROM notification_sources WHERE kind='replication' AND job_id=OLD.id;
END;

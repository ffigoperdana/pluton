-- Additive MCP policy and durable audit. No credentials are stored here.
CREATE TABLE mcp_policy (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0, disabled_tools TEXT NOT NULL DEFAULT '[]');
--> statement-breakpoint
INSERT INTO mcp_policy(id) VALUES(1);
--> statement-breakpoint
CREATE TABLE mcp_authorizations (
 id TEXT PRIMARY KEY NOT NULL, subject TEXT NOT NULL, oauth_client_id TEXT NOT NULL,
 configuration TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER,
 revoked_at INTEGER, last_used_at INTEGER,
 UNIQUE(subject,oauth_client_id)
);
--> statement-breakpoint
CREATE TABLE mcp_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL,
 principal TEXT NOT NULL, client_id TEXT, operation TEXT NOT NULL, target TEXT,
 outcome TEXT NOT NULL, duration_ms INTEGER, trace_id TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX mcp_audit_timestamp ON mcp_audit(timestamp DESC,id DESC);

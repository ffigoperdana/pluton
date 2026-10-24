CREATE TABLE mcp_tokens (
 id TEXT PRIMARY KEY NOT NULL, verifier TEXT NOT NULL, configuration TEXT NOT NULL,
 issuer TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 last_used_at INTEGER, revoked_at INTEGER, disabled INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 1
);
--> statement-breakpoint
CREATE TABLE mcp_actions (
 id TEXT PRIMARY KEY NOT NULL, token_id TEXT NOT NULL REFERENCES mcp_tokens(id),
 token_revision INTEGER NOT NULL, action TEXT NOT NULL, plan_id TEXT NOT NULL,
 arguments TEXT NOT NULL, arguments_hash TEXT NOT NULL, state_hash TEXT NOT NULL,
 idempotency_key TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending_approval','executing','dispatched','rejected','expired','failed','uncertain')),
 decided_by TEXT, decided_at INTEGER, completed_at INTEGER, outcome_code TEXT, result_id TEXT,
 execution_state TEXT, execution_completed_at INTEGER,
 preview TEXT NOT NULL,
 UNIQUE(token_id,idempotency_key)
);
--> statement-breakpoint
CREATE INDEX mcp_actions_history ON mcp_actions(created_at DESC,id DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX mcp_actions_plan_busy ON mcp_actions(plan_id) WHERE status IN ('pending_approval','executing','uncertain');
--> statement-breakpoint
CREATE TRIGGER mcp_action_payload_immutable BEFORE UPDATE OF token_id,token_revision,action,plan_id,arguments,arguments_hash,state_hash,idempotency_key,created_at,expires_at,preview ON mcp_actions
BEGIN SELECT RAISE(ABORT,'MCP action inputs are immutable'); END;

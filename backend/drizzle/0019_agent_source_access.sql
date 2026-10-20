CREATE TABLE agent_source_access_state (
 agent_id TEXT PRIMARY KEY NOT NULL REFERENCES agent_identities(agent_id),
 report TEXT NOT NULL,
 selected_roots TEXT NOT NULL,
 latest_report_timestamp INTEGER NOT NULL,
 received_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE agent_source_access_requests (
 id TEXT PRIMARY KEY NOT NULL,
 agent_id TEXT NOT NULL REFERENCES agent_identities(agent_id),
 command_id TEXT NOT NULL REFERENCES agent_commands(id),
 kind TEXT NOT NULL CHECK(kind IN ('validate','apply','mode-setup')),
 requested_mode TEXT CHECK(requested_mode IN ('host-approved','server-managed')),
 setup_expires_at INTEGER,
 status TEXT NOT NULL CHECK(status IN ('queued','validating','validated','pending-host-approval','pending-host-setup','applied','rejected','cancelled')),
 expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
 expected_host_policy_revision TEXT NOT NULL,
 roots TEXT NOT NULL,
 confirmed_affected_plan_ids TEXT NOT NULL,
 requested_by TEXT NOT NULL DEFAULT 'administrator-session' CHECK(requested_by='administrator-session'),
 validation TEXT,
 result_code TEXT,
 created_at INTEGER NOT NULL,
 completed_at INTEGER
);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_source_access_requests_command_idx ON agent_source_access_requests(command_id);
--> statement-breakpoint
CREATE INDEX agent_source_access_requests_agent_created_idx ON agent_source_access_requests(agent_id,created_at);

-- Cloud-only refactor: drop the local-execution data model.
--
-- Tasks are now delegated to cloud providers (PostHog Code), so the
-- daemon/agent/backlog machinery and the per-task working-tree columns are
-- gone. Per the agreed migration, tasks are wiped to a clean slate (no
-- backfill) and non-cloud environment markers are removed; the environments
-- table survives as a secret-free per-provider marker.

-- Fresh start: clear all tasks (sets pull_requests.task_id null via FK).
DELETE FROM "tasks";
--> statement-breakpoint

-- Drop the local-execution tables (children first for FK safety).
DROP TABLE IF EXISTS "backlog_items";
--> statement-breakpoint
DROP TABLE IF EXISTS "backlog_sources";
--> statement-breakpoint
DROP TABLE IF EXISTS "agents";
--> statement-breakpoint

-- Remove any legacy local/remote env rows — only cloud markers remain.
DELETE FROM "environments" WHERE "type" NOT IN ('posthog_code', 'codex_cloud', 'claude_routine');
--> statement-breakpoint

-- Slim the environments marker: drop every daemon-era column + index.
DROP INDEX IF EXISTS "idx_environments_device_token";
--> statement-breakpoint
ALTER TABLE "environments" DROP COLUMN IF EXISTS "device_token_hash";
--> statement-breakpoint
ALTER TABLE "environments" DROP COLUMN IF EXISTS "last_seen_at";
--> statement-breakpoint
ALTER TABLE "environments" DROP COLUMN IF EXISTS "autonomous_bypass_permissions";
--> statement-breakpoint
ALTER TABLE "environments" DROP COLUMN IF EXISTS "renderer";
--> statement-breakpoint
ALTER TABLE "environments" DROP COLUMN IF EXISTS "tool_allowlist";
--> statement-breakpoint
ALTER TABLE "environments" DROP COLUMN IF EXISTS "daemon_version";
--> statement-breakpoint
ALTER TABLE "environments" DROP COLUMN IF EXISTS "auto_update_daemon";
--> statement-breakpoint
ALTER TABLE "environments" ALTER COLUMN "status" SET DEFAULT 'connected';
--> statement-breakpoint

-- Drop the per-task local-execution columns.
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "assigned_agent_id";
--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "terminal_output";

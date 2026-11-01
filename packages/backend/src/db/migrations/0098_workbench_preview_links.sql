-- Hosted preview links: a session's port on its own host name under
-- PREVIEW_BASE_DOMAIN (`<id>-<port>.preview.talyn.dev`).
--
-- workbench_preview_hosts maps the random host id to (session, port). There is
-- one host per session and port, so the app keeps its cookies and storage.
-- workbench_preview_tickets holds one-time tickets. A ticket opens the host once
-- and expires after minutes. workbench_preview_sessions holds the host-only
-- cookie that a redeemed ticket sets. Tickets and cookies are stored as SHA-256
-- hashes only.
--
-- Backend-pool-only, like session_mcp_tokens (0093): RLS on with NO policy and
-- no talyn_backend grant. The preview host router runs before any auth, and the
-- user's own requests never read these rows.
--
-- All rows go with their session (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS "workbench_preview_hosts" (
	"id" text PRIMARY KEY NOT NULL,
	"workbench_id" text NOT NULL REFERENCES "workbenches"("id") ON DELETE CASCADE,
	"port" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workbench_preview_hosts_workbench_port" ON "workbench_preview_hosts" USING btree ("workbench_id", "port");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workbench_preview_tickets" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"host_id" text NOT NULL REFERENCES "workbench_preview_hosts"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workbench_preview_tickets_expires" ON "workbench_preview_tickets" USING btree ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workbench_preview_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"host_id" text NOT NULL REFERENCES "workbench_preview_hosts"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workbench_preview_sessions_expires" ON "workbench_preview_sessions" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE "workbench_preview_hosts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workbench_preview_tickets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workbench_preview_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "workbench_preview_hosts" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON "workbench_preview_tickets" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON "workbench_preview_sessions" FROM PUBLIC, anon, authenticated;

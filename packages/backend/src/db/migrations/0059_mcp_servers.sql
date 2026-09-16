-- Per-workspace MCP tool servers, and the per-loop override that selects them.
--
-- A workspace connects the tool servers it wants — Linear, Sentry, Supabase,
-- its own — and every Talyn Fleet run wakes up with their tools wired in. The
-- fleet takes them INLINE on sandbox create, which is why the credential lives
-- here rather than there: an inline server's secret is never persisted by the
-- fleet, so we are the only party that still holds it, and re-supplying it
-- after a fleetd restart is our job.
--
-- `secret_enc` is an AES-256-GCM envelope from services/tokenCrypto.ts, the
-- same shape every credential on `integrations.config` already uses. It is a
-- column of its own rather than a key inside a config blob because this table
-- has one row per server and the blob pattern exists to hold several unrelated
-- credentials in one row.
--
-- `tools` is an allow-list, and its THREE states are all meaningful:
--   NULL  every tool the server advertises          (the default)
--   []    no tools at all                           (a deliberate choice)
--   [...] exactly these
-- Reading `[]` as "all" would be the worst possible guess about somebody who
-- ticked nothing, so nothing downstream may collapse the two.
CREATE TABLE IF NOT EXISTS "mcp_servers" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  -- The first label of a hostname inside the sandbox, so it carries the fleet's
  -- integration-name charset: lowercase letters, digits and hyphens, <= 40.
  -- Validated in @talyn/shared, where the user hears about it at save time
  -- rather than as a failed dispatch an hour later.
  "name" text NOT NULL,
  -- What a human reads. Free text, and deliberately separate from `name`, which
  -- a DNS label's charset makes a poor display string.
  "display_name" text,
  "url" text NOT NULL,
  "description" text,
  -- The MCP_CATALOG entry this was created from, if any. Kept so the UI can
  -- show a vendor's notes and so a catalog URL change can be reconciled later.
  "catalog_handle" text,
  -- How the credential is attached, host-side: none | bearer | header | basic |
  -- query. Mirrors the fleet's own Injection vocabulary rather than inventing a
  -- second one, because it is passed straight through on dispatch.
  "auth_kind" text DEFAULT 'none' NOT NULL,
  "inject" jsonb,
  "secret_enc" jsonb,
  -- The OAuth grant, for a server connected by signing in rather than by
  -- pasting a key. Absent for a pasted one, which is what makes this the field
  -- to check before offering to reconnect anything.
  "oauth" jsonb,
  "tools" jsonb,
  "enabled" boolean DEFAULT true NOT NULL,
  -- The last initialize/tools-list probe: what the server called itself, when,
  -- and the refusal in its own words. Never a credential.
  "last_probe" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mcp_servers_workspace_id_fk" FOREIGN KEY ("workspace_id")
    REFERENCES "workspaces"("id") ON DELETE cascade
);
--> statement-breakpoint
-- The name becomes a DNS label in the box, so two servers in one dispatch set
-- cannot share one. Refused here as well as in the validator: a duplicate that
-- reached the fleet would be a 400 on dispatch with nothing naming the cause.
--
-- This also serves every by-workspace read, `workspace_id` being leftmost, so
-- there is deliberately no second index on it.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_mcp_servers_workspace_name"
  ON "mcp_servers" ("workspace_id", "name");
--> statement-breakpoint
-- A loop may pin its own set instead of inheriting the workspace's enabled one.
-- NULL means inherit, which is what every loop written before this column said.
-- An empty array means "no tool servers", the same tri-state `tools` has and
-- for the same reason.
ALTER TABLE "loops" ADD COLUMN IF NOT EXISTS "mcp_server_ids" jsonb;
--> statement-breakpoint
-- RLS, and the grant that goes with it.
--
-- Omitting either is a production incident, not an oversight: `ownerScope`
-- drops to `talyn_backend` for the request transaction, an RLS-enabled table
-- with no policy raises `permission denied`, and a table with no grant does the
-- same — either way the whole transaction fails with 25P02 cascading over every
-- later statement in the request.
--
-- `talyn_backend` and `public.talyn_uid()`, NOT `authenticated` and
-- `auth.uid()`: migration 0057 moved the backend to its own role and repointed
-- every policy, and 0058 revoked the Data API roles. 0057 also asserts that no
-- policy still calls `auth.uid()`, so copying an older migration's block here
-- would fail that check the next time it ran.
ALTER TABLE "mcp_servers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "mcp_servers" TO talyn_backend;
--> statement-breakpoint
CREATE POLICY "mcp_servers_workspace" ON "mcp_servers" FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()));
--> statement-breakpoint
-- Prove the grant landed, the way 0057 proves its own. A grant that silently
-- did nothing must not read as a successful migration.
DO $$
BEGIN
  IF NOT has_table_privilege('talyn_backend', 'public.mcp_servers', 'SELECT') THEN
    RAISE EXCEPTION 'talyn_backend did not receive SELECT on public.mcp_servers';
  END IF;
END $$;

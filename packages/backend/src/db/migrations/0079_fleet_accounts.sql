-- Fleet accounts: more than one Claude or Codex credential per workspace, in a
-- priority order, so a run can move to the next account when one is used up.
--
-- One row per credential. Until now a workspace held at most one subscription
-- and one pasted key per vendor, as keys on `integrations.config`
-- (`claudeOAuth`, `anthropicKeyEnc`, `codexOAuth`, `openaiKeyEnc`). Those keys
-- are copied here and LEFT IN PLACE: an old backend instance still serving
-- during the deploy overlap reads them, and a later migration strips them.
--
-- `credential` holds encrypted envelopes only (services/tokenCrypto.ts), the
-- same shapes the config keys held. `reauth_required_at` and `quota_exhausted`
-- are columns rather than keys inside it, because they are per ACCOUNT now: one
-- revoked or spent subscription must not stop the others.
CREATE TABLE IF NOT EXISTS "fleet_accounts" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  -- 'claude' | 'codex'. Plain text with no CHECK, like `tasks.status`.
  "agent" text NOT NULL,
  -- 'claude_oauth' | 'anthropic_key' | 'codex_oauth' | 'openai_key'.
  "kind" text NOT NULL,
  "label" text NOT NULL,
  -- 1 is tried first. Not unique: a reorder rewrites every row of the agent in
  -- one statement, and a unique index would refuse its intermediate states.
  "priority" integer NOT NULL,
  "credential" jsonb NOT NULL,
  "reauth_required_at" timestamp with time zone,
  "quota_exhausted" jsonb,
  -- The last usage snapshot read from the vendor. Never a credential.
  "usage" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "fleet_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id")
    REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fleet_accounts_workspace_agent_priority"
  ON "fleet_accounts" USING btree ("workspace_id", "agent", "priority");
--> statement-breakpoint
-- RLS, in the post-0057 form: `talyn_backend` and `public.talyn_uid()`.
-- Omitting the enable or the grant is a production incident: `ownerScope`
-- drops to `talyn_backend`, and a table with no policy or no grant aborts the
-- request transaction with 25P02 on every later statement.
ALTER TABLE "fleet_accounts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "fleet_accounts" TO talyn_backend;
--> statement-breakpoint
CREATE POLICY "fleet_accounts_workspace" ON "fleet_accounts" FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()));
--> statement-breakpoint
DO $$
BEGIN
  IF NOT has_table_privilege('talyn_backend', 'public.fleet_accounts', 'SELECT') THEN
    RAISE EXCEPTION 'talyn_backend did not receive SELECT on public.fleet_accounts';
  END IF;
END $$;
--> statement-breakpoint
-- Backfill from the selfhosted integration row.
--
-- A signed-in subscription goes first and a pasted key second, which is the
-- order the old resolver preferred them in. The agent-wide quota hold is copied
-- onto every account of that agent, so the agent stays held exactly as before.
--
-- The id is derived from the workspace and the kind, not random. The backend
-- runs the same insert at read time for a workspace whose config still has keys
-- and no accounts (`adoptLegacyFleetAccounts` in services/selfHosted/accounts.ts,
-- for a key written by an old instance during the deploy overlap). With one id
-- for one credential, two runs of either cannot make two rows.
INSERT INTO "fleet_accounts" (
  "id", "workspace_id", "agent", "kind", "label", "priority", "credential",
  "reauth_required_at", "quota_exhausted", "created_at", "updated_at"
)
SELECT
  md5(s.workspace_id || ':' || s.kind)::uuid::text,
  s.workspace_id,
  s.agent,
  s.kind,
  s.label,
  (row_number() OVER (PARTITION BY s.workspace_id, s.agent ORDER BY s.rank))::int,
  s.credential,
  CASE WHEN s.reauth ~ '^\d{4}-\d{2}-\d{2}T' THEN s.reauth::timestamptz END,
  NULLIF(s.hold, 'null'::jsonb),
  now(),
  now()
FROM (
  SELECT i.workspace_id, 'claude' AS agent, 'claude_oauth' AS kind,
    'Claude subscription' AS label, 1 AS rank,
    (i.config -> 'claudeOAuth') - 'reauthRequiredAt' AS credential,
    i.config -> 'claudeOAuth' ->> 'reauthRequiredAt' AS reauth,
    i.config -> 'quotaExhausted' -> 'claude' AS hold
  FROM "integrations" i
  WHERE i.type = 'selfhosted' AND jsonb_typeof(i.config -> 'claudeOAuth') = 'object'
  UNION ALL
  SELECT i.workspace_id, 'claude', 'anthropic_key', 'Anthropic API key', 2,
    jsonb_build_object('keyEnc', i.config -> 'anthropicKeyEnc'),
    NULL,
    i.config -> 'quotaExhausted' -> 'claude'
  FROM "integrations" i
  WHERE i.type = 'selfhosted' AND jsonb_typeof(i.config -> 'anthropicKeyEnc') = 'object'
  UNION ALL
  SELECT i.workspace_id, 'codex', 'codex_oauth', 'ChatGPT subscription', 1,
    (i.config -> 'codexOAuth') - 'reauthRequiredAt',
    i.config -> 'codexOAuth' ->> 'reauthRequiredAt',
    i.config -> 'quotaExhausted' -> 'codex'
  FROM "integrations" i
  WHERE i.type = 'selfhosted' AND jsonb_typeof(i.config -> 'codexOAuth') = 'object'
  UNION ALL
  SELECT i.workspace_id, 'codex', 'openai_key', 'OpenAI API key', 2,
    jsonb_build_object('keyEnc', i.config -> 'openaiKeyEnc'),
    NULL,
    i.config -> 'quotaExhausted' -> 'codex'
  FROM "integrations" i
  WHERE i.type = 'selfhosted' AND jsonb_typeof(i.config -> 'openaiKeyEnc') = 'object'
) s
WHERE NOT EXISTS (
  SELECT 1 FROM "fleet_accounts" fa
  WHERE fa.workspace_id = s.workspace_id AND fa.agent = s.agent
)
ON CONFLICT ("id") DO NOTHING;

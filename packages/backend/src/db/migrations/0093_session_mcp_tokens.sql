-- Talyn's own MCP server inside a session's sandbox: one credential per
-- session, owned by the session's owner.
--
-- The plaintext must come back: the fleet persists an inline MCP secret
-- nowhere, so a fleetd restart re-pulls it from us. It is stored encrypted
-- (`token_ciphertext`, the integration-token envelope) next to the hash that
-- validation looks up.
--
-- Backend-pool-only, like the Slack tables (0090): RLS on with NO policy and no
-- talyn_backend grant. The /mcp endpoint validates before ownerScope, and the
-- user's own token list (mcp_tokens, owner-scoped) never shows these rows.
--
-- The row goes with its session (ON DELETE CASCADE), which is the revocation.
CREATE TABLE IF NOT EXISTS "session_mcp_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"workbench_id" text NOT NULL REFERENCES "workbenches"("id") ON DELETE CASCADE,
	"owner_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"token_hash" text NOT NULL,
	"token_ciphertext" jsonb NOT NULL,
	-- The session whose token created this session, when one did.
	"parent_workbench_id" text REFERENCES "workbenches"("id") ON DELETE SET NULL,
	-- 0 for a session a person started; the parent's depth + 1 otherwise.
	"spawn_depth" integer DEFAULT 0 NOT NULL,
	-- The fixed one-hour window that caps create_session calls by this token.
	"creates_window_started_at" timestamp with time zone,
	"creates_in_window" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_session_mcp_tokens_workbench" ON "session_mcp_tokens" USING btree ("workbench_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_session_mcp_tokens_token_hash" ON "session_mcp_tokens" USING btree ("token_hash");
--> statement-breakpoint
ALTER TABLE "session_mcp_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "session_mcp_tokens" FROM PUBLIC, anon, authenticated;

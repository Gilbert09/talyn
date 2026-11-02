-- Two additive tables for the public API (`/v1`).
--
-- api_tokens: personal access tokens (`talyn_pat_...`). Only the SHA-256 of a
-- token is stored; the plaintext is shown once. `scopes` says what the token
-- may do; `workspace_ids` NULL means every workspace of the owner.
--
-- api_idempotency_keys: one row per `Idempotency-Key` a token sent on a create.
-- The row holds the request hash and the response, so a retry gets the first
-- answer and does not start the work twice. Rows expire after 24 hours.
--
-- Backend-pool-only, like workspace_memories (0096): RLS on with NO policy and
-- no talyn_backend grant. The `/v1` requests carry no Supabase JWT, and the
-- management routes scope every query to the caller themselves.
--
-- Shipped before usage billing, which moved to 0101 with a later timestamp.
-- The drizzle migrator skips a migration whose timestamp is older than the
-- newest applied one, so a renumbered migration must also get a new timestamp.
CREATE TABLE IF NOT EXISTS "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"token_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"workspace_ids" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by_ip" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_api_tokens_token_hash" ON "api_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_tokens_owner" ON "api_tokens" USING btree ("owner_id");
--> statement-breakpoint
ALTER TABLE "api_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "api_tokens" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_idempotency_keys" (
	"token_id" text NOT NULL REFERENCES "api_tokens"("id") ON DELETE CASCADE,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	-- 'in_progress' | 'completed'.
	"status" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_idempotency_keys_pkey" PRIMARY KEY ("token_id", "key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_idempotency_keys_created" ON "api_idempotency_keys" USING btree ("created_at");
--> statement-breakpoint
ALTER TABLE "api_idempotency_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "api_idempotency_keys" FROM PUBLIC, anon, authenticated;

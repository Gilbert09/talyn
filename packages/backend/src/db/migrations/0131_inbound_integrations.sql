-- Inbound integrations: requests other systems send to Talyn.
--
-- `inbound_connections` is one source of requests: a vendor account (later
-- Linear, Sentry, Jira) or, today, the generic webhook of ONE rule. The
-- generic webhook's URL carries a token, and only its sha256 is kept
-- (`token_hash`), so Talyn cannot show the URL again after it is created.
-- `secret_enc` is the HMAC signing secret (tokenCrypto envelope).
--
-- `inbound_deliveries` stores each request before it is processed. UNIQUE
-- (connection_id, delivery_id) is the idempotency: a resend is a no-op, and a
-- replay is a new row with `delivery_id = <orig>:replay:<n>`.
--
-- Backend-pool-only, like workbench_resource_samples (0121): RLS on with NO
-- policy and no talyn_backend grant. The webhook receiver has no user, and the
-- owner routes check workspace access before they read.
CREATE TABLE IF NOT EXISTS "inbound_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"kind" text NOT NULL,
	"external_account_id" text,
	"token_hash" text,
	"secret_enc" jsonb,
	"credential_enc" jsonb,
	"credential_meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rule_id" text REFERENCES "workflows"("id") ON DELETE CASCADE,
	"created_by" text REFERENCES "users"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_inbound_connections_account"
  ON "inbound_connections" USING btree ("workspace_id", "kind", "external_account_id");
--> statement-breakpoint
-- A generic webhook connection belongs to exactly one rule.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_inbound_connections_rule"
  ON "inbound_connections" USING btree ("rule_id") WHERE "rule_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "inbound_connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "inbound_connections" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbound_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL REFERENCES "inbound_connections"("id") ON DELETE CASCADE,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload_bytes" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"outcome" text,
	"error" text,
	"replay_of" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_inbound_deliveries_delivery"
  ON "inbound_deliveries" USING btree ("connection_id", "delivery_id");
--> statement-breakpoint
-- The deliveries list, newest first, and the replay counter.
CREATE INDEX IF NOT EXISTS "idx_inbound_deliveries_connection_received"
  ON "inbound_deliveries" USING btree ("connection_id", "received_at");
--> statement-breakpoint
-- The sweep: deliveries not processed yet. Partial, so it stays small.
CREATE INDEX IF NOT EXISTS "idx_inbound_deliveries_pending"
  ON "inbound_deliveries" USING btree ("received_at") WHERE "processed_at" IS NULL;
--> statement-breakpoint
-- The 7-day prune.
CREATE INDEX IF NOT EXISTS "idx_inbound_deliveries_received"
  ON "inbound_deliveries" USING btree ("received_at");
--> statement-breakpoint
ALTER TABLE "inbound_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "inbound_deliveries" FROM PUBLIC, anon, authenticated;

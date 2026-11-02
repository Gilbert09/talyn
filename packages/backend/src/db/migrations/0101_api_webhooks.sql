-- Outbound webhooks for the public API (`/v1/webhooks`).
--
-- api_webhook_endpoints: a URL that receives signed events. `workspace_id`
-- NULL means every workspace of the owner. `event_types` empty means every
-- event type. The signing secret is AES-256-GCM encrypted (tokenCrypto.ts);
-- after a rotation the previous secret also signs until it expires.
--
-- api_webhook_deliveries: one row per event per endpoint. The delivery worker
-- claims due rows and posts them. `next_attempt_at` is both the schedule and
-- the lease: a claim moves it 60 seconds ahead, so a row whose worker died is
-- due again after that. UNIQUE (endpoint_id, event_id) makes the same event
-- enqueue once per endpoint, from any replica.
--
-- api_webhook_object_states: the last state Talyn announced for a session or a
-- pull request. The dispatcher compares a new state with it in one upsert, so
-- one change gives one event even when two replicas see it.
--
-- Backend-pool-only, like api_tokens (0100): RLS on with NO policy and no
-- talyn_backend grant.
CREATE TABLE IF NOT EXISTS "api_webhook_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"workspace_id" text REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"url" text NOT NULL,
	"description" text,
	"event_types" text[] DEFAULT '{}' NOT NULL,
	"secret_enc" jsonb NOT NULL,
	"previous_secret_enc" jsonb,
	"previous_secret_expires_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"disabled_reason" text,
	"disabled_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"failing_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_webhook_endpoints_owner" ON "api_webhook_endpoints" USING btree ("owner_id");
--> statement-breakpoint
ALTER TABLE "api_webhook_endpoints" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "api_webhook_endpoints" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"endpoint_id" text NOT NULL REFERENCES "api_webhook_endpoints"("id") ON DELETE CASCADE,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	-- 'pending' | 'succeeded' | 'failed' | 'abandoned'.
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_token" text,
	"last_response_status" integer,
	"last_error" text,
	"last_response_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_api_webhook_deliveries_endpoint_event" ON "api_webhook_deliveries" USING btree ("endpoint_id", "event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_webhook_deliveries_due" ON "api_webhook_deliveries" USING btree ("next_attempt_at") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_webhook_deliveries_endpoint_created" ON "api_webhook_deliveries" USING btree ("endpoint_id", "created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_webhook_deliveries_created" ON "api_webhook_deliveries" USING btree ("created_at");
--> statement-breakpoint
ALTER TABLE "api_webhook_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "api_webhook_deliveries" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_webhook_object_states" (
	"object_key" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_webhook_object_states_updated" ON "api_webhook_object_states" USING btree ("updated_at");
--> statement-breakpoint
ALTER TABLE "api_webhook_object_states" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "api_webhook_object_states" FROM PUBLIC, anon, authenticated;

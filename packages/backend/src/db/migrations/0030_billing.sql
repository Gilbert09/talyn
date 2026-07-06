-- Billing (Polar): plan + subscription state on users, plus a webhook
-- audit/idempotency table. `plan` is driven exclusively by Polar webhooks;
-- `plan_override` is the manual comp flag (set via SQL, never by webhooks)
-- and wins when present.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "plan" text NOT NULL DEFAULT 'free';
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "plan_override" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "polar_customer_id" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "polar_subscription_id" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "subscription_status" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "current_period_end" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "cancel_at_period_end" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "subscription_event_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_users_polar_customer" ON "users" USING btree ("polar_customer_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"subscription_id" text,
	"user_id" text,
	"occurred_at" timestamp with time zone,
	"applied" boolean NOT NULL DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Backend-pool-only surface: RLS enabled with NO authenticated policy or
-- grant (0025 mcp_tokens documents the pattern; here we omit even the owner
-- policy — only the privileged pool role, which bypasses RLS, touches this
-- table). `user_id` deliberately has no FK so the audit trail survives an
-- account wipe.
ALTER TABLE "billing_events" ENABLE ROW LEVEL SECURITY;

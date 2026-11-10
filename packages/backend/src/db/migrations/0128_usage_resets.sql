-- Usage resets: a one-time payment of the plan's monthly price that sets the
-- current period's used box-hours back to zero.
--
-- usage_periods.reset_used_wsec: the weighted seconds resets moved out of
-- used_wsec. used_wsec + reset_used_wsec is everything the period ran.
--
-- usage_resets: one row per paid reset order. polar_order_id is UNIQUE, so a
-- redelivered order.paid resets once. A refund that arrives before its
-- order.paid writes a row with period_start NULL, and the late order.paid then
-- does nothing.
ALTER TABLE "usage_periods" ADD COLUMN IF NOT EXISTS "reset_used_wsec" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_resets" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"polar_order_id" text NOT NULL,
	"tier" text NOT NULL,
	"period_start" timestamp with time zone,
	"used_before_wsec" bigint DEFAULT 0 NOT NULL,
	"included_wsec" bigint DEFAULT 0 NOT NULL,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_usage_resets_polar_order" ON "usage_resets" USING btree ("polar_order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_usage_resets_owner_period" ON "usage_resets" USING btree ("owner_id", "period_start");
--> statement-breakpoint
ALTER TABLE "usage_resets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "usage_resets" FROM PUBLIC, anon, authenticated;

-- Usage billing: the box-hour ledger and USD credits.
--
-- Money is integer micro-dollars (bigint *_micros, USD x 1,000,000). Usage is
-- integer weighted seconds (wsec): running seconds x the size weight, so one
-- box-hour is 3600 wsec. See packages/shared/src/pricing.ts.
--
-- usage_intervals: one row per stretch of time a fleet box runs. The partial
-- unique index on sandbox_id is the idempotency of an open: a box has at most
-- one open interval. billed_through is the CAS cursor of the charge step, so
-- two replicas cannot bill the same seconds twice. billed_wsec is what the
-- interval has billed so far (the usage page reads it).
--
-- usage_periods: one row per owner per monthly usage period. used_wsec is a
-- counter (atomic +=), so a budget read is one row, never a sum over history.
-- The alert_*_at and exhausted_at stamps are written with WHERE ... IS NULL,
-- so each fires once.
--
-- credit_lots: USD credit, one row per purchase or grant, with its own
-- 12-month expiry. Burned soonest-expiry first. polar_order_id is UNIQUE, so a
-- duplicate order.paid or a finalize answer and its webhook grant one lot.
--
-- credit_ledger: append-only audit of every credit movement. Never read on a
-- hot path.
--
-- auto_topup_settings: the owner's auto top-up policy and its monthly counter.
--
-- Column adds: users.polar_product_id and teams.polar_product_id (written by
-- the webhook; the tier follows the product), teams.tier (existing teams keep
-- Legacy Pro terms).
--
-- Backend-pool-only, like the team tables (0071): RLS on with NO policy and no
-- talyn_backend grant.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "polar_product_id" text;
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "tier" text NOT NULL DEFAULT 'legacy_pro';
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "polar_product_id" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_intervals" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"workspace_id" text,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"sandbox_id" text NOT NULL,
	"size" text NOT NULL,
	"weight" numeric(4, 2) NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"billed_through" timestamp with time zone NOT NULL,
	"billed_wsec" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_usage_intervals_open" ON "usage_intervals" USING btree ("sandbox_id") WHERE "ended_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_usage_intervals_owner_open" ON "usage_intervals" USING btree ("owner_id") WHERE "ended_at" IS NULL;
--> statement-breakpoint
-- What the meter still owes: open intervals, and closed ones not billed up to
-- their end yet.
CREATE INDEX IF NOT EXISTS "idx_usage_intervals_unbilled" ON "usage_intervals" USING btree ("owner_id") WHERE "ended_at" IS NULL OR "billed_through" < "ended_at";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_usage_intervals_owner_started" ON "usage_intervals" USING btree ("owner_id", "started_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_periods" (
	"owner_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"tier" text NOT NULL,
	"included_wsec" bigint NOT NULL,
	"used_wsec" bigint DEFAULT 0 NOT NULL,
	"credit_micros_used" bigint DEFAULT 0 NOT NULL,
	"uncovered_micros" bigint DEFAULT 0 NOT NULL,
	"alert_50_at" timestamp with time zone,
	"alert_80_at" timestamp with time zone,
	"alert_100_at" timestamp with time zone,
	"exhausted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_periods_pkey" PRIMARY KEY ("owner_id", "period_start")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_lots" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"total_micros" bigint NOT NULL,
	"remaining_micros" bigint NOT NULL,
	"source" text NOT NULL,
	"polar_order_id" text,
	"purchased_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_lots_remaining_check" CHECK ("remaining_micros" >= 0 AND "remaining_micros" <= "total_micros")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_credit_lots_polar_order" ON "credit_lots" USING btree ("polar_order_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_credit_lots_owner_live" ON "credit_lots" USING btree ("owner_id", "expires_at") WHERE "remaining_micros" > 0;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"lot_id" text REFERENCES "credit_lots"("id") ON DELETE SET NULL,
	"delta_micros" bigint NOT NULL,
	"reason" text NOT NULL,
	"interval_id" text,
	"period_start" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_credit_ledger_owner" ON "credit_ledger" USING btree ("owner_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auto_topup_settings" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"trigger_micros" bigint DEFAULT 5000000 NOT NULL,
	"pack" text DEFAULT '25' NOT NULL,
	"monthly_limit_micros" bigint DEFAULT 100000000 NOT NULL,
	"month_key" text,
	"month_spent_micros" bigint DEFAULT 0 NOT NULL,
	"inflight_order_id" text,
	"inflight_started_at" timestamp with time zone,
	"last_failure" text,
	"last_failure_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_intervals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "usage_periods" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "credit_lots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "credit_ledger" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "auto_topup_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "usage_intervals" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON "usage_periods" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON "credit_lots" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON "credit_ledger" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON "auto_topup_settings" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON SEQUENCE "credit_ledger_id_seq" FROM PUBLIC, anon, authenticated;

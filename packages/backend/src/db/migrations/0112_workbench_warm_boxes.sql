-- A warm pool of session boxes (services/workbenches/warmPool.ts): one row per
-- box, booted, checked out and set up before any session asks for it.
--
-- A box is fleet overhead until a session claims it: no usage interval is open
-- for it, and the claim opens the session's own. The rows stay after the box
-- ends, so the overhead (created_at to claimed_at or ended_at) can be counted.
-- No foreign keys, like usage_intervals: the record outlives the repository.
--
-- The claim is a compare-and-set on status ('ready' -> 'claimed'), so two
-- sessions cannot take one box. No lock.
CREATE TABLE IF NOT EXISTS "workbench_warm_boxes" (
  "id" text PRIMARY KEY,
  "sandbox_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "repository_id" text NOT NULL,
  "agent" text NOT NULL,
  "size" text NOT NULL,
  "internet_access" boolean NOT NULL,
  "base_branch" text NOT NULL,
  "spec_hash" text NOT NULL,
  "status" text NOT NULL,
  "fleet_host" text,
  "fleet_sandbox_id" text,
  "record" jsonb,
  "checkout_commit" text,
  "setup_exit" integer,
  "fill_ms" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ready_at" timestamp with time zone,
  "touched_at" timestamp with time zone,
  "checked_at" timestamp with time zone,
  "claimed_at" timestamp with time zone,
  "claimed_by" text,
  "ended_at" timestamp with time zone,
  "end_reason" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workbench_warm_boxes_sandbox" ON "workbench_warm_boxes" ("sandbox_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workbench_warm_boxes_live" ON "workbench_warm_boxes" ("repository_id", "status") WHERE "ended_at" IS NULL;
--> statement-breakpoint
-- Backend-only and read on the pool, like workbench_maintenance_claims: RLS on, no policy, no talyn_backend grant.
ALTER TABLE "workbench_warm_boxes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "workbench_warm_boxes" FROM PUBLIC, anon, authenticated;

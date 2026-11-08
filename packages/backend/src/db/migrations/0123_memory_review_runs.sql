-- Memory review runs (`memory-review` flag).
--
-- A memory review is a thread that Talyn starts on the workspace's cadence
-- (`settings.memoryReview`) or on "Review now", to merge overlapping memory
-- entries and settle contradicting ones. One row per review.
--
-- `period_start` is the key of a scheduled review: the start of the UTC day,
-- ISO week or month it belongs to. UNIQUE (workspace_id, period_start) is the
-- concurrency design: two replicas that sweep together compute the same key,
-- and only the insert that wins starts a thread. A manual review uses the
-- instant of the request, so it does not take the scheduled key.
--
-- Backend-pool-only, like workbench_wakeups (0119): RLS on with NO policy and
-- no talyn_backend grant. Rows go with their workspace (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS "memory_review_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"period_start" timestamp with time zone NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"workbench_id" text REFERENCES "workbenches"("id") ON DELETE SET NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_memory_review_runs_period" ON "memory_review_runs" USING btree ("workspace_id", "period_start");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memory_review_runs_recent" ON "memory_review_runs" USING btree ("workspace_id", "created_at");
--> statement-breakpoint
ALTER TABLE "memory_review_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "memory_review_runs" FROM PUBLIC, anon, authenticated;

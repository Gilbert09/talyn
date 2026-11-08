-- Resource samples of a session's box, for the CPU and memory chart in the
-- Sandbox panel. The usage sweep writes one row per running session box each
-- minute and deletes rows older than two hours. `cpu_seconds` is the fleet's
-- cumulative VMM CPU time; the panel charts the change between two rows.
--
-- Backend-pool-only, like workbench_background_jobs (0119): RLS on with NO
-- policy and no talyn_backend grant. Rows go with their session (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS "workbench_resource_samples" (
	"workbench_id" text NOT NULL REFERENCES "workbenches"("id") ON DELETE CASCADE,
	"sampled_at" timestamp with time zone NOT NULL,
	"sandbox_id" text NOT NULL,
	"mem_used_mib" integer,
	"mem_limit_mib" integer,
	"cpu_seconds" double precision,
	"vcpus" real,
	PRIMARY KEY ("workbench_id", "sampled_at")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workbench_resource_samples_sampled" ON "workbench_resource_samples" USING btree ("sampled_at");
--> statement-breakpoint
ALTER TABLE "workbench_resource_samples" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "workbench_resource_samples" FROM PUBLIC, anon, authenticated;

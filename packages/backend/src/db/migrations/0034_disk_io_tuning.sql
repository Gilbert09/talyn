-- Disk IO reduction (Supabase IO-budget pressure on fastowl-prod). Three levers:
--   1. Faster dead-tuple reclaim on the two high-churn tables (pull_requests,
--      tasks) so the heap and its TOAST don't bloat into extra read IO.
--   2. fillfactor < 100 so the frequent last_polled_at / updated_at bumps can
--      become HOT updates (in-page, no index write, no re-TOAST of the big
--      jsonb columns). Only affects pages written after this runs — autovacuum
--      + normal churn reclaim the rest over time; no table rewrite (which would
--      take an exclusive lock and stall the app on boot-time migrate).
--   3. last_summary_digest: lets prCache.upsertRow skip re-writing the ~2 KB
--      last_summary jsonb (and its cursor columns) when a poll yields identical
--      content, writing only the TTL timestamp. NULL on existing rows → the
--      first poll after deploy repopulates it.
ALTER TABLE "tasks"
  SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01, fillfactor = 90);
--> statement-breakpoint
ALTER TABLE "pull_requests"
  SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01, fillfactor = 85);
--> statement-breakpoint
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "last_summary_digest" text;

-- How often sessions read each memory entry (Talyn memory, 0096), and why an
-- entry was forgotten.
--
-- use_count goes up by one each time talyn_memory_read returns the entry.
-- last_used_at is the time of the last read; null when nobody read it.
-- forgotten_reason is 'evicted' when Talyn forgot the entry to make room at
-- the live entry cap, and null otherwise. At the cap, Talyn forgets the entry
-- with the fewest reads first, then the one with the oldest last read
-- (services/workbenches/memory.ts).
--
-- The backfill counts the sessions that read each entry
-- (workspace_memory_uses, 0120). That table has one row per session, not per
-- read, so old counts start low.
ALTER TABLE "workspace_memories" ADD COLUMN IF NOT EXISTS "use_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspace_memories" ADD COLUMN IF NOT EXISTS "last_used_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "workspace_memories" ADD COLUMN IF NOT EXISTS "forgotten_reason" text;
--> statement-breakpoint
ALTER TABLE "workspace_memories" DROP CONSTRAINT IF EXISTS "chk_workspace_memories_forgotten_reason";
--> statement-breakpoint
ALTER TABLE "workspace_memories" ADD CONSTRAINT "chk_workspace_memories_forgotten_reason"
  CHECK ("forgotten_reason" IS NULL OR "forgotten_reason" = 'evicted');
--> statement-breakpoint
UPDATE "workspace_memories" m
SET "use_count" = u.reads, "last_used_at" = u.last_read
FROM (
  SELECT "memory_id", count(*)::int AS reads, max("last_used_at") AS last_read
  FROM "workspace_memory_uses"
  WHERE "read"
  GROUP BY "memory_id"
) u
WHERE m."id" = u."memory_id" AND m."use_count" = 0;

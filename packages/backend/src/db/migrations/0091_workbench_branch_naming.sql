ALTER TABLE "workbenches" ADD COLUMN IF NOT EXISTS "branch_named_at" timestamp with time zone;
--> statement-breakpoint
-- Only sessions created from now on are renamed after their first turn. An
-- older session's branch is one its owner already knows.
UPDATE "workbenches" SET "branch_named_at" = now() WHERE "branch_named_at" IS NULL;

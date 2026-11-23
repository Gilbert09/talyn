ALTER TABLE "workbenches" ADD COLUMN "parent_workbench_id" text REFERENCES "workbenches"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "workbenches" ADD COLUMN "notify_parent" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_workbenches_parent" ON "workbenches" ("parent_workbench_id") WHERE "parent_workbench_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "workbenches" AS child
SET "parent_workbench_id" = token."parent_workbench_id"
FROM "session_mcp_tokens" AS token
WHERE token."workbench_id" = child."id" AND token."parent_workbench_id" IS NOT NULL;

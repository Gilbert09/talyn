-- Agent skills saved to the platform (workspace-scoped SKILL.md store) and
-- the per-workspace usage counters that drive the skill picker's
-- "frequently used" ordering. Repo/local skills are never stored here.
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"content" text NOT NULL,
	"source_info" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_usage" (
	"workspace_id" text NOT NULL,
	"skill_key" text NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_usage_workspace_id_skill_key_pk" PRIMARY KEY("workspace_id","skill_key")
);
--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "skill_usage" ADD CONSTRAINT "skill_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_skills_workspace" ON "skills" USING btree ("workspace_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_skills_workspace_name" ON "skills" USING btree ("workspace_id","name");
--> statement-breakpoint
-- Defense in depth, mirroring the other workspace-scoped tables (0002/0024):
-- the backend pool bypasses RLS; a JWT/anon connection only ever sees rows in
-- workspaces it owns.
ALTER TABLE "skills" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "skills_workspace" ON "skills" FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "skills" TO "authenticated";
--> statement-breakpoint
ALTER TABLE "skill_usage" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "skill_usage_workspace" ON "skill_usage" FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "skill_usage" TO "authenticated";

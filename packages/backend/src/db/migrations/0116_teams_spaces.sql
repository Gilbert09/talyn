-- Teams and Spaces (phase 1).
--
-- A team is now the multiplayer entity. Its members come from invites by
-- GitHub login and from the team's seat holders. A space belongs to a team and
-- holds sessions and tasks. Each session or task still runs in its creator's
-- own workspace: no workspace, credential or RLS policy is shared.
--
-- team_members is keyed by the numeric GitHub id, so an invite works before
-- the person signs up. user_id is filled at their first read (lazy claim).
CREATE TABLE IF NOT EXISTS "team_members" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
	"github_user_id" bigint NOT NULL,
	"user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
	"github_login" text NOT NULL,
	"avatar_url" text,
	"role" text NOT NULL DEFAULT 'member',
	"source" text NOT NULL DEFAULT 'invite',
	"home_workspace_id" text REFERENCES "workspaces"("id") ON DELETE SET NULL,
	"invited_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_team_members_team_github" ON "team_members" USING btree ("team_id", "github_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_team_members_user" ON "team_members" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_team_members_github_user" ON "team_members" USING btree ("github_user_id");
--> statement-breakpoint
-- Backfill from the billing tables. The highest role wins for one person:
-- owner (the creator, while still an admin), then admin, then seat holder.
-- Rows for an account with no known GitHub id are skipped: the key is the id.
INSERT INTO "team_members" ("id", "team_id", "github_user_id", "user_id", "github_login", "avatar_url", "role", "source", "created_at")
SELECT
	gen_random_uuid()::text,
	ranked."team_id",
	ranked."github_user_id",
	ranked."user_id",
	ranked."github_login",
	ranked."avatar_url",
	ranked."role",
	CASE WHEN EXISTS (
		SELECT 1 FROM "team_seats" s
		WHERE s."team_id" = ranked."team_id" AND s."github_user_id" = ranked."github_user_id"
	) THEN 'seat' ELSE 'invite' END,
	ranked."created_at"
FROM (
	SELECT DISTINCT ON (c."team_id", c."github_user_id") c.*
	FROM (
		SELECT a."team_id", u."github_user_id", u."id" AS "user_id", u."github_username" AS "github_login",
			'https://avatars.githubusercontent.com/u/' || u."github_user_id" || '?v=4' AS "avatar_url",
			CASE WHEN t."created_by_user_id" = a."user_id" THEN 'owner' ELSE 'admin' END AS "role",
			CASE WHEN t."created_by_user_id" = a."user_id" THEN 0 ELSE 1 END AS "rank",
			a."created_at"
		FROM "team_admins" a
		JOIN "teams" t ON t."id" = a."team_id"
		JOIN "users" u ON u."id" = a."user_id"
		WHERE u."github_user_id" IS NOT NULL AND u."github_username" IS NOT NULL
		UNION ALL
		SELECT s."team_id", s."github_user_id", NULL AS "user_id", s."github_login", s."avatar_url",
			'member' AS "role", 2 AS "rank", s."created_at"
		FROM "team_seats" s
	) c
	ORDER BY c."team_id", c."github_user_id", c."rank"
) ranked
ON CONFLICT ("team_id", "github_user_id") DO NOTHING;
--> statement-breakpoint
-- A team whose creator is no longer an admin still needs an owner: its oldest
-- admin becomes one.
UPDATE "team_members" m SET "role" = 'owner'
WHERE m."id" IN (
	SELECT DISTINCT ON (a."team_id") a."id"
	FROM "team_members" a
	WHERE a."role" = 'admin'
		AND NOT EXISTS (SELECT 1 FROM "team_members" o WHERE o."team_id" = a."team_id" AND o."role" = 'owner')
	ORDER BY a."team_id", a."created_at"
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "spaces" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"color" text,
	"created_by_user_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_spaces_team" ON "spaces" USING btree ("team_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "space_repositories" (
	"space_id" text NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
	"repo_full_name" text NOT NULL,
	"github_repo_id" bigint,
	"added_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("space_id", "repo_full_name")
);
--> statement-breakpoint
ALTER TABLE "workbenches" ADD COLUMN IF NOT EXISTS "space_id" text REFERENCES "spaces"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workbenches_space" ON "workbenches" USING btree ("space_id") WHERE "space_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "space_id" text REFERENCES "spaces"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_space" ON "tasks" USING btree ("space_id") WHERE "space_id" IS NOT NULL;
--> statement-breakpoint
-- Backend-pool-only, like the 0071 team tables: RLS on with NO policy and no
-- grant to talyn_backend. Space reads go through the pool with explicit
-- column projections.
ALTER TABLE "team_members" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "spaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "space_repositories" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "team_members" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON "spaces" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON "space_repositories" FROM PUBLIC, anon, authenticated;

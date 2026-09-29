-- Team plan: seat billing.
--
-- A team pays for seats; a seat gives one GitHub account the Unlimited plan on
-- that person's own account. Nothing is shared through a team.
--
-- users.github_user_id is the numeric GitHub id from the sign-in, filled by the
-- auth upsert on the next request (so no backfill). Indexed, NOT unique: a
-- stale row holding the same id must never make that upsert fail.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "github_user_id" bigint;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_users_github_user_id" ON "users" USING btree ("github_user_id");
--> statement-breakpoint
ALTER TABLE "billing_events" ADD COLUMN IF NOT EXISTS "team_id" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_by_user_id" text,
	"plan" text NOT NULL DEFAULT 'none',
	"plan_override" text,
	"seats_purchased" integer NOT NULL DEFAULT 0,
	"polar_customer_id" text,
	"polar_subscription_id" text,
	"subscription_status" text,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean NOT NULL DEFAULT false,
	"subscription_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_teams_polar_customer" ON "teams" USING btree ("polar_customer_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team_admins" (
	"team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("team_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_team_admins_user" ON "team_admins" USING btree ("user_id");
--> statement-breakpoint
-- UNIQUE on the GitHub id: one team per person, so nobody is paid for twice.
CREATE TABLE IF NOT EXISTS "team_seats" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
	"github_user_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"avatar_url" text,
	"source" text NOT NULL DEFAULT 'named',
	"assigned_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_team_seats_github_user" ON "team_seats" USING btree ("github_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_team_seats_team" ON "team_seats" USING btree ("team_id");
--> statement-breakpoint
-- Backend-pool-only, like billing_events: RLS on with NO policy and no grant
-- to talyn_backend. The entitlement reads these on the pool.
ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "team_admins" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "team_seats" ENABLE ROW LEVEL SECURITY;

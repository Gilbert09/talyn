-- A person's own notification choice per team space.
--
-- A row means the user muted the space: Talyn sends them no phone push for a
-- session or thread in it (or for a pull request that only such sessions
-- link to), and the desktop and web apps show no "agent finished" alert for
-- it. No row: the space notifies as usual. Teammates are not affected.
--
-- Backend-pool only, like the other team tables (0116): RLS on with NO
-- policy, and no grant.
CREATE TABLE IF NOT EXISTS "space_notification_mutes" (
	"user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"space_id" text NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_notification_mutes_pk" PRIMARY KEY ("user_id", "space_id")
);
--> statement-breakpoint
ALTER TABLE "space_notification_mutes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "space_notification_mutes" FROM PUBLIC, anon, authenticated;

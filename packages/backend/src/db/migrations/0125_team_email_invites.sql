-- Team invites by email (Teams and Spaces).
--
-- team_members is keyed by the GitHub id, which an email address does not
-- give. So an email invite waits here until somebody opens the emailed link,
-- signs in with GitHub and accepts. Accepting adds their team_members row.
--
-- Only a SHA-256 hash of the link token is stored. A link is single use
-- (accepted_at) and expires (expires_at). One pending invite per team and
-- email: inviting the same email again replaces the token and the expiry.
--
-- Backend-pool only, like team_members (0116): RLS on with NO policy, and no
-- grant. The rows hold email addresses and live tokens.
CREATE TABLE IF NOT EXISTS "team_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_team_invites_token_hash" ON "team_invites" USING btree ("token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_team_invites_pending_email" ON "team_invites" USING btree ("team_id", "email") WHERE "accepted_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "team_invites" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "team_invites" FROM PUBLIC, anon, authenticated;

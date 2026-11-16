-- PostHog Inbox rules, step 2: Talyn claims a report in PostHog before a
-- session starts, attaches the session's pull request to the claim, and
-- releases the claim when the work ends without a pull request.
--
-- The claim lives on the report's link row (external_issue_links, 0132):
--  - `posthog_claim_id` is PostHog's `assignee.claim_id` for Talyn's work
--    attempt. Later writes (attach, release) pass it back.
--  - `posthog_claim_state`: 'claimed' | 'pr_attached' | 'merged' | 'released'
--    | 'lost'. NULL on a link that made no PostHog claim (issue rules).
--  - `posthog_claim_pr_url` is the pull request Talyn last attached.
--  - `posthog_claim_reason` says why the claim was released or lost.
--  - `posthog_claim_next_check_at` is when the claim sweep looks at the link
--    again. NULL means nothing is owed. `posthog_claim_attempts` and
--    `posthog_claim_error` record failed writes, for the backoff and the run
--    history.
ALTER TABLE "external_issue_links" ADD COLUMN IF NOT EXISTS "posthog_claim_id" text;
--> statement-breakpoint
ALTER TABLE "external_issue_links" ADD COLUMN IF NOT EXISTS "posthog_claim_state" text;
--> statement-breakpoint
ALTER TABLE "external_issue_links" ADD COLUMN IF NOT EXISTS "posthog_claim_pr_url" text;
--> statement-breakpoint
ALTER TABLE "external_issue_links" ADD COLUMN IF NOT EXISTS "posthog_claim_reason" text;
--> statement-breakpoint
ALTER TABLE "external_issue_links" ADD COLUMN IF NOT EXISTS "posthog_claim_next_check_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "external_issue_links" ADD COLUMN IF NOT EXISTS "posthog_claim_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "external_issue_links" ADD COLUMN IF NOT EXISTS "posthog_claim_error" text;
--> statement-breakpoint
ALTER TABLE "external_issue_links" ADD COLUMN IF NOT EXISTS "posthog_claim_updated_at" timestamp with time zone;
--> statement-breakpoint
-- The claim sweep's read, every minute. Partial, so it never reads an issue
-- rule's link or a settled claim.
CREATE INDEX IF NOT EXISTS "idx_external_issue_links_posthog_claim_due"
  ON "external_issue_links" USING btree ("posthog_claim_next_check_at")
  WHERE "posthog_claim_next_check_at" IS NOT NULL;
--> statement-breakpoint
-- The run history reads the claim of each PostHog Inbox run by its run id.
CREATE INDEX IF NOT EXISTS "idx_external_issue_links_posthog_run"
  ON "external_issue_links" USING btree ("run_id")
  WHERE "integration" = 'posthog_inbox';

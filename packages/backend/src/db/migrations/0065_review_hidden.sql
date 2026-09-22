-- Hiding a PR from the Reviews tab. NULL = visible; the instant the user hid it
-- otherwise. Sticky: nothing but an explicit unhide clears it.
ALTER TABLE "pull_requests" ADD COLUMN IF NOT EXISTS "review_hidden_at" timestamp with time zone;

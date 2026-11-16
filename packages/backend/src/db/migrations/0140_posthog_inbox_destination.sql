-- PostHog Inbox push, set up by Talyn: Talyn creates the PostHog webhook
-- destination itself through PostHog's hog functions API.
--
-- The destination belongs to the workspace's webhook URL for one PostHog
-- project (an `inbound_connections` row of kind 'posthog_inbox'), so its id is
-- stored on that row. A rotate updates the destination's URL and secret. A
-- remove deletes it in PostHog.
--
-- `posthog_destination_synced_at` is when PostHog last took the URL and the
-- secret. `posthog_destination_error` is set when Talyn changed the URL but
-- could not update the destination: the destination is then out of date.
ALTER TABLE "inbound_connections" ADD COLUMN IF NOT EXISTS "posthog_destination_id" text;
ALTER TABLE "inbound_connections" ADD COLUMN IF NOT EXISTS "posthog_destination_synced_at" timestamp with time zone;
ALTER TABLE "inbound_connections" ADD COLUMN IF NOT EXISTS "posthog_destination_error" text;

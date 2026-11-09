-- The mobile app's allowlisted URL base (for example `talyn-mobile://`) for a
-- Slack or PostHog Code sign-in it started in an in-app browser. NULL for a
-- web or desktop flow. The callback validates the value again before it sends
-- a 302 to `${mobile_return}slack/callback?...` or `.../posthog/callback?...`.
ALTER TABLE slack_oauth_states ADD COLUMN mobile_return text;
ALTER TABLE posthog_oauth_states ADD COLUMN mobile_return text;

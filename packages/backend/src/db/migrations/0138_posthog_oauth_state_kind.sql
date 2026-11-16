-- PostHog Inbox rules get their own PostHog connection (an `integrations` row
-- of type 'posthog_inbox'), separate from the retired PostHog Code one. Both
-- OAuth flows use the same callback URL, so the state row records which flow
-- started it. Each flow refuses a state of the other kind. Existing rows were
-- all minted by the PostHog Code flow.
ALTER TABLE posthog_oauth_states ADD COLUMN kind text NOT NULL DEFAULT 'posthog_code';

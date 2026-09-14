-- RUN THIS BEFORE DEPLOYING the PostHog host allowlist.
--
-- The allowlist fails closed: only `us.posthog.com`, `eu.posthog.com` and
-- `app.posthog.com` are accepted unless the operator sets
-- `POSTHOG_ALLOWED_ORIGINS`. Every workspace on any other host stops making
-- PostHog requests the moment the new build serves. This query lists them, so
-- the env var can be set in the same deploy.
--
-- Three kinds of row need different handling:
--
--   1. An exact HTTPS origin (https://posthog.example.com) — add it to
--      POSTHOG_ALLOWED_ORIGINS, comma-separated.
--   2. An `http://` host — the policy is HTTPS-only and will refuse it whatever
--      the env var says. The workspace must move to HTTPS and reconnect.
--   3. A non-canonical spelling (uppercase, an explicit :443, a trailing path).
--      Listing it does NOT help: the policy compares exact origins. Fix the
--      stored value, or have the user reconnect.
--
-- The `needs` column says which one each row is.

SELECT
  i.workspace_id,
  w.name AS workspace,
  u.email AS owner,
  COALESCE(NULLIF(trim(i.config ->> 'host'), ''), 'https://us.posthog.com') AS host,
  CASE
    WHEN COALESCE(NULLIF(trim(i.config ->> 'host'), ''), 'https://us.posthog.com') !~* '^https://'
      THEN 'move to https and reconnect'
    WHEN COALESCE(NULLIF(trim(i.config ->> 'host'), ''), 'https://us.posthog.com')
         ~ '^https://[a-z0-9.-]+/?$'
      THEN 'add to POSTHOG_ALLOWED_ORIGINS'
    ELSE 'non-canonical spelling — fix the stored value'
  END AS needs
FROM integrations i
JOIN workspaces w ON w.id = i.workspace_id
LEFT JOIN users u ON u.id = w.owner_id
WHERE i.type = 'posthog'
  AND COALESCE(NULLIF(trim(i.config ->> 'host'), ''), 'https://us.posthog.com') NOT IN (
    'https://us.posthog.com', 'https://eu.posthog.com', 'https://app.posthog.com'
  )
ORDER BY needs, host;

-- The value to paste, for the rows that only need the env var:
--
--   SELECT string_agg(DISTINCT host, ',') FROM ( ...the query above... ) q
--   WHERE needs = 'add to POSTHOG_ALLOWED_ORIGINS';

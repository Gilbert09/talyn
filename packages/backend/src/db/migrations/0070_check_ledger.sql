-- pr_check_states becomes the per-commit check LEDGER.
--
-- It used to hold only what check_run webhooks said, and nothing ever corrected
-- it. A completion that never arrived (a flush that threw after the delivery was
-- acked, a replay, a restart mid-window) left a row `pending` for good, and every
-- later check event on the commit recounted from it — so a pill the full fetch
-- had just fixed went back to "1/232 running" (PostHog/posthog#104122).
--
-- Now every complete GraphQL fetch reseeds the ledger for its head, and the
-- verdict is derived from it — which needs what a webhook cannot say:
--   required   GitHub's per-PR required-ness (NULL = not known yet)
--   raw_state  GitHub's own conclusion/state (FAILURE vs ERROR vs TIMED_OUT) —
--              a Visual Review that found changes needs a person; one that
--              errored is CI's problem
--   url        where the check lives, so a human gate can link to it
-- All nullable: rows written before this read as "unknown", never as a value.
ALTER TABLE pr_check_states ADD COLUMN IF NOT EXISTS required boolean;
ALTER TABLE pr_check_states ADD COLUMN IF NOT EXISTS raw_state text;
ALTER TABLE pr_check_states ADD COLUMN IF NOT EXISTS url text;

-- Drop the inbox feature. The prioritized "inbox" of PR items needing
-- attention (new reviews/comments/CI failures/merge-ready) has been removed
-- from the app entirely, along with the per-PR "unread updates" badges that
-- read from this table. PR-event detection still runs in prCache (cursor
-- columns on pull_requests), it just no longer materializes inbox rows.
--
-- CASCADE clears the RLS policy + indexes defined on the table.
DROP TABLE IF EXISTS "inbox_items" CASCADE;

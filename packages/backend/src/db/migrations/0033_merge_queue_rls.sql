-- HOTFIX: merge_queue_entries/events were shipped RLS-enabled with no
-- policies and no authenticated GRANT (0031 wrongly followed the
-- billing_events "pool-only" pattern). But these tables ARE touched from
-- request context — the enqueue route's dual-write, the list endpoint's v2
-- decoration, and the timeline endpoint — where withOwnerScope (db/scope.ts)
-- has dropped the transaction to the `authenticated` role. The first touch
-- raised `permission denied`, which ABORTED the whole request transaction and
-- cascaded 25P02 ("current transaction is aborted") onto every later query in
-- the request — surfacing as "Failed query: select … from pull_requests" in
-- the desktop's PR sheet. Prod incident 2026-07-16 ~13:00 UTC.
--
-- Fix: the standard workspace-owner policy + GRANTs, exactly like
-- pull_requests (0013 + 0024). Events chain ownership through their entry.
GRANT SELECT, INSERT, UPDATE, DELETE ON "merge_queue_entries" TO "authenticated";
--> statement-breakpoint
GRANT SELECT, INSERT ON "merge_queue_events" TO "authenticated";
--> statement-breakpoint
-- bigserial INSERTs call nextval() — without this the events insert 42501s.
GRANT USAGE, SELECT ON SEQUENCE "merge_queue_events_id_seq" TO "authenticated";
--> statement-breakpoint
CREATE POLICY "merge_queue_entries_workspace" ON "merge_queue_entries" FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text));
--> statement-breakpoint
CREATE POLICY "merge_queue_events_entry" ON "merge_queue_events" FOR ALL
  USING (entry_id IN (
    SELECT id FROM merge_queue_entries
    WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text)
  ))
  WITH CHECK (entry_id IN (
    SELECT id FROM merge_queue_entries
    WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = auth.uid()::text)
  ));

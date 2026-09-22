CREATE TABLE review_ranking_participants (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewer_login text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
--> statement-breakpoint
CREATE TABLE review_ranking_events (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  event text NOT NULL,
  snapshot_id text NOT NULL,
  session_id text NOT NULL,
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, event_id)
);
--> statement-breakpoint
CREATE INDEX review_ranking_events_time ON review_ranking_events (received_at);
CREATE INDEX review_ranking_events_snapshot ON review_ranking_events (workspace_id, user_id, snapshot_id);
--> statement-breakpoint
CREATE TABLE review_ranking_outcomes (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  review_id text NOT NULL,
  viewer_login text NOT NULL,
  repo text NOT NULL,
  pr_number integer NOT NULL,
  state text NOT NULL,
  created_at timestamptz,
  submitted_at timestamptz NOT NULL,
  last_checked_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, review_id)
);
--> statement-breakpoint
CREATE INDEX review_ranking_outcomes_time ON review_ranking_outcomes (submitted_at);
--> statement-breakpoint
ALTER TABLE review_ranking_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_ranking_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_ranking_outcomes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON review_ranking_participants, review_ranking_events, review_ranking_outcomes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON review_ranking_participants, review_ranking_events, review_ranking_outcomes TO talyn_backend;
--> statement-breakpoint
CREATE POLICY review_ranking_participants_owner ON review_ranking_participants FOR ALL
  USING (user_id = public.talyn_uid() AND workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()))
  WITH CHECK (user_id = public.talyn_uid() AND workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()));
CREATE POLICY review_ranking_events_owner ON review_ranking_events FOR ALL
  USING (user_id = public.talyn_uid() AND workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()))
  WITH CHECK (user_id = public.talyn_uid() AND workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()));
CREATE POLICY review_ranking_outcomes_owner ON review_ranking_outcomes FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()));

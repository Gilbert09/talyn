-- Scoring runs under the caller's role. Training keeps its pool connection.
ALTER TABLE review_rank_models ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON review_rank_models FROM PUBLIC, anon, authenticated;
GRANT SELECT ON review_rank_models TO talyn_backend;
--> statement-breakpoint
CREATE POLICY review_rank_models_owner_read ON review_rank_models
  FOR SELECT TO talyn_backend
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()));

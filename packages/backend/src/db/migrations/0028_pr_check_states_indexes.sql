-- Belt-and-braces: ensure the pr_check_states indexes exist. The `ON CONFLICT
-- (repo_full_name, head_sha, name)` upsert in checkCounts needs the unique index;
-- if 0027 created the table but (for any reason) not the index, the upsert fails
-- with 42P10. IF NOT EXISTS makes this a no-op when 0027 already created them.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_pr_check_states_repo_sha_name" ON "pr_check_states" USING btree ("repo_full_name","head_sha","name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pr_check_states_repo_sha" ON "pr_check_states" USING btree ("repo_full_name","head_sha");

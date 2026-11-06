ALTER TABLE workbench_chats ADD COLUMN resume_at timestamptz, ADD COLUMN resume_reason text, ADD COLUMN limit_count integer NOT NULL DEFAULT 0, ADD COLUMN resume_version integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX idx_workbench_chats_resume ON workbench_chats (resume_at) WHERE resume_at IS NOT NULL;

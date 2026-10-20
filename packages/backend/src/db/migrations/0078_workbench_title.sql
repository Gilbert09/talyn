-- A session's display title: written by a cheap model from the first message,
-- or set by a person. Null means "show the name". It is display only: the
-- name stays, because it named the branch and the local worktree directory.
ALTER TABLE "workbenches" ADD COLUMN IF NOT EXISTS "title" text;

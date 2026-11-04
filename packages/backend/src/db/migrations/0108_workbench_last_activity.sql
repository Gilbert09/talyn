-- The newest activity the chat tables do not show: terminal input, a script
-- start, a restore. The idle-archive sweep reads the greater of this and the
-- chats' own timestamps (see services/workbenches/idleArchive.ts).
--
-- Null means no such activity. No backfill: the sweep falls back to created_at
-- and the chats, and workbenches.updated_at is not a signal (status polling
-- and diff refreshes write it).
ALTER TABLE "workbenches" ADD COLUMN IF NOT EXISTS "last_activity_at" timestamp with time zone;

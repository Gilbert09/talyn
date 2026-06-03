-- Per-workspace logo: either an auto-generated identicon ({kind:'identicon',
-- seed}) or a user-uploaded, downscaled image ({kind:'image', dataUrl}).
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "logo" jsonb;

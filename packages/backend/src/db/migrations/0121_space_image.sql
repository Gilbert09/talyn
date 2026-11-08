-- An optional image for a space, shown in place of its colour tile. It is a
-- downscaled raster `data:image/...` URL, stored inline like `workspaces.logo`
-- (0019). The route caps its length. `spaces` stays backend-pool-only (0116).
ALTER TABLE "spaces" ADD COLUMN IF NOT EXISTS "image" text;

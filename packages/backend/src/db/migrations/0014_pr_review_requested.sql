-- Track PRs the connected user is a requested reviewer on (not just
-- authored). The monitor now widens its watch list to include
-- review-requested PRs; this flag lets the GitHub page separate
-- "my PRs" from "PRs awaiting my review". Defaults false so existing
-- rows (all author-discovered) keep their meaning.
ALTER TABLE "pull_requests" ADD COLUMN "review_requested" boolean DEFAULT false NOT NULL;

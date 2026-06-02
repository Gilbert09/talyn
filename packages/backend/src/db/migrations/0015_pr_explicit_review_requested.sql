-- Track whether the connected user is *individually* requested as a
-- reviewer (GitHub's `user-review-requested:`), as opposed to being
-- pulled in only via a team request (`review-requested:` also matches
-- team membership). Lets the GitHub page keep an approved PR off the
-- "Review" list unless the user was explicitly asked — while a PR that
-- names them directly stays put even after it's approved. Defaults
-- false so existing rows keep their meaning until the next poll.
ALTER TABLE "pull_requests" ADD COLUMN "explicitly_review_requested" boolean DEFAULT false NOT NULL;

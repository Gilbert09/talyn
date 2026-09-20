-- The per-viewer review-ranking model: its training data, and its output.
--
-- Two tables rather than a key in `workspaces.settings`, deliberately. Settings
-- is hand-editable configuration a person owns; this is machine-generated,
-- versioned, per-VIEWER rather than per-workspace, and carries evaluation
-- metadata nobody would hand-write. It is also merged wholesale by
-- `mergedSettingsSql`, which is the wrong write semantics for a blob a trainer
-- replaces atomically.
--
-- `review_history` is backfilled once per viewer from their own GitHub review
-- history — two GraphQL searches, capped, ~10% of one hour's point budget — and
-- maintained incrementally thereafter from the `reviews(last: 5)` the poll
-- already fetches for every tracked PR and used to discard.
--
-- Note what is NOT here: any record of a PR's STATE at review time. GitHub does
-- not retain it, and "now" for a merged PR is green, mergeable and approved by
-- definition — so a state column would be filled with an artefact of merging
-- and the model would learn that green checks cause reviews. State stays in the
-- deterministic rules (see packages/shared/src/prPriority.ts).
CREATE TABLE IF NOT EXISTS "review_history" (
  "workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  -- The GitHub login whose history this is. Per-VIEWER, not per-workspace: two
  -- people in one workspace have entirely different reviewing habits, and
  -- averaging them would produce a model that describes neither.
  "viewer_login" text NOT NULL,
  "repo_full_name" text NOT NULL,
  "pr_number" integer NOT NULL,
  "author_login" text NOT NULL,
  -- When the viewer was asked, and when (or whether) they answered.
  -- `reviewed_at IS NULL` with a `closed_at` in the past is the NEGATIVE class:
  -- a request that stood until the PR closed and was never serviced.
  "requested_at" timestamptz,
  "reviewed_at" timestamptz,
  "closed_at" timestamptz,
  -- Whether the request named the viewer directly or reached them via a team.
  -- Stored but NOT a learned feature: GitHub clears an individual request once
  -- you review, so the negative class skews toward team requests and a learned
  -- weight here would fit an artefact of how the labels are collected. It stays
  -- a deterministic rule instead.
  "direct" boolean NOT NULL DEFAULT false,
  "additions" integer,
  "deletions" integer,
  -- Top-level directories the PR touched, for the path-familiarity feature.
  "dirs" text[] NOT NULL DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "viewer_login", "repo_full_name", "pr_number")
);

-- The trainer's read: every row for one viewer, ordered by when they answered.
CREATE INDEX IF NOT EXISTS "idx_review_history_viewer"
  ON "review_history" ("workspace_id", "viewer_login", "reviewed_at");

-- One model per viewer. Replaced wholesale by each retrain.
CREATE TABLE IF NOT EXISTS "review_rank_models" (
  "workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "viewer_login" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  -- The five weights, in REVIEW_RANK_FEATURES order, plus the per-feature mean
  -- and sd the client needs to standardise a live PR the same way the fit did.
  "weights" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "feature_stats" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The aggregates the features are computed FROM: per-author gave/got counts,
  -- per-directory counts, per-repo share. Shipped to the client whole, because
  -- scoring is client-side — the ordering re-runs on every keystroke in the
  -- filter box and cannot be a round-trip.
  "profile" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "n_events" integer NOT NULL DEFAULT 0,
  -- Held-out pairwise accuracy of the fit, and of the hand-set prior it has to
  -- beat. Stored even on a REFUSAL: "we looked and it was not worth it" is a
  -- fact with evidence attached, and it is how we find out whether this whole
  -- limb earned its place.
  "cv_accuracy" real,
  "baseline_accuracy" real,
  "installed" boolean NOT NULL DEFAULT false,
  "refused_because" text,
  "trained_at" timestamptz NOT NULL DEFAULT now(),
  -- When the one-time history backfill last completed, so it is not re-run.
  "backfilled_at" timestamptz,
  PRIMARY KEY ("workspace_id", "viewer_login")
);

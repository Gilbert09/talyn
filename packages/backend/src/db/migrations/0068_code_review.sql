-- Code review: AI findings on a pull request, shown in the app rather than
-- posted on the PR.
--
-- Four tables, and the reason they are tables rather than columns on
-- `pull_requests` is the reason `workflows` is a table and a saved PR filter is
-- not: a review has a RUN LOG. Several agents read the diff through different
-- lenses, one sweeps for what they all missed, one judges what survives, and
-- every one of those can fail on its own and be retried on its own.
--
-- Why not `tasks` rows for the units, which is the obvious answer: three guards
-- make it impossible, and all three are correct for tasks. `activePrTaskId`
-- refuses a second active task on a pull request (it exists because three
-- concurrent runs on one PR once filled a user's plan cap). `findReusableTask`
-- collapses to one row per (workspace, repo, PR, type) and REWRITES it. And
-- `withTaskLimitGate` counts every task against the free plan's three, whose own
-- comment is that the limit has no back door. A review's lens units are machine
-- work, not the user's work, so they live here and the free plan meters review
-- CYCLES instead.
--
-- THE TWO SHA COLUMNS ARE NOT REDUNDANT. `target_head_sha` is what the cycle in
-- flight is reading; `reviewed_head_sha` is what the findings on screen belong
-- to. With one column, starting a re-review overwrites the provenance of the
-- list the user is looking at, and the app cannot say "showing findings for
-- abc1234, now reviewing def5678".
CREATE TABLE IF NOT EXISTS "pr_code_reviews" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "repository_id" text NOT NULL,
  "pull_request_id" text NOT NULL,
  -- WHICH ATTEMPT THIS IS, and half of the unit claim key below.
  --
  -- The direct analogue of `loops.scheduled_for`. Without it a second cycle's
  -- unit rows collide with the first cycle's on the claim index forever, so a
  -- review that failed could never be retried — the insert-as-claim would find
  -- the old row and "finish" it. Bumped in the same CAS that starts a cycle.
  "cycle" integer DEFAULT 0 NOT NULL,
  -- quick | standard | deep. Plain text with no CHECK, like `tasks.status`: a
  -- new preset is a shared-package change and must not need a migration.
  "preset" text DEFAULT 'standard' NOT NULL,
  -- The preset's RESOLVED shape, frozen at cycle start rather than re-read.
  -- Same argument as `metadata.internetAccess` riding on a task: the preset
  -- table can change in a release while a cycle is in flight, and a cycle must
  -- finish as the thing it started as.
  "lens_keys" jsonb,
  "sweep" boolean DEFAULT false NOT NULL,
  "validate" boolean DEFAULT false NOT NULL,
  "chunk_total" integer DEFAULT 1 NOT NULL,
  -- THE PROGRESS DENOMINATOR, and the one count that is persisted.
  --
  -- Stored because it is a DECISION (lenses x chunks + sweep + judge, taken at
  -- cycle start from the preset) and not an aggregate. Finding counts are the
  -- opposite and are deliberately absent: `loops/store.ts` states the rule —
  -- a stored count drifts the first time a write path forgets to bump it — so
  -- severity counts come from one grouped count(*) over the open-findings index.
  "runs_total" integer DEFAULT 0 NOT NULL,
  "phase" text DEFAULT 'idle' NOT NULL,
  "phase_started_at" timestamp with time zone,
  "target_head_sha" text DEFAULT '' NOT NULL,
  "reviewed_head_sha" text DEFAULT '' NOT NULL,
  -- Whether this cycle was started by the clock rather than a person, and
  -- whether this PR is armed for that. Auto-review of every new PR is an
  -- Unlimited feature, gated on the OFF->ON transition like the auto-keep
  -- workspace default.
  "auto" boolean DEFAULT false NOT NULL,
  "auto_enabled" boolean DEFAULT false NOT NULL,
  -- The fix run, which IS an ordinary pr_response task on purpose: that way it
  -- inherits `activePrTaskId` and cannot push to the same branch as a
  -- merge-queue fix run at the same time.
  "fix_task_id" text,
  "fix_started_at" timestamp with time zone,
  "started_by" text,
  "last_error" text,
  "last_error_at" timestamp with time zone,
  -- The reconciler's staleness cue: a non-terminal review nobody has evaluated
  -- lately is one whose evaluation was lost to a deploy or a crash.
  "last_evaluated_at" timestamp with time zone,
  -- THE CAS COLUMN. Every phase write is conditional on it, which is what makes
  -- concurrent evaluations safe without an advisory lock. The merge queue
  -- REMOVED its lock because it pinned a pool connection across GitHub calls and
  -- starved the pooler; do not reintroduce one here.
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pr_code_reviews_workspace_id_fk" FOREIGN KEY ("workspace_id")
    REFERENCES "workspaces"("id") ON DELETE cascade,
  CONSTRAINT "pr_code_reviews_repository_id_fk" FOREIGN KEY ("repository_id")
    REFERENCES "repositories"("id") ON DELETE cascade,
  CONSTRAINT "pr_code_reviews_pull_request_id_fk" FOREIGN KEY ("pull_request_id")
    REFERENCES "pull_requests"("id") ON DELETE cascade,
  CONSTRAINT "pr_code_reviews_fix_task_id_fk" FOREIGN KEY ("fix_task_id")
    REFERENCES "tasks"("id") ON DELETE set null,
  CONSTRAINT "pr_code_reviews_started_by_fk" FOREIGN KEY ("started_by")
    REFERENCES "users"("id") ON DELETE set null
);
--> statement-breakpoint
-- One living review per pull request. A re-review bumps `cycle` on this row
-- rather than inserting a second, so the findings, their dismissals and their
-- history all stay in one place across commits.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_pr_code_reviews_pr"
  ON "pr_code_reviews" USING btree ("pull_request_id");
--> statement-breakpoint
-- The free plan's "one review-and-fix cycle at a time" count, and the
-- per-workspace pacing read.
--
-- `ready` is deliberately OUTSIDE the active set: a review resting with findings
-- on screen holds no slot, and only `fixing` puts the cycle back in flight. That
-- is what makes one gate cover "review and fix" rather than needing two.
CREATE INDEX IF NOT EXISTS "idx_pr_code_reviews_active"
  ON "pr_code_reviews" USING btree ("workspace_id")
  WHERE "phase" NOT IN ('idle', 'ready', 'failed', 'cancelled');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pr_code_reviews_stale"
  ON "pr_code_reviews" USING btree ("last_evaluated_at")
  WHERE "phase" NOT IN ('idle', 'ready', 'failed', 'cancelled');
--> statement-breakpoint
-- The `task:status` trigger's reverse lookup when a fix run settles.
CREATE INDEX IF NOT EXISTS "idx_pr_code_reviews_fix_task"
  ON "pr_code_reviews" USING btree ("fix_task_id")
  WHERE "fix_task_id" IS NOT NULL;
--> statement-breakpoint

-- One row per agent run a review spends: a lens, the sweep, the judge, or a
-- repair of a unit whose JSON would not parse.
CREATE TABLE IF NOT EXISTS "pr_code_review_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "review_id" text NOT NULL,
  -- Carried rather than joined for: the per-workspace concurrent-unit ceiling is
  -- read immediately before every dispatch, and a join to reach the workspace
  -- would put `pr_code_reviews` on that hot path for nothing.
  "workspace_id" text NOT NULL,
  "cycle" integer NOT NULL,
  -- lens | sweep | validate | repair
  "kind" text NOT NULL,
  -- NOT NULL WITH AN EMPTY SENTINEL, and this is load-bearing rather than
  -- tidiness. Postgres treats NULLs as distinct in a unique index, so a nullable
  -- `lens` in the claim key below would dedupe nothing at all and every
  -- evaluation pass would boot another sweep.
  "lens" text DEFAULT '' NOT NULL,
  "chunk_index" integer DEFAULT 0 NOT NULL,
  "chunk_total" integer DEFAULT 1 NOT NULL,
  -- claimed | dispatching | running | parsing | succeeded | failed | cancelled | skipped
  "status" text DEFAULT 'claimed' NOT NULL,
  -- capacity_deferred | dispatch_lost | timeout | unparseable | run_vanished |
  -- no_provider | dispatch_failed
  "failure_code" text,
  "provider" text,
  "model" text,
  "sandbox_id" text,
  "remote_task_id" text,
  "remote_run_id" text,
  -- Which fleet host took it. An authorization input, not a label: that host
  -- asks us for the run's credentials back after a restart, and the answer is
  -- only given to the host the run was dispatched to.
  "host" text,
  "endpoint" text,
  -- THE DURABLE READ CURSOR into the fleet's event log.
  --
  -- The task poller keeps this in memory, which is fine for a task because the
  -- transcript is persisted anyway. A review unit persists no transcript (see
  -- below), so a restart mid-cycle must be able to resume reading rather than
  -- re-emit from zero or lose the unit's output entirely.
  "event_cursor" integer DEFAULT 0 NOT NULL,
  "finding_count" integer DEFAULT 0 NOT NULL,
  -- How many times this unit's output would not parse. One repair is allowed and
  -- then the unit fails: a review that loses one lens is still a review, and a
  -- review that spends unbounded runs chasing a malformed brace is a bill.
  "parse_attempts" integer DEFAULT 0 NOT NULL,
  -- The parse failure and an excerpt of what would not parse. Big enough to be
  -- worth keeping out of every list projection.
  "parse_error" text,
  "cost_usd" numeric(10, 4),
  -- NULL SEPARATES "NEVER GOT A SANDBOX" FROM "HAD ONE AND IT IS GONE", which is
  -- exactly what `loop_runs.dispatched_at` separates. Without it the orphan
  -- reaper kills the second case five minutes late and under the wrong name.
  "dispatched_at" timestamp with time zone,
  "settled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pr_code_review_runs_review_id_fk" FOREIGN KEY ("review_id")
    REFERENCES "pr_code_reviews"("id") ON DELETE cascade,
  CONSTRAINT "pr_code_review_runs_workspace_id_fk" FOREIGN KEY ("workspace_id")
    REFERENCES "workspaces"("id") ON DELETE cascade
);
--> statement-breakpoint
-- THE CONCURRENCY DESIGN, and the same trick `idx_loop_runs_slot` uses.
--
-- The row is INSERTED BEFORE the sandbox is created, so the insert is the claim:
-- a unique violation means another replica (or this one, re-entering after a
-- crash) already owns this unit. The loser re-reads the conflicting row and
-- finishes it rather than starting a second run. No advisory lock in the fire
-- path, no distributed dedupe cache.
--
-- There is no `attempt` column in this key, and that is deliberate. The task
-- path needs one because a `tasks` row is reused and the fleet create is
-- idempotent on the sandbox id, so a reused task asked for an id its previous
-- run already held. A review retry inserts a NEW row with a fresh uuid, so its
-- sandbox id is unique by construction — the one place this design is simpler
-- than the task path.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_pr_code_review_runs_claim"
  ON "pr_code_review_runs" USING btree ("review_id", "cycle", "kind", "lens", "chunk_index");
--> statement-breakpoint
-- The fan-in: "is every lens of this cycle settled yet?"
CREATE INDEX IF NOT EXISTS "idx_pr_code_review_runs_active"
  ON "pr_code_review_runs" USING btree ("review_id", "cycle", "status")
  WHERE "status" IN ('claimed', 'dispatching', 'running', 'parsing');
--> statement-breakpoint
-- The per-workspace concurrent-unit ceiling, and the "units we fired in the last
-- twenty seconds" correction the fleet capacity check needs (hosts report every
-- ~15s, so a unit dispatched just now is invisible in `runsLive`).
CREATE INDEX IF NOT EXISTS "idx_pr_code_review_runs_ws_inflight"
  ON "pr_code_review_runs" USING btree ("workspace_id", "dispatched_at")
  WHERE "status" IN ('dispatching', 'running', 'parsing');
--> statement-breakpoint
-- The poller's sweep and the deadline reaper.
CREATE INDEX IF NOT EXISTS "idx_pr_code_review_runs_inflight"
  ON "pr_code_review_runs" USING btree ("dispatched_at")
  WHERE "status" IN ('dispatching', 'running', 'parsing');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pr_code_review_runs_sandbox"
  ON "pr_code_review_runs" USING btree ("sandbox_id")
  WHERE "sandbox_id" IS NOT NULL;
--> statement-breakpoint

-- What the review actually found. The product's whole output.
CREATE TABLE IF NOT EXISTS "pr_code_review_findings" (
  "id" text PRIMARY KEY NOT NULL,
  "review_id" text NOT NULL,
  "workspace_id" text NOT NULL,
  "pull_request_id" text NOT NULL,
  -- THE CARRY-FORWARD KEY. See the unique index below for what it is made of
  -- and, more importantly, what it deliberately leaves out.
  "dedupe_key" text NOT NULL,
  -- blocker | major | minor | nit
  "severity" text NOT NULL,
  "category" text DEFAULT '' NOT NULL,
  -- WHICH LENSES REPORTED IT, as a list, because agreement is a signal.
  -- Two lenses independently flagging one missing null check is ONE finding
  -- with two lenses and a seen count of 2 — not two rows saying the same thing,
  -- which is the noisiest failure a multi-lens reviewer has.
  "lenses" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "file_path" text DEFAULT '' NOT NULL,
  "line_start" integer,
  "line_end" integer,
  -- The verbatim source the finding is about, supplied by the agent. It is what
  -- lets the dedupe key survive a rebase, since every line number moves.
  "anchor" text,
  -- Whether that anchor was actually found in the file at the reviewed sha. A
  -- false here means the agent paraphrased — or invented the path, which is the
  -- most common review-agent failure and worth the one file read to catch.
  "anchor_verified" boolean DEFAULT false NOT NULL,
  "title" text NOT NULL,
  -- The two big columns. Excluded from every list projection: forty findings of
  -- body-plus-suggestion is a few hundred kilobytes, and neither the PR list
  -- decoration nor a websocket broadcast has any use for them.
  "body" text DEFAULT '' NOT NULL,
  "suggestion" text,
  "confidence" integer,
  -- The judge's verdict: unvalidated | confirmed | rejected | uncertain. Resets
  -- to unvalidated when the finding carries forward, because the old verdict was
  -- about the old code.
  "verdict" text DEFAULT 'unvalidated' NOT NULL,
  "verdict_reason" text,
  "validated_by_run_id" text,
  "source_run_id" text,
  "first_seen_head_sha" text DEFAULT '' NOT NULL,
  "last_seen_head_sha" text DEFAULT '' NOT NULL,
  "first_seen_cycle" integer DEFAULT 0 NOT NULL,
  "last_seen_cycle" integer DEFAULT 0 NOT NULL,
  "seen_count" integer DEFAULT 1 NOT NULL,
  -- open | selected | dismissed | fixed | stale | discarded
  --
  -- `dismissed` is STICKY across cycles, the way `review_hidden_at` is sticky:
  -- a user who said no must not be asked again every time a commit lands, or the
  -- dismiss button means nothing. `fixed` and `stale` are not — a finding whose
  -- key reappears goes back to `open`, which is how the app can say "it came
  -- back" instead of quietly claiming a fix that did not hold.
  "disposition" text DEFAULT 'open' NOT NULL,
  -- Why the user dismissed it, from a fixed set of four. Kept because "which
  -- lens is wrong most often" is the first question anybody asks about finding
  -- quality, and it cannot be answered retrospectively.
  "dismissed_reason" text,
  "disposition_at" timestamp with time zone,
  "disposition_by" text,
  "fix_task_id" text,
  "fixed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pr_code_review_findings_review_id_fk" FOREIGN KEY ("review_id")
    REFERENCES "pr_code_reviews"("id") ON DELETE cascade,
  CONSTRAINT "pr_code_review_findings_workspace_id_fk" FOREIGN KEY ("workspace_id")
    REFERENCES "workspaces"("id") ON DELETE cascade,
  CONSTRAINT "pr_code_review_findings_pull_request_id_fk" FOREIGN KEY ("pull_request_id")
    REFERENCES "pull_requests"("id") ON DELETE cascade,
  CONSTRAINT "pr_code_review_findings_validated_by_run_id_fk" FOREIGN KEY ("validated_by_run_id")
    REFERENCES "pr_code_review_runs"("id") ON DELETE set null,
  CONSTRAINT "pr_code_review_findings_source_run_id_fk" FOREIGN KEY ("source_run_id")
    REFERENCES "pr_code_review_runs"("id") ON DELETE set null,
  CONSTRAINT "pr_code_review_findings_disposition_by_fk" FOREIGN KEY ("disposition_by")
    REFERENCES "users"("id") ON DELETE set null,
  CONSTRAINT "pr_code_review_findings_fix_task_id_fk" FOREIGN KEY ("fix_task_id")
    REFERENCES "tasks"("id") ON DELETE set null
);
--> statement-breakpoint
-- THE CARRY-FORWARD MECHANISM. An upsert on this key is what makes a re-review
-- at a new commit MERGE into the finding that is already there — preserving the
-- user's dismissal and the history — rather than producing a second row that
-- says the same thing.
--
-- The key is hash(normalised path | slugged title | hash(collapsed anchor)), and
-- what it leaves out matters more than what it contains:
--   * NOT the lens, so cross-lens agreement merges instead of duplicating.
--   * NOT the line numbers, because surviving a rebase is the whole point.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_pr_code_review_findings_dedupe"
  ON "pr_code_review_findings" USING btree ("review_id", "dedupe_key");
--> statement-breakpoint
-- The severity counts the badge, the row chip and the sheet header all read, and
-- the merge-queue park's "is there an unresolved blocker" question.
CREATE INDEX IF NOT EXISTS "idx_pr_code_review_findings_open"
  ON "pr_code_review_findings" USING btree ("review_id", "severity")
  WHERE "disposition" IN ('open', 'selected');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pr_code_review_findings_fix_task"
  ON "pr_code_review_findings" USING btree ("fix_task_id")
  WHERE "fix_task_id" IS NOT NULL;
--> statement-breakpoint

-- The audit log, a mirror of `merge_queue_events` and for the same reason: every
-- phase transition appends its row IN THE SAME TRANSACTION as the transition, so
-- the timeline cannot lie about what happened.
CREATE TABLE IF NOT EXISTS "pr_code_review_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "review_id" text NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "from_phase" text,
  "to_phase" text NOT NULL,
  -- What caused it: 'user:start', 'poller:unit_settled', 'task:terminal',
  -- 'reconcile', 'executor', 'webhook:pr_synchronize'.
  "trigger" text NOT NULL,
  -- A stable machine code — 'unit_claimed', 'unit_fired', 'capacity_deferred',
  -- 'findings_ingested', 'deferred_task_limit', 'new_head_reset'.
  "code" text,
  "message" text DEFAULT '' NOT NULL,
  "detail" jsonb,
  CONSTRAINT "pr_code_review_events_review_id_fk" FOREIGN KEY ("review_id")
    REFERENCES "pr_code_reviews"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pr_code_review_events_review"
  ON "pr_code_review_events" USING btree ("review_id", "at");
--> statement-breakpoint

-- RLS, in the post-0057 form and only that form.
--
-- `talyn_backend` and `public.talyn_uid()`, NEVER `authenticated` and
-- `auth.uid()`: 0057 moved the backend to its own role, repointed every policy,
-- and ASSERTS that no policy still calls `auth.uid()`. Copying an older
-- migration's block here would fail that assertion the next time it ran.
--
-- Omitting either the enable or the grant is a production incident, not a
-- cosmetic slip: `ownerScope` drops to `talyn_backend`, an RLS-enabled table
-- with no policy (or no grant) raises permission denied, and that aborts the
-- request transaction and cascades 25P02 over every later statement in it.
ALTER TABLE "pr_code_reviews" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pr_code_review_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pr_code_review_findings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "pr_code_review_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "pr_code_reviews" TO talyn_backend;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "pr_code_review_runs" TO talyn_backend;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "pr_code_review_findings" TO talyn_backend;
--> statement-breakpoint
-- Append-only, so no DELETE. The history has to outlive the thing it describes.
GRANT SELECT, INSERT ON TABLE "pr_code_review_events" TO talyn_backend;
--> statement-breakpoint
-- A bigserial needs its sequence too, exactly as `merge_queue_events` does. A
-- grant on the table alone leaves every insert failing on the sequence.
GRANT USAGE, SELECT ON SEQUENCE "pr_code_review_events_id_seq" TO talyn_backend;
--> statement-breakpoint
CREATE POLICY "pr_code_reviews_workspace" ON "pr_code_reviews" FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()));
--> statement-breakpoint
-- Runs and findings carry `workspace_id` of their own, so their policy is the
-- direct subquery rather than a chain through the review. Cheaper, and the
-- column is already there for the ceiling count.
CREATE POLICY "pr_code_review_runs_workspace" ON "pr_code_review_runs" FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()));
--> statement-breakpoint
CREATE POLICY "pr_code_review_findings_workspace" ON "pr_code_review_findings" FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()));
--> statement-breakpoint
-- The audit log has no workspace column — it chains through its review, the way
-- `loop_runs` chains through its loop.
CREATE POLICY "pr_code_review_events_review" ON "pr_code_review_events" FOR ALL
  USING (review_id IN (
    SELECT id FROM pr_code_reviews
    WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid())
  ))
  WITH CHECK (review_id IN (
    SELECT id FROM pr_code_reviews
    WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid())
  ));
--> statement-breakpoint
-- Prove the grants landed, the way 0057 and 0059 prove their own. A grant that
-- silently did nothing must not read as a successful migration.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO missing
  FROM unnest(ARRAY[
    'public.pr_code_reviews', 'public.pr_code_review_runs',
    'public.pr_code_review_findings', 'public.pr_code_review_events'
  ]) AS t
  WHERE NOT has_table_privilege('talyn_backend', t, 'SELECT');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'talyn_backend did not receive SELECT on: %', missing;
  END IF;
END $$;

-- Two additive tables for session turns.
--
-- workbench_turn_timings: where one turn spent its time (tests, installs,
-- builds, services, waiting, git, reading, other tool calls, model time) and
-- its slowest calls. Written once when the turn ends, so the time report never
-- reads the transcript again. Commands in `slowest` are shortened and have
-- secrets replaced.
--
-- repository_setup_steps: the setup recipe of a repository. Steps learned from
-- session tool calls, or recorded by an agent, that later boxes and the
-- repository bake run after the repository's own setup. One row per distinct
-- command (step_key is its hash). A reverted step keeps its row with
-- disabled_at set, so it is not learned again. applied_at is set when the step
-- goes into the bake; bake_disabled_at when it failed there.
--
-- Backend-pool-only, like workspace_memories (0096): RLS on with NO policy and
-- no talyn_backend grant. The routes authorise first.
CREATE TABLE IF NOT EXISTS "workbench_turn_timings" (
	"chat_id" text NOT NULL REFERENCES "workbench_chats"("id") ON DELETE CASCADE,
	"turn" integer NOT NULL,
	"workbench_id" text NOT NULL REFERENCES "workbenches"("id") ON DELETE CASCADE,
	"wall_ms" bigint NOT NULL,
	"tool_ms" bigint NOT NULL,
	"model_ms" bigint NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"categories" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"slowest" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workbench_turn_timings_pkey" PRIMARY KEY ("chat_id", "turn")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workbench_turn_timings_workbench" ON "workbench_turn_timings" USING btree ("workbench_id", "created_at");
--> statement-breakpoint
ALTER TABLE "workbench_turn_timings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "workbench_turn_timings" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "repository_setup_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"repository_id" text NOT NULL REFERENCES "repositories"("id") ON DELETE CASCADE,
	"step_key" text NOT NULL,
	"ordinal" bigserial NOT NULL,
	"command" text NOT NULL,
	-- `SetupStepKind` and `SetupStepPhase` in packages/shared/src/setupRecipe.ts.
	"kind" text NOT NULL,
	"phase" text NOT NULL,
	"why" text,
	-- 'learned' | 'agent'.
	"source" text NOT NULL,
	-- No foreign key: the step stays when its session is deleted.
	"source_workbench_id" text,
	"seen_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	"bake_disabled_at" timestamp with time zone,
	"bake_disabled_reason" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_repository_setup_steps_key" ON "repository_setup_steps" USING btree ("repository_id", "step_key");
--> statement-breakpoint
ALTER TABLE "repository_setup_steps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "repository_setup_steps" FROM PUBLIC, anon, authenticated;

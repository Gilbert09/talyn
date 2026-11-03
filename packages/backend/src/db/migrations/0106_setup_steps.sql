-- The Setup list (layered sandbox images, plan §10.1 and §10.2).
--
-- setup_steps: ONE ordered list of setup steps per repository, and one list
-- per workspace (repository_id NULL: Settings → Sandbox setup). It replaces
-- three stores:
--   - repositories.settings.bake: the person's image steps. They become rows
--     with origin 'user', run_on 'image', status 'active', in their order.
--     bake.hosts goes to repositories.settings.setupHosts.
--   - repository_setup_steps: the learned and agent steps. Same ids, same
--     counters. phase install -> run_on image, start -> box. Status:
--     disabled_at -> dismissed, box_disabled_at -> disabled,
--     confirmed_at -> active (accepted_by 'talyn'), else suggested.
--     applied_at -> image_applied_at, bake_disabled_* -> image_failed_*.
--   - repository_setup_step_sessions keeps its rows. Its foreign key now
--     points at setup_steps, which has the same ids.
--
-- The learned rows go after the bake rows in the order the box ran them
-- before (the kind order of `orderSetupSteps`, then the order they were
-- learned in), so a box runs the same steps in the same order.
--
-- No behaviour changes: the steps a new box runs and the steps in the image
-- are the same before and after (setupLayersMigration.test.ts).
--
-- repositories.settings.bake and repository_setup_steps are left in place,
-- not written any more, for one release. A later migration drops them.
--
-- Every statement can run again: deterministic ids and ON CONFLICT DO NOTHING.
--
-- Backend-pool-only, like repository_setup_steps (0099): RLS on with NO
-- policy and no talyn_backend grant. The routes authorise first.
CREATE TABLE IF NOT EXISTS "setup_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	-- NULL: a workspace step.
	"repository_id" text REFERENCES "repositories"("id") ON DELETE CASCADE,
	"position" integer NOT NULL,
	-- The dedupe key of a learned step (sha256 of kind and command). '' for a person's step.
	"step_key" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"command" text NOT NULL,
	-- `SetupStepKind`, 'other' for a person's step.
	"kind" text NOT NULL,
	-- 'image' | 'box' | 'both'.
	"run_on" text NOT NULL,
	-- 'user' | 'learned' | 'agent'.
	"origin" text NOT NULL,
	-- 'active' | 'suggested' | 'dismissed' | 'disabled'.
	"status" text NOT NULL,
	"status_reason" text,
	"status_changed_at" timestamp with time zone,
	-- 'person' | 'talyn' | NULL. Talyn removes only what Talyn accepted.
	"accepted_by" text,
	"timeout_sec" integer,
	"why" text,
	-- No foreign key: the step stays when its session is deleted.
	"source_workbench_id" text,
	"seen_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"session_count" integer DEFAULT 0 NOT NULL,
	"confirmed_at" timestamp with time zone,
	"image_applied_at" timestamp with time zone,
	"image_failed_at" timestamp with time zone,
	"image_failure_reason" text,
	"box_failure_count" integer DEFAULT 0 NOT NULL,
	"box_last_failure" text,
	"last_duration_ms" integer,
	"typical_duration_ms" integer,
	"measured_boxes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_setup_steps_key" ON "setup_steps" USING btree ("workspace_id", coalesce("repository_id", ''), "step_key") WHERE "step_key" <> '';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_setup_steps_repository" ON "setup_steps" USING btree ("repository_id", "position");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_setup_steps_workspace" ON "setup_steps" USING btree ("workspace_id", "position") WHERE "repository_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "setup_steps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "setup_steps" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
-- 1. The person's bake steps, in order.
INSERT INTO "setup_steps" (
	"id", "workspace_id", "repository_id", "position", "step_key", "name", "command", "kind", "run_on",
	"origin", "status", "accepted_by", "timeout_sec", "seen_count", "image_applied_at", "first_seen_at",
	"last_seen_at", "created_at", "updated_at"
)
SELECT
	'st_' || substr(md5('bake:' || r."id" || ':' || (s.ord - 1)::text), 1, 20),
	r."workspace_id",
	r."id",
	(s.ord - 1)::int,
	'',
	coalesce(nullif(s.step ->> 'name', ''), 'Step ' || s.ord::text),
	coalesce(s.step ->> 'run', ''),
	'other',
	'image',
	'user',
	'active',
	'person',
	CASE WHEN jsonb_typeof(s.step -> 'timeoutSec') = 'number' THEN (s.step ->> 'timeoutSec')::int END,
	0,
	now(),
	now(),
	now(),
	now(),
	now()
FROM "repositories" r
CROSS JOIN LATERAL jsonb_array_elements(
	CASE WHEN jsonb_typeof(r."settings" -> 'bake' -> 'steps') = 'array' THEN r."settings" -> 'bake' -> 'steps' ELSE '[]'::jsonb END
) WITH ORDINALITY AS s(step, ord)
WHERE jsonb_typeof(s.step) = 'object' AND coalesce(s.step ->> 'run', '') <> ''
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "repositories"
SET "settings" = "settings" || jsonb_build_object('setupHosts', "settings" -> 'bake' -> 'hosts')
WHERE jsonb_typeof("settings" -> 'bake' -> 'hosts') = 'array' AND NOT ("settings" ? 'setupHosts');
--> statement-breakpoint
-- 2. The learned and agent steps, after the bake steps, in the box's old order.
INSERT INTO "setup_steps" (
	"id", "workspace_id", "repository_id", "position", "step_key", "name", "command", "kind", "run_on",
	"origin", "status", "status_reason", "status_changed_at", "accepted_by", "why", "source_workbench_id",
	"seen_count", "first_seen_at", "last_seen_at", "session_count", "confirmed_at", "image_applied_at",
	"image_failed_at", "image_failure_reason", "box_failure_count", "box_last_failure", "last_duration_ms",
	"typical_duration_ms", "measured_boxes", "created_at", "updated_at"
)
SELECT
	s."id",
	r."workspace_id",
	s."repository_id",
	(
		SELECT count(*)::int FROM jsonb_array_elements(
			CASE WHEN jsonb_typeof(r."settings" -> 'bake' -> 'steps') = 'array' THEN r."settings" -> 'bake' -> 'steps' ELSE '[]'::jsonb END
		) b(step) WHERE jsonb_typeof(b.step) = 'object' AND coalesce(b.step ->> 'run', '') <> ''
	) + (row_number() OVER (
		PARTITION BY s."repository_id"
		ORDER BY coalesce(array_position(ARRAY[
			'installer', 'rustup', 'apt', 'brew', 'cargo', 'go', 'gem', 'pip', 'uv', 'node', 'download',
			'env', 'docker', 'service', 'compose', 'database', 'other'
		]::text[], s."kind"), 99), s."ordinal"
	) - 1)::int,
	s."step_key",
	CASE WHEN length(regexp_replace(btrim(s."command"), '\s+', ' ', 'g')) > 120
		THEN left(regexp_replace(btrim(s."command"), '\s+', ' ', 'g'), 119) || '…'
		ELSE regexp_replace(btrim(s."command"), '\s+', ' ', 'g') END,
	s."command",
	s."kind",
	CASE WHEN s."phase" = 'start' THEN 'box' ELSE 'image' END,
	s."source",
	CASE
		WHEN s."disabled_at" IS NOT NULL THEN 'dismissed'
		WHEN s."box_disabled_at" IS NOT NULL THEN 'disabled'
		WHEN s."confirmed_at" IS NOT NULL THEN 'active'
		ELSE 'suggested'
	END,
	CASE
		WHEN s."disabled_at" IS NOT NULL THEN s."disabled_reason"
		WHEN s."box_disabled_at" IS NOT NULL THEN s."box_disabled_reason"
	END,
	coalesce(s."disabled_at", s."box_disabled_at", s."confirmed_at"),
	CASE WHEN s."confirmed_at" IS NOT NULL THEN 'talyn' END,
	s."why",
	s."source_workbench_id",
	s."seen_count",
	s."first_seen_at",
	s."last_seen_at",
	s."session_count",
	s."confirmed_at",
	s."applied_at",
	s."bake_disabled_at",
	s."bake_disabled_reason",
	s."box_failure_count",
	s."box_last_failure",
	s."last_duration_ms",
	s."typical_duration_ms",
	s."measured_boxes",
	s."first_seen_at",
	now()
FROM "repository_setup_steps" s
JOIN "repositories" r ON r."id" = s."repository_id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- 3. The sessions table points at the new rows. Same ids, so no row moves.
ALTER TABLE "repository_setup_step_sessions" DROP CONSTRAINT IF EXISTS "repository_setup_step_sessions_step_id_fkey";
--> statement-breakpoint
ALTER TABLE "repository_setup_step_sessions" DROP CONSTRAINT IF EXISTS "repository_setup_step_sessions_step_id_setup_steps_fk";
--> statement-breakpoint
DELETE FROM "repository_setup_step_sessions" ss WHERE NOT EXISTS (SELECT 1 FROM "setup_steps" s WHERE s."id" = ss."step_id");
--> statement-breakpoint
ALTER TABLE "repository_setup_step_sessions" ADD CONSTRAINT "repository_setup_step_sessions_step_id_setup_steps_fk"
	FOREIGN KEY ("step_id") REFERENCES "setup_steps"("id") ON DELETE CASCADE;

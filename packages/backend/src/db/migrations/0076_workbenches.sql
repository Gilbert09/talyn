-- Workbenches: one branch of one repository, with a long-running agent chat,
-- a live diff, a terminal, scripts and checkpoints. See docs/WORKBENCHES.md.
--
-- Four tables. The transcript is its own APPEND-ONLY table and never a growing
-- jsonb column on the chat row: rewriting a multi-megabyte `tasks.transcript`
-- on every event is the disk-IO lesson this schema does not repeat.
CREATE TABLE IF NOT EXISTS "workbenches" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "repository_id" text NOT NULL,
  -- `owner/name`, denormalised so a list renders without a repository join.
  "repo_full_name" text NOT NULL,
  "name" text NOT NULL,
  "branch" text NOT NULL,
  "base_branch" text NOT NULL,
  -- 'sandbox' | 'local'. Plain text with no CHECK, like `tasks.status`.
  "runtime" text NOT NULL,
  -- 'claude' | 'codex'. FIXED at creation for a sandbox workbench: the
  -- sandbox's egress route table is built from its LLM vendor.
  "agent" text NOT NULL,
  -- The model a new chat starts on, when the create named one.
  "model" text,
  "device_id" text,
  "local_path" text,
  "sandbox_id" text,
  "sandbox_state" text DEFAULT 'none' NOT NULL,
  -- WHICH FLEET HOST took the sandbox. An authorization input, exactly as on a
  -- task: a host that restarts asks for the box's credentials back, and the
  -- answer is given only to the host the box was created on.
  "fleet_host" text,
  "status" text DEFAULT 'provisioning' NOT NULL,
  -- Why the status is what it is, in words a person can act on. Null when
  -- there is nothing to say.
  "status_message" text,
  "pull_request_id" text,
  "settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "diff_stat" jsonb,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workbenches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id")
    REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "workbenches_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id")
    REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action,
  -- SET NULL: a PR row can be removed (an untracked repo) while the branch and
  -- its chats are still worth keeping.
  CONSTRAINT "workbenches_pull_request_id_pull_requests_id_fk" FOREIGN KEY ("pull_request_id")
    REFERENCES "public"."pull_requests"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workbenches_workspace"
  ON "workbenches" USING btree ("workspace_id", "created_at" DESC);
--> statement-breakpoint
-- A name is unique per workspace among LIVE workbenches. An archived one keeps
-- its name for the history, and must not stop a new workbench reusing it.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workbenches_workspace_name_live"
  ON "workbenches" USING btree ("workspace_id", "name") WHERE "archived_at" IS NULL;
--> statement-breakpoint
-- The credential pull's lookup: a fleet sandbox id back to its workbench.
CREATE INDEX IF NOT EXISTS "idx_workbenches_sandbox"
  ON "workbenches" USING btree ("sandbox_id") WHERE "sandbox_id" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workbench_chats" (
  "id" text PRIMARY KEY NOT NULL,
  "workbench_id" text NOT NULL,
  -- Denormalised from the workbench, so the RLS policy and the WS emit need no
  -- join. The code-review tables carry theirs for the same reason.
  "workspace_id" text NOT NULL,
  "title" text NOT NULL,
  "agent" text NOT NULL,
  "model" text,
  "effort" text,
  "plan_mode" boolean DEFAULT false NOT NULL,
  -- The CLI's own session id (`--resume` / `codex exec resume`).
  "agent_session_id" text,
  -- 'idle' | 'running' | 'awaiting_input' | 'error'.
  "status" text DEFAULT 'idle' NOT NULL,
  "status_message" text,
  -- Messages sent while a turn was running. A sandbox exec has no stdin, so
  -- they wait here and are drained in order when the turn ends. Bounded by
  -- what a person types during one turn, never by the transcript.
  "queued_messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- How many turns this chat has started. The next turn is `turn_count + 1`.
  "turn_count" integer DEFAULT 0 NOT NULL,
  -- THE SEQ ALLOCATOR. The last `workbench_events.seq` handed out for this
  -- chat. An append bumps it and inserts its rows in ONE statement, so the
  -- row lock that bump takes orders concurrent appends by commit, and a reader
  -- paging by `seq` can never see a later seq before an earlier one.
  "next_seq" bigint DEFAULT 0 NOT NULL,
  -- A closed chat tab. Kept rather than deleted: its transcript and its
  -- checkpoints are still the history of the branch.
  "closed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workbench_chats_workbench_id_workbenches_id_fk" FOREIGN KEY ("workbench_id")
    REFERENCES "public"."workbenches"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workbench_chats_workbench"
  ON "workbench_chats" USING btree ("workbench_id", "created_at");
--> statement-breakpoint
-- The boot sweep's lookup: chats a dead process left `running`.
CREATE INDEX IF NOT EXISTS "idx_workbench_chats_running"
  ON "workbench_chats" USING btree ("status") WHERE "status" = 'running';
--> statement-breakpoint
-- The transcript. APPEND-ONLY: one row per event, never updated.
--
-- The primary key IS the paging index: `WHERE chat_id = $1 AND seq > $2
-- ORDER BY seq LIMIT n` reads the left edge of one btree range.
CREATE TABLE IF NOT EXISTS "workbench_events" (
  "chat_id" text NOT NULL,
  "seq" bigint NOT NULL,
  "turn" integer NOT NULL,
  "event" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workbench_events_pkey" PRIMARY KEY ("chat_id", "seq"),
  CONSTRAINT "workbench_events_chat_id_workbench_chats_id_fk" FOREIGN KEY ("chat_id")
    REFERENCES "public"."workbench_chats"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
-- A hidden commit per turn, under `refs/talyn/checkpoints/<chatId>/<turn>`.
CREATE TABLE IF NOT EXISTS "workbench_checkpoints" (
  "chat_id" text NOT NULL,
  "turn" integer NOT NULL,
  "ref" text NOT NULL,
  "sha" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "workbench_checkpoints_pkey" PRIMARY KEY ("chat_id", "turn"),
  CONSTRAINT "workbench_checkpoints_chat_id_workbench_chats_id_fk" FOREIGN KEY ("chat_id")
    REFERENCES "public"."workbench_chats"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint

-- RLS, in the post-0057 form only: `talyn_backend` and `public.talyn_uid()`.
-- Omitting the enable or the grant is a production incident: `ownerScope`
-- drops to `talyn_backend`, and a table with no policy or no grant aborts the
-- request transaction with 25P02 on every later statement.
ALTER TABLE "workbenches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workbench_chats" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workbench_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workbench_checkpoints" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "workbenches" TO talyn_backend;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "workbench_chats" TO talyn_backend;
--> statement-breakpoint
-- Append-only: no UPDATE. DELETE stays so removing a chat can cascade.
GRANT SELECT, INSERT, DELETE ON TABLE "workbench_events" TO talyn_backend;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "workbench_checkpoints" TO talyn_backend;
--> statement-breakpoint
CREATE POLICY "workbenches_workspace" ON "workbenches" FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()));
--> statement-breakpoint
CREATE POLICY "workbench_chats_workspace" ON "workbench_chats" FOR ALL
  USING (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()))
  WITH CHECK (workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid()));
--> statement-breakpoint
-- Events and checkpoints have no workspace column; they chain through their
-- chat, the way `loop_runs` chains through its loop.
CREATE POLICY "workbench_events_chat" ON "workbench_events" FOR ALL
  USING (chat_id IN (
    SELECT id FROM workbench_chats
    WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid())
  ))
  WITH CHECK (chat_id IN (
    SELECT id FROM workbench_chats
    WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid())
  ));
--> statement-breakpoint
CREATE POLICY "workbench_checkpoints_chat" ON "workbench_checkpoints" FOR ALL
  USING (chat_id IN (
    SELECT id FROM workbench_chats
    WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid())
  ))
  WITH CHECK (chat_id IN (
    SELECT id FROM workbench_chats
    WHERE workspace_id IN (SELECT id FROM workspaces WHERE owner_id = public.talyn_uid())
  ));
--> statement-breakpoint
-- Prove the grants landed, the way 0057 and 0068 prove their own.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(t, ', ') INTO missing
  FROM unnest(ARRAY[
    'public.workbenches', 'public.workbench_chats',
    'public.workbench_events', 'public.workbench_checkpoints'
  ]) AS t
  WHERE NOT has_table_privilege('talyn_backend', t, 'SELECT');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'talyn_backend did not receive SELECT on: %', missing;
  END IF;
END $$;

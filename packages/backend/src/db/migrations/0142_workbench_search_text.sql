-- workbench_search_text: the text of a transcript that a person can search
-- for (⌘K). One row for each user or assistant event that has text blocks:
-- the messages that people send and the prose of the agent. Stream deltas,
-- tool calls, tool output and thinking are not in it.
--
-- A trigger on workbench_events fills it, so every path that appends events
-- (the turn streamer, a local runtime upload, the archive note) feeds it. The
-- events from before this migration come from a backfill job
-- (services/workbenches/transcriptSearch.ts), not from this migration, because
-- that read is the whole transcript table.
--
-- tsv holds the words twice: as the parser reads them (uv.lock, a path) and
-- split at every other character (uv, lock), so a search finds either form.
--
-- Backend-pool-only, like workbench_turn_timings (0099): RLS on with NO policy.
-- The route authorises first. The trigger function is SECURITY DEFINER, so an
-- append under an owner scope can write the row.
CREATE OR REPLACE FUNCTION public.workbench_search_body(event jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT left(NULLIF(pg_catalog.btrim(pg_catalog.string_agg(b ->> 'text', E'\n')), ''), 20000)
  FROM pg_catalog.jsonb_array_elements(
    CASE pg_catalog.jsonb_typeof(event -> 'message' -> 'content')
      WHEN 'array' THEN event -> 'message' -> 'content'
      WHEN 'string' THEN pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('type', 'text', 'text', event -> 'message' ->> 'content'))
      ELSE '[]'::jsonb
    END
  ) AS b
  WHERE pg_catalog.jsonb_typeof(b) = 'object' AND b ->> 'type' = 'text'
$$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workbench_search_text" (
	"chat_id" text NOT NULL REFERENCES "workbench_chats"("id") ON DELETE CASCADE,
	"seq" bigint NOT NULL,
	"workbench_id" text NOT NULL REFERENCES "workbenches"("id") ON DELETE CASCADE,
	"workspace_id" text NOT NULL,
	"role" text NOT NULL,
	"body" text NOT NULL,
	"tsv" tsvector GENERATED ALWAYS AS (
		to_tsvector('simple'::regconfig, "body")
		|| to_tsvector('simple'::regconfig, regexp_replace("body", '[^[:alnum:]]+', ' ', 'g'))
	) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workbench_search_text_pkey" PRIMARY KEY ("chat_id", "seq")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workbench_search_text_tsv" ON "workbench_search_text" USING gin ("tsv");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workbench_search_text_workspace" ON "workbench_search_text" USING btree ("workspace_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workbench_search_text_workbench" ON "workbench_search_text" USING btree ("workbench_id");
--> statement-breakpoint
ALTER TABLE "workbench_search_text" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "workbench_search_text" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
CREATE FUNCTION public.workbench_search_index_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE body text := public.workbench_search_body(NEW.event);
BEGIN
  IF body IS NOT NULL THEN
    INSERT INTO public.workbench_search_text (chat_id, seq, workbench_id, workspace_id, role, body, created_at)
    SELECT NEW.chat_id, NEW.seq, c.workbench_id, c.workspace_id, NEW.event ->> 'type', body, NEW.created_at
    FROM public.workbench_chats c WHERE c.id = NEW.chat_id
    ON CONFLICT (chat_id, seq) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.workbench_search_index_event() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER workbench_search_index_event AFTER INSERT ON public.workbench_events
 FOR EACH ROW WHEN (NEW.event ->> 'type' IN ('user', 'assistant'))
 EXECUTE FUNCTION public.workbench_search_index_event();

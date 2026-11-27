CREATE TABLE "space_phone_notification_preferences" (
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "space_id" text NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "categories" jsonb NOT NULL,
  CONSTRAINT "space_phone_notification_preferences_pk" PRIMARY KEY ("user_id", "space_id")
);
--> statement-breakpoint
ALTER TABLE "space_phone_notification_preferences" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON "space_phone_notification_preferences" FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
-- A space can enable a category that the workspace disables by default.
-- The delivery worker checks the current preferences before it sends the alert.
CREATE OR REPLACE FUNCTION public.mobile_record_notification(
 recipient text, workspace text, category_value text, kind_value text, entity text, dedup text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE event_id text := gen_random_uuid()::text;
BEGIN
 INSERT INTO public.mobile_notification_source_events
 (id,owner_id,workspace_id,category,destination_kind,entity_id,deduplication_key)
 SELECT event_id,recipient,workspace,category_value,kind_value,entity,COALESCE(dedup,event_id)
 FROM public.mobile_notification_preferences p
 WHERE p.owner_id = recipient AND p.workspace_id = workspace
 AND p.preferences->>'enabled' = 'true'
 AND (
   p.preferences->'categories'->>category_value = 'true'
   OR EXISTS (
     SELECT 1 FROM public.space_phone_notification_preferences s
     WHERE s.user_id = recipient AND s.categories->>category_value = 'true'
     AND (
       EXISTS (
         SELECT 1 FROM public.workbenches b WHERE b.workspace_id = workspace AND b.space_id = s.space_id
         AND ((kind_value = 'pull_request' AND b.pull_request_id = entity)
           OR (kind_value <> 'pull_request' AND b.id = entity))
       )
       OR (kind_value = 'pull_request' AND EXISTS (
         SELECT 1 FROM public.tasks t
         WHERE t.workspace_id = workspace AND t.pull_request_id = entity AND t.space_id = s.space_id
       ))
     )
   )
 )
 ON CONFLICT(owner_id,deduplication_key) DO NOTHING;
END $$;

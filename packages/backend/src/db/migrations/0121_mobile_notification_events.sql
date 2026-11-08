-- Record transitions in the same transaction as their authoritative rows.
-- Existing binaries need no new calls. The journal contains no private text.
CREATE TABLE mobile_notification_source_events (
 id text PRIMARY KEY,
 owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 category text NOT NULL CHECK(category IN ('session_update','pr_review','ci_failure','merge_ready','human_gate')),
 destination_kind text NOT NULL CHECK(destination_kind IN ('session','thread','pull_request')),
 entity_id text NOT NULL,
 deduplication_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT uq_mobile_notification_source_events_dedup UNIQUE(owner_id,deduplication_key)
);
CREATE INDEX idx_mobile_notification_source_events_claim ON mobile_notification_source_events(created_at,id);
CREATE INDEX idx_mobile_notification_source_events_owner ON mobile_notification_source_events(owner_id,workspace_id);
ALTER TABLE mobile_notification_source_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mobile_notification_source_events FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.mobile_record_notification(
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
 AND p.preferences->'categories'->>category_value = 'true'
 ON CONFLICT(owner_id,deduplication_key) DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION public.mobile_record_notification(text,text,text,text,text,text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION public.mobile_chat_notification_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE recipient text; destination_kind text; session_workspace text;
BEGIN
 SELECT w.owner_id,b.kind,b.workspace_id INTO recipient,destination_kind,session_workspace
 FROM public.workbenches b JOIN public.workspaces w ON w.id = b.workspace_id
 WHERE b.id = NEW.workbench_id AND b.archived_at IS NULL;
 IF recipient IS NULL OR session_workspace <> NEW.workspace_id THEN RETURN NEW; END IF;
 IF NEW.status = 'idle' AND OLD.status = 'running'
 OR NEW.status = 'error' AND OLD.status IS DISTINCT FROM NEW.status THEN
   PERFORM public.mobile_record_notification(recipient,NEW.workspace_id,'session_update',destination_kind,NEW.workbench_id);
 END IF;
 IF NEW.status = 'awaiting_input' AND (
   OLD.status IS DISTINCT FROM NEW.status OR OLD.turn_count IS DISTINCT FROM NEW.turn_count
   OR OLD.status_message IS DISTINCT FROM NEW.status_message
 ) THEN
   PERFORM public.mobile_record_notification(recipient,NEW.workspace_id,'human_gate',destination_kind,NEW.workbench_id);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.mobile_chat_notification_transition() FROM PUBLIC;
CREATE TRIGGER mobile_chat_notification_transition AFTER UPDATE OF status,turn_count,status_message
 ON public.workbench_chats FOR EACH ROW EXECUTE FUNCTION public.mobile_chat_notification_transition();
--> statement-breakpoint
CREATE FUNCTION public.mobile_session_notification_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE recipient text;
BEGIN
 IF NEW.status IN ('error','archiveError') AND OLD.status IS DISTINCT FROM NEW.status AND NEW.archived_at IS NULL THEN
   SELECT owner_id INTO recipient FROM public.workspaces WHERE id = NEW.workspace_id;
   IF recipient IS NOT NULL THEN
     PERFORM public.mobile_record_notification(recipient,NEW.workspace_id,'session_update',NEW.kind,NEW.id);
   END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.mobile_session_notification_transition() FROM PUBLIC;
CREATE TRIGGER mobile_session_notification_transition AFTER UPDATE OF status
 ON public.workbenches FOR EACH ROW EXECUTE FUNCTION public.mobile_session_notification_transition();
--> statement-breakpoint
CREATE FUNCTION public.mobile_pr_notification_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE recipient text; previous jsonb := '{}'::jsonb; current jsonb := NEW.last_summary;
 previous_review boolean := false; previous_gates text; current_gates text;
BEGIN
 IF NEW.state <> 'open' OR NOT (NEW.authored OR NEW.watching OR NEW.review_requested) THEN RETURN NEW; END IF;
 SELECT owner_id INTO recipient FROM public.workspaces WHERE id = NEW.workspace_id;
 IF recipient IS NULL THEN RETURN NEW; END IF;
 IF TG_OP = 'UPDATE' THEN previous := OLD.last_summary; previous_review := OLD.review_requested; END IF;
 IF NEW.review_requested AND NOT previous_review
 OR TG_OP = 'UPDATE' AND current->>'reviewDecision' IN ('APPROVED','CHANGES_REQUESTED')
   AND previous->>'reviewDecision' IS DISTINCT FROM current->>'reviewDecision' THEN
   PERFORM public.mobile_record_notification(recipient,NEW.workspace_id,'pr_review','pull_request',NEW.id);
 END IF;
 -- First observations establish the baseline for checks and merge readiness.
 IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
 IF (current->>'ciStatus' = 'failing_required' OR current->>'blockingReason' = 'checks_failed')
 AND (previous->>'ciStatus' IS DISTINCT FROM current->>'ciStatus'
   OR previous->>'headSha' IS DISTINCT FROM current->>'headSha'
   OR previous->>'blockingReason' IS DISTINCT FROM current->>'blockingReason') THEN
   PERFORM public.mobile_record_notification(recipient,NEW.workspace_id,'ci_failure','pull_request',NEW.id,
     'ci:' || NEW.id || ':' || md5(COALESCE(current->>'headSha','unknown')));
 END IF;
 IF current->>'blockingReason' = 'mergeable' AND COALESCE(current->>'draft','false') <> 'true'
 AND (previous->>'blockingReason' IS DISTINCT FROM 'mergeable' OR previous->>'draft' = 'true') THEN
   PERFORM public.mobile_record_notification(recipient,NEW.workspace_id,'merge_ready','pull_request',NEW.id);
 END IF;
 IF jsonb_typeof(current->'humanGates') = 'array' AND jsonb_array_length(current->'humanGates') > 0 THEN
   SELECT md5(COALESCE(string_agg(g.value::text,',' ORDER BY g.value::text),'')) INTO current_gates
   FROM jsonb_array_elements(current->'humanGates') g;
   IF jsonb_typeof(previous->'humanGates') = 'array' THEN
     SELECT md5(COALESCE(string_agg(g.value::text,',' ORDER BY g.value::text),'')) INTO previous_gates
     FROM jsonb_array_elements(previous->'humanGates') g;
   END IF;
   IF previous_gates IS DISTINCT FROM current_gates OR previous->>'headSha' IS DISTINCT FROM current->>'headSha' THEN
     PERFORM public.mobile_record_notification(recipient,NEW.workspace_id,'human_gate','pull_request',NEW.id);
   END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.mobile_pr_notification_transition() FROM PUBLIC;
CREATE TRIGGER mobile_pr_notification_transition AFTER INSERT OR UPDATE OF state,last_summary,review_requested,authored,watching
 ON public.pull_requests FOR EACH ROW EXECUTE FUNCTION public.mobile_pr_notification_transition();
--> statement-breakpoint
CREATE FUNCTION public.mobile_merge_queue_notification_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE recipient text;
BEGIN
 IF NEW.status NOT IN ('blocked','blocked_manual') OR COALESCE(NEW.blocked_code,'') NOT IN ('agent_needs_human','code_review_blocker')
 THEN RETURN NEW; END IF;
 IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status
 AND OLD.blocked_code IS NOT DISTINCT FROM NEW.blocked_code
 AND OLD.blocked_reason IS NOT DISTINCT FROM NEW.blocked_reason
 AND OLD.head_sha IS NOT DISTINCT FROM NEW.head_sha THEN RETURN NEW; END IF;
 SELECT w.owner_id INTO recipient FROM public.pull_requests p JOIN public.workspaces w ON w.id = p.workspace_id
 WHERE p.id = NEW.pull_request_id AND p.workspace_id = NEW.workspace_id
 AND p.repository_id = NEW.repository_id AND p.state = 'open';
 IF recipient IS NOT NULL THEN
   PERFORM public.mobile_record_notification(recipient,NEW.workspace_id,'human_gate','pull_request',NEW.pull_request_id);
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.mobile_merge_queue_notification_transition() FROM PUBLIC;
CREATE TRIGGER mobile_merge_queue_notification_transition AFTER INSERT OR UPDATE OF status,blocked_code,blocked_reason,head_sha
 ON public.merge_queue_entries FOR EACH ROW EXECUTE FUNCTION public.mobile_merge_queue_notification_transition();
--> statement-breakpoint
-- Supabase can grant explicit privileges to its roles by default.
DO $$ DECLARE routine regprocedure; role_name text; BEGIN
 FOR role_name IN SELECT rolname FROM pg_roles
   WHERE rolname IN ('anon','authenticated','service_role','talyn_backend')
 LOOP
   EXECUTE format('REVOKE ALL ON public.mobile_notification_source_events FROM %I',role_name);
   FOR routine IN
     SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN (
       'mobile_record_notification','mobile_chat_notification_transition',
       'mobile_session_notification_transition','mobile_pr_notification_transition','mobile_merge_queue_notification_transition'
     )
   LOOP
     EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',routine,role_name);
   END LOOP;
 END LOOP;
END $$;

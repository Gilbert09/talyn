-- A turn that waits for a free sandbox goes back to the queue: the chat moves
-- from running to idle, and the head of its queue carries capacityWait. The
-- turn did not end, and each refused retry repeats the move. Only a real end
-- of a turn records a session update.
CREATE OR REPLACE FUNCTION public.mobile_chat_notification_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE recipient text; destination_kind text; session_workspace text;
BEGIN
 SELECT w.owner_id,b.kind,b.workspace_id INTO recipient,destination_kind,session_workspace
 FROM public.workbenches b JOIN public.workspaces w ON w.id = b.workspace_id
 WHERE b.id = NEW.workbench_id AND b.archived_at IS NULL;
 IF recipient IS NULL OR session_workspace <> NEW.workspace_id THEN RETURN NEW; END IF;
 IF NEW.status = 'idle' AND OLD.status = 'running' AND NEW.queued_messages -> 0 -> 'capacityWait' IS NULL
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

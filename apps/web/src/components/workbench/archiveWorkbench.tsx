import { workbenchDisplayName, type Workbench } from '@talyn/shared';
import { api } from '../../lib/api';
import { trackEvent } from '../../lib/analytics';
import { captureWorkbenchFailure } from '../../lib/workbenchAnalytics';
import { toast } from '../../stores/toast';
import { maybeHandleBillingLimit } from '../../stores/billing';
import { useWorkbenchStore } from '../../stores/workbenches';
import { ConfirmDialog } from '../ui/confirm-dialog';

/** Archive a session. `leave` clears the selection when the session is the open one. */
export async function archiveWorkbench(id: string, leave: boolean): Promise<boolean> {
  try {
    const wb = await api.workbenches.archive(id);
    trackEvent('session_archived', { workbench_id: id, kind: wb.kind ?? 'session', runtime: wb.runtime });
    useWorkbenchStore.getState().upsertWorkbench(wb);
    if (leave) useWorkbenchStore.getState().selectWorkbench(null);
    return true;
  } catch (err) {
    captureWorkbenchFailure('archive_session', err, id);
    toast.error('Could not archive the session', err instanceof Error ? err.message : undefined);
    return false;
  }
}

/** Restore an archived session. Shows its own error and returns null when the restore fails. */
export async function restoreWorkbench(workbench: Pick<Workbench, 'id'>): Promise<Workbench | null> {
  try {
    const wb = await api.workbenches.restore(workbench.id);
    trackEvent('session_restored', { workbench_id: workbench.id, kind: wb.kind ?? 'session', runtime: wb.runtime });
    useWorkbenchStore.getState().upsertWorkbench(wb);
    return wb;
  } catch (err) {
    captureWorkbenchFailure('restore_session', err, workbench.id);
    if (!maybeHandleBillingLimit(err, 'session_restore')) {
      toast.error('Could not restore the session', err instanceof Error ? err.message : undefined);
    }
    return null;
  }
}

export function ArchiveWorkbenchDialog({
  workbench,
  open,
  busy,
  onConfirm,
  onCancel,
}: {
  workbench: Pick<Workbench, 'name' | 'title'>;
  open: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      title={`Archive ${workbenchDisplayName(workbench)}?`}
      description="The session moves to History. The branch, its chats and any PR stay, and you can restore it later."
      confirmLabel="Archive"
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

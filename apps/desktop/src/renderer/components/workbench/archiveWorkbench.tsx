import { workbenchDisplayName, type Workbench } from '@talyn/shared';
import { getWorkbenchBridge } from '../../lib/workbenchBridge';
import { api } from '../../lib/api';
import { toast } from '../../stores/toast';
import { useWorkbenchStore } from '../../stores/workbenches';
import { ConfirmDialog } from '../ui/confirm-dialog';

/** Archive a session. `leave` clears the selection when the session is the open one. */
export async function archiveWorkbench(id: string, leave: boolean): Promise<boolean> {
  try {
    const wb = await api.workbenches.archive(id);
    useWorkbenchStore.getState().upsertWorkbench(wb);
    await getWorkbenchBridge()?.preview?.stop(id).catch(() => {
      toast.error('Could not stop the preview');
    });
    if (leave) useWorkbenchStore.getState().selectWorkbench(null);
    return true;
  } catch (err) {
    toast.error('Could not archive the session', err instanceof Error ? err.message : undefined);
    return false;
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

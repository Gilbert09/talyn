import { useEffect, useRef, useState } from 'react';
import { WORKBENCH_MANUAL_TITLE_MAX, workbenchDisplayName, type Workbench } from '@talyn/shared';
import { api } from '../../lib/api';
import { trackEvent } from '../../lib/analytics';
import { isThread } from '../../lib/threads';
import { captureWorkbenchFailure } from '../../lib/workbenchAnalytics';
import { useWorkbenchStore } from '../../stores/workbenches';
import { toast } from '../../stores/toast';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';

function currentTitle(workbench: Workbench): string {
  return workbenchDisplayName(useWorkbenchStore.getState().workbenches[workbench.id] ?? workbench);
}

async function saveTitle(workbench: Workbench, raw: string) {
  const next = raw.trim();
  const store = useWorkbenchStore.getState();
  const previous = store.workbenches[workbench.id] ?? workbench;
  if (!next || next === workbenchDisplayName(previous)) return;

  store.upsertWorkbench({ ...previous, title: next });
  try {
    store.upsertWorkbench(await api.workbenches.update(workbench.id, { title: next }));
    trackEvent('session_renamed', { workbench_id: workbench.id });
  } catch (err) {
    const current = useWorkbenchStore.getState().workbenches[workbench.id];
    if (current?.title === next) store.upsertWorkbench({ ...current, title: previous.title });
    captureWorkbenchFailure('rename_session', err, workbench.id);
    toast.error('Could not rename the session', err instanceof Error ? err.message : undefined);
  }
}

/**
 * Two ways to rename: `start` edits the title in place (double-click on the
 * header), and `openDialog` asks in a modal. Menus use the modal, because a
 * closing menu moves focus and an in-place input loses it at once.
 */
export function useRenameSession(workbench: Workbench) {
  const [editing, setEditing] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [title, setTitle] = useState('');
  const finished = useRef(false);
  const dialogInput = useRef<HTMLInputElement>(null);

  // Not autoFocus: the menu that opens the dialog still traps focus while the
  // dialog mounts, so focus the input one tick later, after the menu has gone.
  useEffect(() => {
    if (!dialogOpen) return undefined;
    const timer = setTimeout(() => dialogInput.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [dialogOpen]);

  const start = () => {
    finished.current = false;
    setTitle(currentTitle(workbench));
    setEditing(true);
  };

  const cancel = () => {
    finished.current = true;
    setEditing(false);
  };

  const commit = async () => {
    if (finished.current) return;
    finished.current = true;
    setEditing(false);
    await saveTitle(workbench, title);
  };

  const openDialog = () => {
    setTitle(currentTitle(workbench));
    setDialogOpen(true);
  };

  const closeDialog = () => setDialogOpen(false);

  const submitDialog = () => {
    setDialogOpen(false);
    void saveTitle(workbench, title);
  };

  const input = (
    <input
      autoFocus
      aria-label="Session title"
      maxLength={WORKBENCH_MANUAL_TITLE_MAX}
      value={title}
      onChange={(event) => setTitle(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') void commit();
        if (event.key === 'Escape') cancel();
      }}
      className="app-region-no-drag min-w-0 flex-1 rounded border bg-background px-1 text-sm outline-none"
    />
  );

  const noun = isThread(workbench) ? 'thread' : 'session';
  const dialog = (
    <Dialog open={dialogOpen} onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent
        role="dialog"
        aria-modal="true"
        aria-labelledby={`rename-${workbench.id}-title`}
        onClose={closeDialog}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') closeDialog();
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitDialog();
          }}
        >
          <DialogHeader>
            <DialogTitle id={`rename-${workbench.id}-title`}>Rename {noun}</DialogTitle>
          </DialogHeader>
          <Input
            ref={dialogInput}
            aria-label="Session title"
            maxLength={WORKBENCH_MANUAL_TITLE_MAX}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={closeDialog}>Cancel</Button>
            <Button type="submit" size="sm" disabled={!title.trim()}>Rename</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );

  return { editing, start, input, openDialog, dialog };
}

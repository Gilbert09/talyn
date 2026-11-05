import { useRef, useState } from 'react';
import { WORKBENCH_MANUAL_TITLE_MAX, workbenchDisplayName, type Workbench } from '@talyn/shared';
import { api } from '../../lib/api';
import { trackEvent } from '../../lib/analytics';
import { captureWorkbenchFailure } from '../../lib/workbenchAnalytics';
import { useWorkbenchStore } from '../../stores/workbenches';
import { toast } from '../../stores/toast';

export function useRenameSession(workbench: Workbench) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const finished = useRef(false);

  const start = () => {
    finished.current = false;
    setTitle(workbenchDisplayName(useWorkbenchStore.getState().workbenches[workbench.id] ?? workbench));
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
    const next = title.trim();
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

  return { editing, start, input };
}

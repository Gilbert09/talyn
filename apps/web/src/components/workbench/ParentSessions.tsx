import { useEffect, useMemo, useState } from 'react';
import { workbenchDisplayName, type Workbench } from '@talyn/shared';
import { api } from '../../lib/api';
import { useNavigationStore } from '../../stores/navigation';
import { useWorkbenchStore } from '../../stores/workbenches';
import { useWorkspaceStore } from '../../stores/workspace';
import { SessionRow } from './WorkPanel';

export function ParentSessions({ workbench }: { workbench: Workbench }) {
  const enabled = useWorkspaceStore((s) => s.features?.sessionSubagents === true);
  return enabled ? <Relationships workbench={workbench} /> : null;
}

function Relationships({ workbench }: { workbench: Workbench }) {
  const rows = useWorkbenchStore((s) => s.workbenches);
  const navigate = useNavigationStore((s) => s.navigate);
  const [error, setError] = useState(false);
  const parent = workbench.parentId ? rows[workbench.parentId] : undefined;
  const children = useMemo(() => Object.values(rows).filter((row) => row.parentId === workbench.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [rows, workbench.id]);
  useEffect(() => {
    let disposed = false;
    setError(false);
    const upsert = (row: Workbench) => { if (!disposed) useWorkbenchStore.getState().upsertWorkbench(row); };
    void api.workbenches.threadSessions(workbench.id).then((items) => items.forEach(upsert)).catch(() => { if (!disposed) setError(true); });
    if (workbench.parentId) void api.workbenches.get(workbench.parentId).then(upsert).catch(() => undefined);
    return () => { disposed = true; };
  }, [workbench.id, workbench.parentId]);
  return <div className="flex flex-wrap items-start gap-2 px-3 pb-2">
    {workbench.parentId ? <button type="button" className="rounded bg-muted px-2 py-1 text-xs hover:bg-accent"
      onClick={() => navigate({ view: 'workbench', id: workbench.parentId! })}>
      Parent: {parent ? workbenchDisplayName(parent) : 'Open parent session'}
    </button> : null}
    {children.length > 0 ? <details className="min-w-64 rounded border p-2 text-xs">
      <summary className="cursor-pointer">Sessions started ({children.length})</summary>
      <ul aria-label="Sessions started" className="max-h-60 overflow-y-auto pt-2">
        {children.map((child) => <SessionRow key={child.id} session={child} />)}
      </ul>
    </details> : null}
    {error ? <span role="status" className="text-xs text-muted-foreground">Could not load child sessions.</span> : null}
  </div>;
}

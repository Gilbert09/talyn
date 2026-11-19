import { useEffect, useMemo, useState } from 'react';
import { CornerLeftUp, Network } from 'lucide-react';
import { workbenchDisplayName, type Workbench } from '@talyn/shared';
import { api } from '../../lib/api';
import { useNavigationStore } from '../../stores/navigation';
import { useWorkbenchStore } from '../../stores/workbenches';
import { useWorkspaceStore } from '../../stores/workspace';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { SessionRow } from './WorkPanel';

const CHIP =
  'app-region-no-drag inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground';

/** Header chips for a session's parent session and the sessions it started. */
export function ParentSessions({ workbench }: { workbench: Workbench }) {
  const enabled = useWorkspaceStore((s) => s.features?.sessionSubagents === true);
  return enabled ? <Relationships workbench={workbench} /> : null;
}

function Relationships({ workbench }: { workbench: Workbench }) {
  const rows = useWorkbenchStore((s) => s.workbenches);
  const navigate = useNavigationStore((s) => s.navigate);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const parent = workbench.parentId ? rows[workbench.parentId] : undefined;
  const children = useMemo(() => Object.values(rows).filter((row) => row.parentId === workbench.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [rows, workbench.id]);
  useEffect(() => {
    let disposed = false;
    setError(false);
    setOpen(false);
    const upsert = (row: Workbench) => { if (!disposed) useWorkbenchStore.getState().upsertWorkbench(row); };
    void api.workbenches.threadSessions(workbench.id).then((items) => items.forEach(upsert)).catch(() => { if (!disposed) setError(true); });
    if (workbench.parentId) void api.workbenches.get(workbench.parentId).then(upsert).catch(() => undefined);
    return () => { disposed = true; };
  }, [workbench.id, workbench.parentId]);
  const parentName = parent ? workbenchDisplayName(parent) : 'the parent session';
  const count = `${children.length} ${children.length === 1 ? 'session' : 'sessions'}`;
  return <>
    {workbench.parentId ? <button type="button" className={CHIP} data-attr="session-open-parent"
      title={`Started by ${parentName}. Open the parent session`} aria-label={`Open the parent session ${parentName}`}
      onClick={() => navigate({ view: 'workbench', id: workbench.parentId! })}>
      <CornerLeftUp className="h-3 w-3 shrink-0" />
      <span>Started by</span>
      <span className="max-w-[10rem] truncate text-foreground/70">{parentName}</span>
    </button> : null}
    {children.length > 0 ? <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={CHIP} data-attr="session-started-sessions"
          title={`This session started ${count}. Show them`} aria-label={`Show the ${count} this session started`}>
          <Network className="h-3 w-3 shrink-0" />
          {count}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-1.5">
        <div className="px-1.5 pb-1 pt-0.5 text-[11px] font-medium text-muted-foreground">
          Sessions started ({children.length})
        </div>
        <ul aria-label="Sessions started" className="max-h-80 overflow-y-auto"
          onClick={(event) => { if ((event.target as HTMLElement).closest('button')) setOpen(false); }}>
          {children.map((child) => <SessionRow key={child.id} session={child} />)}
        </ul>
      </PopoverContent>
    </Popover> : null}
    {error ? <span role="status" className="shrink-0 text-[10px] text-muted-foreground">Could not load sessions</span> : null}
  </>;
}

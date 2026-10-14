import { useMemo, useState } from 'react';
import { Archive, Cloud, Laptop, Loader2, RotateCcw } from 'lucide-react';
import type { Workbench } from '@talyn/shared';
import { api } from '../lib/api';
import { toast } from '../stores/toast';
import { useWorkbenchStore } from '../stores/workbenches';
import { useNavigationStore } from '../stores/navigation';
import { Button } from '../components/ui/button';
import { isArchived, useWorkspaceWorkbenches } from '../components/workbench/workbenchSelectors';

/**
 * Archived workbenches, newest first, each with Restore. A thin page: the
 * list is the one the shell loads, archived rows included.
 */
export function HistoryView() {
  const all = useWorkspaceWorkbenches();
  const listLoaded = useWorkbenchStore((s) => s.listLoaded);
  const listError = useWorkbenchStore((s) => s.listError);
  const archived = useMemo(
    () =>
      all
        .filter(isArchived)
        .sort((a, b) => (b.archivedAt ?? b.updatedAt).localeCompare(a.archivedAt ?? a.updatedAt)),
    [all]
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b px-6 py-3">
        <h1 className="text-base font-semibold">History</h1>
        <p className="text-xs text-muted-foreground">Archived workbenches. Restore one to open it again.</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {!listLoaded ? (
          <div className="flex items-center gap-2 px-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : archived.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center text-sm text-muted-foreground">
            <Archive className="h-6 w-6" />
            {listError ?? 'Nothing archived yet.'}
          </div>
        ) : (
          <ul className="divide-y">
            {archived.map((wb) => (
              <HistoryRow key={wb.id} workbench={wb} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function HistoryRow({ workbench }: { workbench: Workbench }) {
  const [busy, setBusy] = useState(false);
  const RuntimeIcon = workbench.runtime === 'local' ? Laptop : Cloud;
  const restore = async () => {
    setBusy(true);
    try {
      const wb = await api.workbenches.restore(workbench.id);
      useWorkbenchStore.getState().upsertWorkbench(wb);
      useNavigationStore.getState().navigate({ view: 'workbench', id: wb.id });
    } catch (err) {
      toast.error('Could not restore the workbench', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex items-center gap-3 px-2 py-2 text-[13px]">
      <RuntimeIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{workbench.name}</div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {workbench.repoFullName} · {workbench.branch}
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 text-xs"
        onClick={() => void restore()}
        disabled={busy}
        aria-label={`Restore ${workbench.name}`}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
        Restore
      </Button>
    </li>
  );
}

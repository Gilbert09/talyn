import { useMemo, useState } from 'react';
import { Archive, ArrowRight, Cloud, Laptop, Loader2, RotateCcw, Search, Trash2 } from 'lucide-react';
import { workbenchDisplayName, type Workbench } from '@talyn/shared';
import { api } from '../lib/api';
import { toast } from '../stores/toast';
import { useWorkbenchStore } from '../stores/workbenches';
import { useNavigationStore } from '../stores/navigation';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { PrPill } from '../components/workbench/WorkbenchBadges';
import { isArchived, useWorkspaceWorkbenches } from '../components/workbench/workbenchSelectors';

export function archivedAtOf(wb: Workbench): string {
  return wb.archivedAt ?? wb.updatedAt;
}

/** "3d ago" style; coarse on purpose, the tooltip carries the exact date. */
export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function filterAndGroupArchived(all: Workbench[], query: string): Array<{ repo: string; items: Workbench[] }> {
  const q = query.trim().toLowerCase();
  const rows = all
    .filter(isArchived)
    .filter((wb) => !q || [workbenchDisplayName(wb), wb.name, wb.branch, wb.repoFullName].some((s) => s.toLowerCase().includes(q)))
    .sort((a, b) => archivedAtOf(b).localeCompare(archivedAtOf(a)));
  const map = new Map<string, Workbench[]>();
  for (const wb of rows) {
    const list = map.get(wb.repoFullName);
    if (list) list.push(wb);
    else map.set(wb.repoFullName, [wb]);
  }
  // Repositories ordered by their newest archived workbench, matching the row order.
  return [...map.entries()].map(([repo, items]) => ({ repo, items }));
}

/** Archived workbenches grouped by repository, newest first. */
export function HistoryView() {
  const all = useWorkspaceWorkbenches();
  const listLoaded = useWorkbenchStore((s) => s.listLoaded);
  const listError = useWorkbenchStore((s) => s.listError);
  const [query, setQuery] = useState('');
  const [pendingDelete, setPendingDelete] = useState<Workbench | null>(null);
  const [deleting, setDeleting] = useState(false);
  const groups = useMemo(() => filterAndGroupArchived(all, query), [all, query]);
  const totalArchived = useMemo(() => all.filter(isArchived).length, [all]);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.workbenches.remove(pendingDelete.id);
      useWorkbenchStore.getState().removeWorkbench(pendingDelete.id);
      setPendingDelete(null);
    } catch (err) {
      toast.error('Could not delete the session', err instanceof Error ? err.message : undefined);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="app-region-drag flex shrink-0 items-center gap-3 border-b px-4 py-2">
        <h1 className="text-[13px] font-semibold">History</h1>
        <div className="relative ml-auto w-64 max-w-full">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, branch or repo"
            aria-label="Search archived sessions"
            className="h-7 pl-7 text-[13px]"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {!listLoaded ? (
          <div className="flex items-center gap-2 px-2 py-4 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center text-[13px] text-muted-foreground">
            <Archive className="h-6 w-6" />
            {listError ?? (totalArchived === 0 ? 'Nothing archived yet.' : 'No archived session matches your search.')}
          </div>
        ) : (
          groups.map((g) => (
            <section key={g.repo} className="mb-3">
              <h2 className="px-2 py-1 font-mono text-[11px] font-medium text-muted-foreground">{g.repo}</h2>
              <ul className="divide-y rounded-md border">
                {g.items.map((wb) => (
                  <HistoryRow key={wb.id} workbench={wb} onDelete={() => setPendingDelete(wb)} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete ${pendingDelete?.name ?? 'session'}?`}
        description="This removes the session and its chats for good. The branch on GitHub is not touched."
        confirmLabel="Delete"
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

function HistoryRow({ workbench, onDelete }: { workbench: Workbench; onDelete: () => void }) {
  const [busy, setBusy] = useState(false);
  const RuntimeIcon = workbench.runtime === 'local' ? Laptop : Cloud;
  const at = archivedAtOf(workbench);
  const restore = async () => {
    setBusy(true);
    try {
      const wb = await api.workbenches.restore(workbench.id);
      useWorkbenchStore.getState().upsertWorkbench(wb);
      useNavigationStore.getState().navigate({ view: 'workbench', id: wb.id });
    } catch (err) {
      toast.error('Could not restore the session', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };
  const retry = async () => {
    setBusy(true);
    try {
      const wb = await api.workbenches.archive(workbench.id);
      useWorkbenchStore.getState().upsertWorkbench(wb);
    } catch (err) {
      toast.error('Could not save the session', err instanceof Error ? err.message : undefined);
    } finally { setBusy(false); }
  };
  return (
    <li className="flex items-center gap-3 px-3 py-2 text-[13px]">
      <RuntimeIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={`${workbench.runtime} runtime`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{workbenchDisplayName(workbench)}</span>
          {workbench.pr && <PrPill number={workbench.pr.number} state={workbench.pr.state} />}
        </div>
        <div className="flex items-center gap-1 truncate font-mono text-[11px] text-muted-foreground">
          <span className="truncate">{workbench.branch}</span>
          <ArrowRight className="h-3 w-3 shrink-0" />
          <span className="truncate">{workbench.baseBranch}</span>
        </div>
      </div>
      {workbench.status === 'archiveError' && (
        <div className="max-w-sm text-xs text-destructive">
          <p>{workbench.statusMessage}</p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void retry()}>Retry</Button>
        </div>
      )}
      <span className="shrink-0 text-[11px] text-muted-foreground" title={new Date(at).toLocaleString()}>
        {relativeTime(at)}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 text-xs"
        onClick={() => void restore()}
        disabled={busy}
        aria-label={`Restore ${workbenchDisplayName(workbench)}`}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
        Restore
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
        onClick={onDelete}
        disabled={busy}
        aria-label={`Delete ${workbenchDisplayName(workbench)}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}

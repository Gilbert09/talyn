import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Cloud, Laptop, Loader2, Plus, RotateCcw } from 'lucide-react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { api } from '../../lib/api';
import { toast } from '../../stores/toast';
import { usePullRequestStore } from '../../stores/pullRequests';
import { useWorkbenchStore } from '../../stores/workbenches';
import { groupByRepository } from './workbenchSelectors';

/**
 * The left column: live workbenches grouped by repository, then a collapsed
 * Archived section with a restore button per row.
 */
export function WorkbenchSidebar({ workbenches }: { workbenches: Workbench[] }) {
  const selectedId = useWorkbenchStore((s) => s.selectedWorkbenchId);
  const select = useWorkbenchStore((s) => s.selectWorkbench);
  const openNewDialog = useWorkbenchStore((s) => s.openNewDialog);
  const [archivedOpen, setArchivedOpen] = useState(false);

  const live = useMemo(() => workbenches.filter((w) => w.status !== 'archived' && !w.archivedAt), [workbenches]);
  const archived = useMemo(() => workbenches.filter((w) => w.status === 'archived' || w.archivedAt), [workbenches]);
  const groups = useMemo(() => groupByRepository(live), [live]);

  let index = 0;
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-muted/20">
      <div className="flex items-center justify-between border-b px-3 py-2.5">
        <h2 className="text-sm font-semibold">Workbenches</h2>
        <button
          type="button"
          onClick={() => openNewDialog()}
          className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          title="New workbench (⌘N)"
          aria-label="New workbench"
        >
          <Plus className="h-3.5 w-3.5" />
          New
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {groups.length === 0 && (
          <p className="px-3 py-4 text-xs text-muted-foreground">No workbenches yet.</p>
        )}
        {groups.map((group) => (
          <div key={group.repo} className="py-1">
            <div className="truncate px-3 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {group.repo}
            </div>
            {group.items.map((wb) => {
              index += 1;
              return (
                <WorkbenchRow
                  key={wb.id}
                  workbench={wb}
                  shortcut={index <= 9 ? index : null}
                  selected={wb.id === selectedId}
                  onSelect={() => select(wb.id)}
                />
              );
            })}
          </div>
        ))}
        {archived.length > 0 && (
          <div className="mt-2 border-t pt-1">
            <button
              type="button"
              onClick={() => setArchivedOpen((v) => !v)}
              className="flex w-full items-center gap-1 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
              aria-expanded={archivedOpen}
            >
              {archivedOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Archived ({archived.length})
            </button>
            {archivedOpen && archived.map((wb) => <ArchivedRow key={wb.id} workbench={wb} />)}
          </div>
        )}
      </div>
    </aside>
  );
}

function chatTone(chats: WorkbenchChat[], unread: Record<string, true>): 'running' | 'error' | 'unread' | 'idle' {
  if (chats.some((c) => c.status === 'running')) return 'running';
  if (chats.some((c) => c.status === 'error')) return 'error';
  if (chats.some((c) => unread[c.id] || c.status === 'awaiting_input')) return 'unread';
  return 'idle';
}

function WorkbenchRow({
  workbench,
  selected,
  shortcut,
  onSelect,
}: {
  workbench: Workbench;
  selected: boolean;
  shortcut: number | null;
  onSelect: () => void;
}) {
  const chats = useWorkbenchStore((s) => s.chats[workbench.id]);
  const unread = useWorkbenchStore((s) => s.unread);
  const pr = usePullRequestStore((s) =>
    workbench.pullRequestId ? s.rows.find((r) => r.id === workbench.pullRequestId) : undefined
  );
  const tone = workbench.status === 'error' ? 'error' : chatTone(chats ?? [], unread);
  const suspended = workbench.runtime === 'sandbox' && workbench.sandboxState === 'suspended';
  const provisioning = workbench.status === 'provisioning';
  const RuntimeIcon = workbench.runtime === 'local' ? Laptop : Cloud;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors',
        selected ? 'bg-secondary' : 'hover:bg-accent/60',
        suspended && !selected && 'opacity-60'
      )}
      title={shortcut ? `${workbench.name} (⌘${shortcut})` : workbench.name}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <StatusDot tone={provisioning ? 'running' : tone} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{workbench.name}</span>
        <RuntimeIcon
          className="h-3 w-3 shrink-0 text-muted-foreground"
          aria-label={workbench.runtime === 'local' ? 'Local worktree' : suspended ? 'Sandbox (suspended)' : 'Sandbox'}
        />
      </div>
      <div className="flex min-w-0 items-center gap-1.5 pl-3.5 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate font-mono">{workbench.branch}</span>
        {workbench.diffStat && workbench.diffStat.files > 0 && (
          <span className="shrink-0 tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-500">+{workbench.diffStat.added}</span>{' '}
            <span className="text-red-600 dark:text-red-500">−{workbench.diffStat.removed}</span>
          </span>
        )}
        {pr && <PrPill number={pr.number} state={pr.state} draft={pr.summary.draft} />}
      </div>
    </button>
  );
}

export function StatusDot({ tone }: { tone: 'running' | 'error' | 'unread' | 'idle' }) {
  if (tone === 'running') {
    return <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin text-amber-500" aria-label="Running" />;
  }
  return (
    <span
      className={cn(
        'h-2 w-2 shrink-0 rounded-full',
        tone === 'error' && 'bg-red-500',
        tone === 'unread' && 'bg-sky-500',
        tone === 'idle' && 'bg-muted-foreground/30'
      )}
      aria-label={tone === 'error' ? 'Error' : tone === 'unread' ? 'Needs you' : 'Idle'}
    />
  );
}

export function PrPill({ number, state, draft }: { number: number; state: string; draft?: boolean }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1 font-mono text-[10px] font-medium',
        state === 'merged'
          ? 'bg-violet-500/15 text-violet-700 dark:text-violet-300'
          : state === 'closed'
            ? 'bg-red-500/15 text-red-700 dark:text-red-300'
            : draft
              ? 'bg-muted text-muted-foreground'
              : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
      )}
    >
      #{number}
    </span>
  );
}

function ArchivedRow({ workbench }: { workbench: Workbench }) {
  const [busy, setBusy] = useState(false);
  const restore = async () => {
    setBusy(true);
    try {
      const wb = await api.workbenches.restore(workbench.id);
      useWorkbenchStore.getState().upsertWorkbench(wb);
      useWorkbenchStore.getState().selectWorkbench(wb.id);
    } catch (err) {
      toast.error('Could not restore the workbench', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-1.5 px-3 py-1 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">
        {workbench.name} <span className="font-mono text-[10px]">{workbench.repoFullName}</span>
      </span>
      <button
        type="button"
        onClick={() => void restore()}
        disabled={busy}
        className="rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-50"
        title="Restore this workbench"
        aria-label={`Restore ${workbench.name}`}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
      </button>
    </div>
  );
}

import React, { useEffect, useMemo, useState } from 'react';
import { Brain, FolderGit2 } from 'lucide-react';
import { workbenchDisplayName, type MemoryEntry, type MemoryEntrySummary, type Workbench } from '@talyn/shared';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { clampPanelWidth } from '../../lib/workbenchLayout';
import { sessionPr, sessionState } from '../../lib/sessionState';
import { prCiLabel, threadRepositories, WORK_PANEL_MEMORY_LIMIT } from '../../lib/threads';
import { useNavigationStore } from '../../stores/navigation';
import { usePullRequestStore } from '../../stores/pullRequests';
import { useWorkbenchStore } from '../../stores/workbenches';
import { useWorkspaceStore } from '../../stores/workspace';
import { Button } from '../ui/button';
import { memoryScopeLabel } from '../memory/MemoryEditor';
import { MemoryBody } from '../memory/MemoryChangeCard';
import { useMemoryChanged } from '../../lib/memoryEvents';
import { useTurnsEnded } from './useTurnsEnded';
import { PrPill, SessionStateIcon } from './WorkbenchBadges';
import { isArchived, useThreadChildren } from './workbenchSelectors';

/**
 * A thread's right column, in place of the GitPanel: a thread has no
 * repository, so no files, changes or pull request. It shows the thread's
 * sessions, the memory the thread sees, and the repositories its sessions
 * work on.
 */
export function WorkPanel({ thread }: { thread: Workbench }) {
  const width = useWorkbenchStore((s) => s.rightPanelWidth);
  const setWidth = useWorkbenchStore((s) => s.setRightPanelWidth);
  const children = useThreadChildren(thread.id, { includeArchived: true });
  const repos = useMemo(() => threadRepositories(children), [children]);

  const onDragStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const move = (ev: PointerEvent) => setWidth(clampPanelWidth(startWidth + (startX - ev.clientX)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="relative flex shrink-0 flex-col border-l bg-background" style={{ width }} data-testid="work-panel">
      <div
        onPointerDown={onDragStart}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the right panel"
        aria-valuenow={width}
      />
      {/* Each section keeps its header on screen and scrolls its own list. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <Section title="Sessions" count={children.length}>
          {children.length === 0 ? (
            <p className="px-3 text-xs text-muted-foreground">No sessions yet. Ask the thread to start one.</p>
          ) : (
            <ul className="space-y-0.5 px-1.5" aria-label="Sessions of this thread">
              {children.map((child) => (
                <SessionRow key={child.id} session={child} />
              ))}
            </ul>
          )}
        </Section>
        <MemorySection thread={thread} />
        <Section title="Repositories" count={repos.length} short>
          {repos.length === 0 ? (
            <p className="px-3 text-xs text-muted-foreground">No repositories yet.</p>
          ) : (
            <ul className="space-y-0.5 px-3" aria-label="Repositories of this thread">
              {repos.map((repo) => (
                <li key={repo} className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
                  <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{repo}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  count,
  action,
  short,
  children,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  /** A short list keeps its full height, up to a cap, when the long lists shrink. */
  short?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={cn('flex flex-col border-b py-2', short ? 'shrink-0' : 'min-h-14 shrink')} aria-label={title}>
      <div className="flex shrink-0 items-center gap-1.5 px-3 pb-1.5">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
        {count !== undefined && count > 0 && <span className="text-[11px] tabular-nums text-muted-foreground">{count}</span>}
        <div className="ml-auto">{action}</div>
      </div>
      <div className={cn('min-h-0 overflow-y-auto', short && 'max-h-28')}>{children}</div>
    </section>
  );
}

function SessionRow({ session }: { session: Workbench }) {
  const navigate = useNavigationStore((s) => s.navigate);
  const chats = useWorkbenchStore((s) => s.chats[session.id]);
  const unread = useWorkbenchStore((s) => s.unread);
  const row = usePullRequestStore((s) =>
    session.pullRequestId ? s.rows.find((r) => r.id === session.pullRequestId) : undefined
  );
  const pr = sessionPr(session, row);
  const state = sessionState(session, chats ?? [], unread, pr);
  const archived = isArchived(session);
  const ci = pr?.state === 'open' ? prCiLabel(pr.summary.ciStatus) : null;
  const name = workbenchDisplayName(session);
  return (
    <li
      className={cn('flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-accent/40', archived && 'opacity-60')}
      data-attr="work-panel-session"
    >
      <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <SessionStateIcon state={state} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px]" title={name}>
          {name}
        </div>
        <div className="truncate text-[11px] text-muted-foreground" title={`${session.repoFullName} · ${session.branch}`}>
          {session.repoFullName}
          {session.branch && <span className="font-mono"> · {session.branch}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>{archived ? 'Archived' : state.label}</span>
          {pr && <PrPill number={pr.number} state={pr.state} draft={pr.summary.draft} />}
          {ci && <span className={cn(ci === 'CI failing' && 'text-destructive')}>{ci}</span>}
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="h-6 shrink-0 px-2 text-xs"
        onClick={() => navigate({ view: 'workbench', id: session.id })}
        aria-label={`Open ${name}`}
      >
        Open
      </Button>
    </li>
  );
}

type MemoryState = { status: 'loading' } | { status: 'loaded'; entries: MemoryEntrySummary[] } | { status: 'error' };

/** The memory the thread sees: its own entries and the workspace's. */
function MemorySection({ thread }: { thread: Workbench }) {
  const repositories = useWorkspaceStore((s) => s.repositories);
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  const chats = useWorkbenchStore((s) => s.chats[thread.id]);
  // A turn can save memory, so the list reloads when a turn ends.
  const turnsEnded = useTurnsEnded(chats);
  const [state, setState] = useState<MemoryState>({ status: 'loading' });
  // A session can save memory in the middle of a turn.
  const [changes, setChanges] = useState(0);
  useMemoryChanged(() => setChanges((n) => n + 1));
  const [open, setOpen] = useState<{ id: string; entry: MemoryEntry | null; failed?: boolean } | null>(null);
  const toggle = (id: string) => {
    if (open?.id === id) {
      setOpen(null);
      return;
    }
    setOpen({ id, entry: null });
    api.workbenches.memory
      .get(id)
      .then((entry) => setOpen((cur) => (cur?.id === id ? { id, entry } : cur)))
      .catch(() => setOpen((cur) => (cur?.id === id ? { id, entry: null, failed: true } : cur)));
  };

  useEffect(() => {
    let cancelled = false;
    api.workbenches.memory
      .list({ workspaceId: thread.workspaceId, threadId: thread.id })
      .then((entries) => {
        if (!cancelled) setState({ status: 'loaded', entries: entries.filter((e) => !e.forgottenAt) });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [thread.id, thread.workspaceId, turnsEnded, changes]);

  const entries = state.status === 'loaded' ? state.entries : [];
  return (
    <Section
      title="Memory"
      count={entries.length}
      action={
        <button
          type="button"
          onClick={() => openSettings('memory')}
          className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          data-attr="work-panel-memory-open-all"
        >
          Open all
        </button>
      }
    >
      {state.status === 'loading' && <p className="px-3 text-xs text-muted-foreground">Loading…</p>}
      {state.status === 'error' && <p className="px-3 text-xs text-muted-foreground">Could not load memory.</p>}
      {state.status === 'loaded' && entries.length === 0 && (
        <p className="px-3 text-xs text-muted-foreground">Nothing saved yet.</p>
      )}
      {entries.length > 0 && (
        <ul className="space-y-1 px-3" aria-label="Memory of this thread">
          {entries.slice(0, WORK_PANEL_MEMORY_LIMIT).map((entry) => (
            <li key={entry.id} className="min-w-0 text-xs">
              <button
                type="button"
                onClick={() => toggle(entry.id)}
                aria-expanded={open?.id === entry.id}
                title={open?.id === entry.id ? 'Hide this memory' : 'Show this memory'}
                className="block w-full min-w-0 rounded text-left hover:bg-accent/60"
                data-attr="work-panel-memory-entry"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <Brain className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="truncate font-medium">{entry.name}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{memoryScopeLabel(entry, repositories)}</span>
                </div>
                {entry.description && open?.id !== entry.id && (
                  <p className="truncate pl-[18px] text-muted-foreground">{entry.description}</p>
                )}
              </button>
              {open?.id === entry.id && (
                <div className="mt-1 rounded border border-border bg-card">
                  {open.entry ? (
                    <MemoryBody entry={open.entry} />
                  ) : (
                    <p className="px-3 py-2 text-muted-foreground">{open.failed ? 'Could not load this memory.' : 'Loading…'}</p>
                  )}
                </div>
              )}
            </li>
          ))}
          {entries.length > WORK_PANEL_MEMORY_LIMIT && (
            <li className="text-[11px] text-muted-foreground">{entries.length - WORK_PANEL_MEMORY_LIMIT} more</li>
          )}
        </ul>
      )}
    </Section>
  );
}

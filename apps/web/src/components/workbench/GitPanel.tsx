import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { cn } from '../../lib/utils';
import type { PRRow } from '../../lib/api';
import type { DiffComment } from '../../lib/workbenchFormat';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { clampPanelWidth, type GitPanelTab } from '../../lib/workbenchLayout';
import { useWorkbenchStore } from '../../stores/workbenches';
import { ChangesTab } from './ChangesTab';
import { FilesTab } from './FilesTab';
import { PullRequestTab } from './PullRequestTab';
const TerminalPanel = lazy(() =>
  import('./terminal/TerminalPanel').then((module) => ({
    default: module.TerminalPanel,
  })),
);

export const GIT_PANEL_TAB_LABELS: Array<{
  id: GitPanelTab;
  label: string;
  hint: string;
}> = [
  { id: 'files', label: 'All files', hint: 'Every file on the branch' },
  {
    id: 'changes',
    label: 'Changes',
    hint: 'Changes against the base branch (⌘⇧D)',
  },
  {
    id: 'pr',
    label: 'Pull request',
    hint: 'The pull request: status, checks, reviews and the merge queue',
  },
];

/**
 * The right column: All files / Changes / Pull request, with the terminal dock
 * under it. Its left edge drags to resize (remembered); ⌘⌥B hides it. A tab
 * stays mounted once opened, so a diff comment draft or a scroll position
 * survives a trip to another tab.
 */
export function GitPanel({
  workbench,
  chat,
  ops,
  pr,
}: {
  workbench: Workbench;
  chat: WorkbenchChat | null;
  ops: WorkbenchOps;
  pr: PRRow | null;
}) {
  const tab = useWorkbenchStore((s) => s.sideTab);
  const setTab = useWorkbenchStore((s) => s.setSideTab);
  const width = useWorkbenchStore((s) => s.rightPanelWidth);
  const setWidth = useWorkbenchStore((s) => s.setRightPanelWidth);
  const chats = useWorkbenchStore((s) => s.chats[workbench.id]);
  const [comments, setComments] = useState<DiffComment[]>([]);
  const [mounted, setMounted] = useState<Record<GitPanelTab, boolean>>({
    files: false,
    changes: false,
    pr: false,
  });
  const turnsEnded = useTurnsEnded(chats);

  useEffect(() => setComments([]), [workbench.id]);
  useEffect(() => setMounted((m) => (m[tab] ? m : { ...m, [tab]: true })), [tab]);

  const onDragStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const move = (ev: PointerEvent) => setWidth(clampPanelWidth(startWidth + (startX - ev.clientX)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.removeProperty('cursor');
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onSeparatorKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') setWidth(width + 16);
    else if (e.key === 'ArrowRight') setWidth(width - 16);
    else return;
    e.preventDefault();
  };

  return (
    <div className="relative flex shrink-0 flex-col border-l bg-background" style={{ width }} data-testid="git-panel">
      <div
        onPointerDown={onDragStart}
        onKeyDown={onSeparatorKey}
        tabIndex={0}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize focus:outline-none focus-visible:bg-ring/40"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the right panel"
        aria-valuenow={width}
      />
      <div
        className="flex h-9 shrink-0 items-center gap-0.5 border-b px-1.5"
        role="tablist"
        aria-label="Session panels"
      >
        {GIT_PANEL_TAB_LABELS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            title={t.hint}
            className={cn(
              'rounded px-2 py-1 text-xs font-medium',
              tab === t.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
            {t.id === 'changes' && workbench.diffStat && workbench.diffStat.files > 0 && (
              <span className="ml-1 tabular-nums text-muted-foreground">{workbench.diffStat.files}</span>
            )}
            {t.id === 'changes' && comments.length > 0 && (
              <span className="ml-1 rounded bg-info/15 px-1 text-[10px] text-info">{comments.length}</span>
            )}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {(mounted.changes || tab === 'changes') && (
          <div className={cn('h-full', tab !== 'changes' && 'hidden')}>
            <ChangesTab
              workbench={workbench}
              chat={chat}
              ops={ops}
              visible={tab === 'changes'}
              turnsEnded={turnsEnded}
              comments={comments}
              setComments={setComments}
            />
          </div>
        )}
        {(mounted.files || tab === 'files') && (
          <div className={cn('h-full', tab !== 'files' && 'hidden')}>
            <FilesTab workbench={workbench} ops={ops} visible={tab === 'files'} />
          </div>
        )}
        {(mounted.pr || tab === 'pr') && (
          <div className={cn('h-full', tab !== 'pr' && 'hidden')}>
            <PullRequestTab workbench={workbench} chat={chat} pr={pr} visible={tab === 'pr'} turnsEnded={turnsEnded} />
          </div>
        )}
      </div>
      <Suspense fallback={null}>
        <TerminalPanel workbench={workbench} ops={ops} />
      </Suspense>
    </div>
  );
}

/** A counter that goes up each time one of the chats stops running. */
export function useTurnsEnded(chats: WorkbenchChat[] | undefined): number {
  const [count, setCount] = useState(0);
  const prev = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    let ended = false;
    const next = new Map<string, string>();
    for (const c of chats ?? []) {
      if (prev.current.get(c.id) === 'running' && c.status !== 'running') ended = true;
      next.set(c.id, c.status);
    }
    prev.current = next;
    if (ended) setCount((n) => n + 1);
  }, [chats]);
  return count;
}

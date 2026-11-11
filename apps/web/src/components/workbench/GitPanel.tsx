import React, { Suspense, useEffect, useRef, useState } from 'react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { trackEvent } from '../../lib/analytics';
import type { PRRow } from '../../lib/api';
import type { DiffComment } from '../../lib/workbenchFormat';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { clampPanelWidth, type GitPanelTab } from '../../lib/workbenchLayout';
import { useWorkbenchStore } from '../../stores/workbenches';
import { ChangesTab } from './ChangesTab';
import { FilesTab } from './FilesTab';
import { PullRequestTab } from './PullRequestTab';
import { SandboxTab, sandboxStatusNeedsAttention, useSandboxStatus } from './SandboxStatusPanel';
import { useTurnsEnded } from './useTurnsEnded';
import { lazyWithReload } from '../../lib/lazyWithReload';
import { useIsWorkbenchOwner } from '../../lib/spaces';
import { useBackground } from '../../stores/sessionBackground';
import { BackgroundTab } from './BackgroundTab';
const TerminalPanel = lazyWithReload(() =>
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
  { id: 'sandbox', label: 'Sandbox', hint: 'What the sandbox is doing, and whether the work is safe' },
  { id: 'background', label: 'Background', hint: 'Jobs and wake-ups in this session' },
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
  const storedTab = useWorkbenchStore((s) => s.sideTab);
  // A teammate reads the changes, files and pull request; the sandbox and its terminal stay the owner's.
  const owner = useIsWorkbenchOwner(workbench);
  const hasSandbox = workbench.runtime === 'sandbox' && owner;
  const hasBackground = owner;
  const background = useBackground(workbench.id);
  const runningJobs = background?.jobs.filter((job) => job.status === 'running').length ?? 0;
  const tab = (storedTab === 'sandbox' && !hasSandbox) || (storedTab === 'background' && !hasBackground) ? 'changes' : storedTab;
  const setTab = useWorkbenchStore((s) => s.setSideTab);
  const width = useWorkbenchStore((s) => s.rightPanelWidth);
  const setWidth = useWorkbenchStore((s) => s.setRightPanelWidth);
  const chats = useWorkbenchStore((s) => s.chats[workbench.id]);
  const [comments, setComments] = useState<DiffComment[]>([]);
  const [mounted, setMounted] = useState<Record<GitPanelTab, boolean>>({ files: false, changes: false, pr: false, sandbox: false, background: false });
  const viewed = useRef(new Set<string>());
  const turnsEnded = useTurnsEnded(chats);
  const sandbox = useSandboxStatus(workbench, tab === 'sandbox', hasSandbox);
  const sandboxAttention = hasSandbox ? sandboxStatusNeedsAttention(sandbox.status) : null;
  const uncommittedFiles = workbench.uncommittedStats?.files ?? workbench.diffStat?.files ?? 0;
  const openPrHasUncommitted = (pr?.state ?? workbench.pr?.state) === 'open' && uncommittedFiles > 0;

  useEffect(() => setComments([]), [workbench.id]);
  useEffect(() => setMounted((m) => (m[tab] ? m : { ...m, [tab]: true })), [tab]);
  useEffect(() => {
    const key = `${workbench.id}:${tab}`;
    if (viewed.current.has(key)) return;
    viewed.current.add(key);
    trackEvent('session_tab_viewed', { workbench_id: workbench.id, tab });
  }, [workbench.id, tab]);

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
        className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b px-1.5 [scrollbar-width:none]"
        role="tablist"
        aria-label="Session panels"
      >
        {GIT_PANEL_TAB_LABELS.filter((t) => (t.id !== 'sandbox' || hasSandbox) && (t.id !== 'background' || hasBackground)).map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            title={t.id === 'changes' && openPrHasUncommitted
              ? `${uncommittedFiles} uncommitted ${uncommittedFiles === 1 ? 'file is' : 'files are'} not in the open pull request`
              : t.hint}
            className={cn(
              'shrink-0 rounded px-2 py-1 text-xs font-medium',
              tab === t.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
            {t.id === 'background' && runningJobs > 0 && <span className="ml-1 rounded bg-emerald-500/15 px-1 text-[10px] tabular-nums text-emerald-600 dark:text-emerald-400">{runningJobs}</span>}
            {t.id === 'changes' && uncommittedFiles > 0 && (openPrHasUncommitted ? (
              <span className="ml-1 rounded bg-amber-500/15 px-1 text-[10px] tabular-nums text-amber-700 dark:text-amber-400">
                {uncommittedFiles} uncommitted
              </span>
            ) : (
              <span className="ml-1 tabular-nums text-muted-foreground">{uncommittedFiles}</span>
            ))}
            {t.id === 'changes' && comments.length > 0 && (
              <span className="ml-1 rounded bg-info/15 px-1 text-[10px] text-info">{comments.length}</span>
            )}
            {t.id === 'sandbox' && sandboxAttention && (
              <span
                className={cn('ml-1 inline-block h-1.5 w-1.5 rounded-full align-middle', sandboxAttention === 'danger' ? 'bg-destructive' : 'bg-amber-500')}
                data-testid="sandbox-tab-dot"
                data-level={sandboxAttention}
                aria-label="The sandbox needs attention"
              />
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
        {hasSandbox && (mounted.sandbox || tab === 'sandbox') && (
          <div className={cn('h-full', tab !== 'sandbox' && 'hidden')}>
            <SandboxTab workbench={workbench} sandbox={sandbox} />
          </div>
        )}
        {hasBackground && (mounted.background || tab === 'background') && (
          <div className={cn('h-full', tab !== 'background' && 'hidden')}>
            <BackgroundTab workbenchId={workbench.id} />
          </div>
        )}
      </div>
      {owner && (
        <Suspense fallback={null}>
          <TerminalPanel workbench={workbench} ops={ops} />
        </Suspense>
      )}
    </div>
  );
}

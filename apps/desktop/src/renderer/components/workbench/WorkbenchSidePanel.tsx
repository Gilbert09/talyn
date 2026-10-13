import { useEffect, useRef, useState } from 'react';
import { ExternalLink, GitPullRequest, Loader2 } from 'lucide-react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { api, type PRFreshDetail, type PRRow, type PRSummaryShape } from '../../lib/api';
import type { DiffComment } from '../../lib/workbenchFormat';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { useWorkbenchStore, type WorkbenchSideTab } from '../../stores/workbenches';
import { Button } from '../ui/button';
import { ChecksTab, PRDetailSheet, ReviewsTab } from '../widgets/PRDetailSheet';
import { ChangesTab } from './ChangesTab';
import { FilesTab } from './FilesTab';

const TABS: Array<{ id: WorkbenchSideTab; label: string; hint: string }> = [
  { id: 'changes', label: 'Changes', hint: 'Changes (⌘⇧D)' },
  { id: 'files', label: 'Files', hint: 'Files' },
  { id: 'checks', label: 'Checks', hint: 'CI checks and reviews on the PR' },
];

/**
 * The right column. Every tab stays mounted once opened so a diff comment
 * draft or a scroll position survives a trip to another tab.
 */
export function WorkbenchSidePanel({
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
  const chats = useWorkbenchStore((s) => s.chats[workbench.id]);
  const [comments, setComments] = useState<DiffComment[]>([]);
  const turnsEnded = useTurnsEnded(chats);

  useEffect(() => setComments([]), [workbench.id]);

  return (
    <div className="flex w-[26rem] shrink-0 flex-col border-l bg-background">
      <div className="flex items-center gap-0.5 border-b px-2" role="tablist" aria-label="Workbench panels">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            title={t.hint}
            className={cn(
              'border-b-2 px-2.5 py-2 text-xs font-medium',
              tab === t.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t.label}
            {t.id === 'changes' && workbench.diffStat && workbench.diffStat.files > 0 && (
              <span className="ml-1 tabular-nums text-muted-foreground">{workbench.diffStat.files}</span>
            )}
            {t.id === 'changes' && comments.length > 0 && (
              <span className="ml-1 rounded bg-sky-500/15 px-1 text-[10px] text-sky-700 dark:text-sky-300">{comments.length}</span>
            )}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
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
        {tab === 'files' && <FilesTab workbench={workbench} ops={ops} visible />}
        {tab === 'checks' && <WorkbenchChecks pr={pr} />}
      </div>
    </div>
  );
}

/** A counter that goes up each time one of the chats stops running. */
function useTurnsEnded(chats: WorkbenchChat[] | undefined): number {
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

function WorkbenchChecks({ pr }: { pr: PRRow | null }) {
  const [data, setData] = useState<{ row: PRRow; fresh: (PRSummaryShape & PRFreshDetail) | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const checksAt = pr?.summary.checksAt;

  useEffect(() => {
    if (!pr) return undefined;
    let cancelled = false;
    api.pullRequests
      .get(pr.id)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [pr?.id, checksAt]);

  if (!pr) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
        <GitPullRequest className="h-5 w-5" />
        <p>CI checks and reviews show here once this branch has a pull request.</p>
        <p>Use Create PR in the header to ask the agent to open one.</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="mb-3 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={pr.summary.title}>
          #{pr.number} {pr.summary.title}
        </span>
        <Button variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={() => setSheetOpen(true)}>
          Open PR
        </Button>
        <a
          href={pr.summary.url}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded p-1 text-muted-foreground hover:text-foreground"
          title="Open on GitHub"
          aria-label="Open on GitHub"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
      {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {data ? (
        <div className="space-y-5">
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Checks</h3>
            <ChecksTab data={data} detailPending={false} />
          </section>
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reviews</h3>
            <ReviewsTab data={data} />
          </section>
        </div>
      ) : (
        !error && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading the PR…
          </div>
        )
      )}
      <PRDetailSheet pullRequestId={sheetOpen ? pr.id : null} onClose={() => setSheetOpen(false)} seedRow={pr} />
    </div>
  );
}

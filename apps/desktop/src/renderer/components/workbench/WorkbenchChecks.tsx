import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  GitPullRequest,
  Loader2,
  MessageSquarePlus,
  MinusCircle,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { api, type PRCheckContext, type PRFreshDetail, type PRRow, type PRSummaryShape } from '../../lib/api';
import { insertIntoComposer } from '../../lib/composerInsert';
import {
  CHECKS_REFRESH_MS,
  checkChatLine,
  checkRequirement,
  orderChecks,
  tallyChecks,
} from '../../lib/workbenchChecks';
import { PRDetailSheet, ReviewsTab } from '../widgets/PRDetailSheet';
import { PrPill } from './WorkbenchBadges';

type PrDetail = { row: PRRow; fresh: (PRSummaryShape & PRFreshDetail) | null };

/**
 * The Checks tab of the right panel: the PR this branch opened, its checks
 * (failing first, required before optional) and its reviews. Re-read every
 * 30 s while on screen, after each turn ends, and when the PR's checks move.
 */
export function WorkbenchChecks({
  workbench,
  chat,
  pr,
  visible,
  turnsEnded,
}: {
  workbench: Workbench;
  chat: WorkbenchChat | null;
  pr: PRRow | null;
  visible: boolean;
  /** Bumps each time a turn in this workbench ends. */
  turnsEnded: number;
}) {
  const [data, setData] = useState<PrDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const loadingRef = useRef(false);
  const prId = pr?.id ?? null;
  const checksAt = pr?.summary.checksAt;

  const refresh = useCallback(async () => {
    if (!prId || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const res = await api.pullRequests.get(prId);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the pull request.');
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [prId]);

  useEffect(() => {
    setData(null);
    setError(null);
  }, [prId]);

  useEffect(() => {
    if (visible) void refresh();
  }, [visible, refresh, turnsEnded, checksAt]);

  useEffect(() => {
    if (!visible || !prId) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, CHECKS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [visible, prId, refresh]);

  if (!pr) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
        <GitPullRequest className="h-5 w-5" />
        <p>CI checks and reviews show here once this branch has a pull request.</p>
        <p>Use Create PR in the header to ask the agent to open one.</p>
      </div>
    );
  }

  const row = data?.row ?? pr;
  const contexts = data?.fresh?.checkContexts ?? [];
  const checks = orderChecks(contexts);
  const tally = tallyChecks(contexts);
  const addToChat = (check: PRCheckContext) => insertIntoComposer(workbench.id, chat, checkChatLine(check, row.number));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <PrPill number={row.number} state={row.state} draft={row.summary.draft} />
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className="min-w-0 flex-1 truncate text-left text-xs font-medium hover:underline"
          title={`${row.summary.title} — open the PR in Talyn`}
        >
          {row.summary.title}
        </button>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{row.state}</span>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Refresh"
          aria-label="Refresh the checks"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        </button>
        <a
          href={row.summary.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Open on GitHub"
        >
          GitHub <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="px-3 py-2 text-xs text-destructive">{error}</p>}
        {!data && !error && (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading the checks…
          </div>
        )}
        {data && contexts.length === 0 && (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            {row.summary.checks?.total ? 'The check details are not available right now.' : 'No checks have run yet.'}{' '}
            <a href={`${row.summary.url}/checks`} target="_blank" rel="noopener noreferrer" className="text-primary underline">
              Open checks on GitHub
            </a>
          </p>
        )}
        {contexts.length > 0 && (
          <>
            <p className="px-3 pb-1 pt-2 text-[11px] text-muted-foreground" data-testid="checks-tally">
              {tally.failing > 0 && (
                <span className="text-destructive">
                  {tally.failing} failing{tally.failing !== tally.failingRequired ? ` (${tally.failingRequired} required)` : ''}
                </span>
              )}
              {tally.failing > 0 && ' · '}
              {tally.running} running · {tally.passed} passed
              {tally.skipped > 0 ? ` · ${tally.skipped} skipped` : ''}
            </p>
            <ul className="pb-2">
              {checks.map((c) => (
                <CheckLine key={`${c.name}:${c.url ?? ''}`} check={c} onAddToChat={() => addToChat(c)} />
              ))}
            </ul>
          </>
        )}
        {data && (
          <section className="border-t px-3 py-2">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Reviews</h3>
            <ReviewsTab data={data} />
          </section>
        )}
      </div>
      <PRDetailSheet pullRequestId={sheetOpen ? pr.id : null} onClose={() => setSheetOpen(false)} seedRow={pr} />
    </div>
  );
}

function CheckLine({ check, onAddToChat }: { check: PRCheckContext; onAddToChat: () => void }) {
  const req = checkRequirement(check);
  const failing = check.state === 'failure';
  const Icon =
    check.state === 'success'
      ? CheckCircle2
      : failing
        ? XCircle
        : check.state === 'skipped'
          ? MinusCircle
          : check.state === 'in_progress'
            ? Loader2
            : CircleDashed;
  return (
    <li className="group flex items-center gap-2 px-3 py-1 text-xs hover:bg-accent/50" data-testid="check-line">
      <Icon
        className={cn(
          'h-3.5 w-3.5 shrink-0',
          check.state === 'success' && 'text-success',
          failing && (req === 'optional' ? 'text-warning' : 'text-destructive'),
          check.state === 'in_progress' && 'animate-spin text-info',
          (check.state === 'pending' || check.state === 'skipped') && 'text-muted-foreground'
        )}
        aria-label={check.state}
      />
      {check.url ? (
        <a
          href={check.url}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 flex-1 truncate hover:underline"
          title={`${check.name} — open the run`}
        >
          {check.name}
        </a>
      ) : (
        <span className="min-w-0 flex-1 truncate" title={check.name}>
          {check.name}
        </span>
      )}
      {req !== 'unknown' && (
        <span
          className={cn(
            'shrink-0 rounded px-1 text-[10px]',
            req === 'required' ? 'bg-muted text-foreground/80' : 'text-muted-foreground'
          )}
        >
          {req}
        </span>
      )}
      <button
        type="button"
        onClick={onAddToChat}
        className={cn(
          'shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground',
          !failing && 'opacity-0 focus:opacity-100 group-hover:opacity-100'
        )}
        title="Add to chat"
        aria-label={`Add ${check.name} to chat`}
      >
        <MessageSquarePlus className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

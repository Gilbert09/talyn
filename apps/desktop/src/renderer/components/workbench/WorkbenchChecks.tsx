import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  CircleDashed,
  GitPullRequest,
  Loader2,
  MessageSquarePlus,
  MinusCircle,
  XCircle,
} from 'lucide-react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { api, type PRCheckContext, type PRFreshDetail, type PRRow, type PRSummaryShape } from '../../lib/api';
import { insertIntoComposer } from '../../lib/composerInsert';
import { checkChatLine, checkRequirement, orderChecks, tallyChecks } from '../../lib/workbenchChecks';

export type PrDetail = { row: PRRow; fresh: (PRSummaryShape & PRFreshDetail) | null };

/**
 * The PR's live detail (check runs, reviews) for the Pull request tab. Read
 * when the tab opens, after each turn ends, and on `refresh()`. Never on a
 * timer: the status pills read the PR store, which the WS keeps current, and
 * each read here is a live GitHub fetch.
 *
 * `stale` is true once the store says the checks moved after the last read,
 * so the tab can offer a refresh instead of fetching on every check event.
 */
export function usePrDetail(
  pr: PRRow | null,
  { visible, turnsEnded }: { visible: boolean; turnsEnded: number }
): {
  data: PrDetail | null;
  error: string | null;
  loading: boolean;
  stale: boolean;
  /** Bumps on each completed read, so a child that loads its own data can follow. */
  loadCount: number;
  refresh: () => Promise<void>;
} {
  const [data, setData] = useState<PrDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadCount, setLoadCount] = useState(0);
  const [readChecksAt, setReadChecksAt] = useState<number | undefined>(undefined);
  const loadingRef = useRef(false);
  const prId = pr?.id ?? null;
  const checksAt = pr?.summary.checksAt;
  const checksAtRef = useRef(checksAt);
  checksAtRef.current = checksAt;

  const refresh = useCallback(async () => {
    if (!prId || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    const at = checksAtRef.current;
    try {
      const res = await api.pullRequests.get(prId);
      setData(res);
      setError(null);
      setReadChecksAt(at);
      setLoadCount((n) => n + 1);
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
    setReadChecksAt(undefined);
  }, [prId]);

  useEffect(() => {
    if (visible) void refresh();
  }, [visible, refresh, turnsEnded]);

  const stale = Boolean(data && checksAt !== undefined && (readChecksAt === undefined || checksAt > readChecksAt));
  return { data, error, loading, stale, loadCount, refresh };
}

/** What the tab says before the branch has a pull request. */
export function NoPullRequest() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
      <GitPullRequest className="h-5 w-5" />
      <p>CI checks and reviews show here once this branch has a pull request.</p>
      <p>Use Create PR in the header to ask the agent to open one.</p>
    </div>
  );
}

/**
 * The PR's checks, failing first and required before optional, each with
 * "Add to chat". `data` null means the first read has not finished.
 */
export function PrChecksList({
  workbench,
  chat,
  row,
  data,
  error,
}: {
  workbench: Workbench;
  chat: WorkbenchChat | null;
  row: PRRow;
  data: PrDetail | null;
  error: string | null;
}) {
  const contexts = data?.fresh?.checkContexts ?? [];
  const checks = orderChecks(contexts);
  const tally = tallyChecks(contexts);
  const addToChat = (check: PRCheckContext) => insertIntoComposer(workbench.id, chat, checkChatLine(check, row.number));

  return (
    <>
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
    </>
  );
}

export function CheckLine({ check, onAddToChat }: { check: PRCheckContext; onAddToChat: () => void }) {
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

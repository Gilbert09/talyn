import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import type {
  PostHogInboxBacklogDays,
  PostHogInboxBacklogPage,
  PostHogInboxBacklogRow,
  PostHogInboxBacklogState,
  PostHogInboxRunResponse,
  WorkflowConditions,
} from '@talyn/shared';
import {
  DEFAULT_POSTHOG_INBOX_BACKLOG_DAYS,
  MAX_POSTHOG_INBOX_RUN_REPORTS,
  POSTHOG_INBOX_ACTIONABILITY_LABELS,
  POSTHOG_INBOX_BACKLOG_DAYS,
  POSTHOG_INBOX_BACKLOG_STATE_LABELS,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { captureAnalyticsException, trackEvent } from '../../../lib/analytics';
import { navigateToWorkbench } from '../../../lib/workbenchNavigation';
import { cn } from '../../../lib/utils';
import { useWorkspaceStore } from '../../../stores/workspace';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog';

/**
 * The backlog of a PostHog Inbox rule: older ready reports that match its
 * conditions. The person can pick reports and start work on them now.
 *
 * The same file is in apps/desktop/src/renderer/components/panels/workflows/. Keep the two in step.
 */

const STATE_VARIANTS: Record<PostHogInboxBacklogState, 'outline' | 'success' | 'secondary' | 'warning' | 'error'> = {
  not_run: 'outline',
  running: 'success',
  already_run: 'secondary',
  claimed_elsewhere: 'warning',
  already_addressed: 'secondary',
  repository_not_connected: 'warning',
  held_back: 'error',
};

function ago(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function actionabilityLabel(value: string | null): string | null {
  if (!value) return null;
  return (POSTHOG_INBOX_ACTIONABILITY_LABELS as Record<string, string>)[value] ?? value;
}

function BacklogRow({
  row,
  showCheckbox,
  checked,
  disabled,
  onToggle,
}: {
  row: PostHogInboxBacklogRow;
  showCheckbox: boolean;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const title = row.title || `Report ${row.id}`;
  const created = ago(row.createdAt);
  const updated = ago(row.updatedAt);
  const details = [
    row.priority,
    actionabilityLabel(row.actionability),
    row.repository ?? 'No repository',
    row.sourceProducts.length > 0 ? row.sourceProducts.join(', ') : null,
    plural(row.signalCount, 'signal'),
    created ? `created ${created}` : null,
    updated ? `updated ${updated}` : null,
  ].filter(Boolean);

  return (
    <li className="flex items-start gap-3 py-2 text-sm" data-attr="posthog-inbox-backlog-row" data-report-id={row.id}>
      {showCheckbox && (
        <div className="w-4 pt-0.5">
          {row.selectable && (
            <input
              type="checkbox"
              className="h-4 w-4"
              aria-label={`Select ${title}`}
              checked={checked}
              disabled={disabled}
              onChange={onToggle}
            />
          )}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={row.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium hover:underline"
            title="Open the report in PostHog"
          >
            {title}
            <ExternalLink className="h-3 w-3 shrink-0" />
          </a>
          <Badge variant={STATE_VARIANTS[row.state]} data-attr={`posthog-inbox-backlog-state-${row.state}`}>
            {POSTHOG_INBOX_BACKLOG_STATE_LABELS[row.state]}
          </Badge>
        </div>
        <div className="text-xs text-muted-foreground">{details.join(' · ')}</div>
        {row.state === 'running' && (row.workbenchId || row.prUrl) && (
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
            {row.workbenchId && (
              <button
                type="button"
                className="underline hover:text-foreground"
                onClick={() => {
                  if (row.workbenchId) navigateToWorkbench(row.workbenchId);
                }}
              >
                Open the session
              </button>
            )}
            {row.prUrl && (
              <a href={row.prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
                Open the pull request
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/** The confirm text about the rule's daily cap. */
function dailyCapLine(page: PostHogInboxBacklogPage, count: number): string {
  if (page.dailyCap === null) return 'This automation has no daily cap.';
  const left = Math.max(0, page.dailyCap - page.runsToday);
  let text = `The daily cap is ${page.dailyCap}. ${plural(page.runsToday, 'run')} counted in the last 24 hours, so ${left} more can start today.`;
  if (left < count) text += ' Talyn does not start the reports after the cap.';
  return text;
}

export interface PostHogInboxBacklogProps {
  /** The saved rule, or null for a rule that is not saved yet. */
  workflow: { id: string } | null;
  /** The conditions to match. Undefined means the saved rule's own conditions. */
  conditions?: WorkflowConditions;
  /** Whether the editor has changes that are not saved. "Run selected" uses the saved rule. */
  unsavedChanges?: boolean;
  /** Load the first page at once, without a button press. */
  autoLoad?: boolean;
  /** Show the heading and the description. */
  showHeader?: boolean;
}

export function PostHogInboxBacklog({
  workflow,
  conditions,
  unsavedChanges = false,
  autoLoad = false,
  showHeader = true,
}: PostHogInboxBacklogProps) {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const [days, setDays] = useState<PostHogInboxBacklogDays>(DEFAULT_POSTHOG_INBOX_BACKLOG_DAYS);
  const [page, setPage] = useState<PostHogInboxBacklogPage | null>(null);
  const [rows, setRows] = useState<PostHogInboxBacklogRow[]>([]);
  const [scanned, setScanned] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<PostHogInboxRunResponse | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // Only the newest read may land: a changed rule or range makes older answers wrong.
  const request = useRef(0);
  // The newest inputs, for loads that start from an effect.
  const params = useRef({ workspaceId, workflowId: workflow?.id ?? null, conditions });
  params.current = { workspaceId, workflowId: workflow?.id ?? null, conditions };
  // Titles of the reports in the last run, for its messages.
  const titles = useRef(new Map<string, string>());

  const load = async (range: PostHogInboxBacklogDays, offset: number) => {
    const { workspaceId: ws, workflowId, conditions: match } = params.current;
    if (!ws) return;
    const id = ++request.current;
    const append = offset > 0;
    setLoading(true);
    setError(null);
    if (!append) setSelected([]);
    try {
      const next = await api.workflows.posthogInboxBacklog(ws, { workflowId, conditions: match, days: range, offset });
      if (request.current !== id) return;
      setPage(next);
      if (append) {
        setRows((prev) => {
          const seen = new Set(prev.map((r) => r.id));
          return [...prev, ...next.rows.filter((r) => !seen.has(r.id))];
        });
        setScanned((prev) => prev + next.scanned);
      } else {
        setRows(next.rows);
        setScanned(next.scanned);
      }
      trackEvent('posthog_inbox_backlog_loaded', {
        days: range,
        offset,
        rows: next.rows.length,
        scanned: next.scanned,
        runnable: next.runnable,
        saved: workflowId !== null,
      });
    } catch (err) {
      captureAnalyticsException(err, { flow: 'posthog_inbox_backlog' });
      if (request.current === id) setError(err instanceof Error && err.message ? err.message : 'Could not read the PostHog Inbox.');
    } finally {
      if (request.current === id) setLoading(false);
    }
  };

  // A changed rule makes the old backlog wrong.
  const resetKey = useMemo(
    () => `${workflow?.id ?? ''}|${JSON.stringify(conditions ?? null)}`,
    [workflow?.id, conditions]
  );
  useEffect(() => {
    request.current += 1;
    setPage(null);
    setRows([]);
    setScanned(0);
    setError(null);
    setLoading(false);
    setSelected([]);
    setRunResult(null);
    setRunError(null);
    if (autoLoad) void load(days, 0);
    // `days` and `load` read the newest values. Only a changed rule resets.
  }, [resetKey, autoLoad]);

  const changeDays = (next: PostHogInboxBacklogDays) => {
    setDays(next);
    setRunResult(null);
    setRunError(null);
    void load(next, 0);
  };

  const runnable = page?.runnable === true;
  const selectable = rows.filter((r) => r.selectable);
  const atCap = selected.length >= MAX_POSTHOG_INBOX_RUN_REPORTS;
  // At the cap, "all" means as many as one run may take.
  const allSelected = selectable.length > 0 && (atCap || selectable.every((r) => selected.includes(r.id)));

  const toggle = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_POSTHOG_INBOX_RUN_REPORTS) return prev;
      return [...prev, id];
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelected([]);
      return;
    }
    setSelected((prev) => {
      const next = [...prev];
      for (const row of selectable) {
        if (next.length >= MAX_POSTHOG_INBOX_RUN_REPORTS) break;
        if (!next.includes(row.id)) next.push(row.id);
      }
      return next;
    });
  };

  const run = async () => {
    if (!workflow || selected.length === 0) return;
    const ids = selected.slice(0, MAX_POSTHOG_INBOX_RUN_REPORTS);
    titles.current = new Map(rows.map((r) => [r.id, r.title || `Report ${r.id}`]));
    setRunning(true);
    setRunError(null);
    try {
      const result = await api.workflows.runPostHogInboxReports(workflow.id, ids);
      trackEvent('posthog_inbox_backlog_run', {
        requested: result.requested,
        started: result.started,
        daily_cap: result.dailyCap,
        days,
      });
      setRunResult(result);
      setConfirming(false);
      setSelected([]);
      void load(days, 0);
    } catch (err) {
      captureAnalyticsException(err, { flow: 'posthog_inbox_backlog_run' });
      setRunError(err instanceof Error && err.message ? err.message : 'Could not start the selected reports.');
      setConfirming(false);
    } finally {
      setRunning(false);
    }
  };

  const notStarted = runResult?.results.filter((r) => r.outcome !== 'started') ?? [];
  const showCheckboxes = runnable && selectable.length > 0;

  return (
    <section className="rounded-lg border" data-attr="posthog-inbox-backlog">
      <header className="flex flex-wrap items-start gap-3 border-b px-4 py-3">
        {showHeader && (
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">Backlog</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Shows older ready reports that match this automation. Select reports to start work on them now.
            </p>
          </div>
        )}
        <div className={cn('flex items-center gap-2', !showHeader && 'flex-1')}>
          <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Time range">
            {POSTHOG_INBOX_BACKLOG_DAYS.map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={days === d}
                className={cn(
                  'rounded px-2 py-0.5 text-xs',
                  days === d ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'
                )}
                onClick={() => changeDays(d)}
                data-attr={`posthog-inbox-backlog-days-${d}`}
              >
                {d} days
              </button>
            ))}
          </div>
          {!autoLoad && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load(days, 0)}
              disabled={loading}
              data-attr="posthog-inbox-backlog-load"
            >
              {loading && rows.length === 0 ? 'Reading...' : page ? 'Reload' : 'Show backlog'}
            </Button>
          )}
        </div>
      </header>

      {(page || error || runResult || runError || (loading && rows.length === 0)) && (
        <div className="space-y-3 p-4">
          {runResult && (
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-attr="posthog-inbox-backlog-run-result">
              <p className="font-medium">{runResult.summary}</p>
              {notStarted.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {notStarted.map((r) => (
                    <li key={r.reportId}>
                      <span className="font-medium text-foreground">{titles.current.get(r.reportId) ?? `Report ${r.reportId}`}:</span>{' '}
                      {r.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {runError && <p className="text-sm text-red-500" data-attr="posthog-inbox-backlog-run-error">{runError}</p>}
          {error && <p className="text-sm text-red-500" data-attr="posthog-inbox-backlog-error">{error}</p>}
          {loading && rows.length === 0 && !error && (
            <p className="text-sm text-muted-foreground">Reading the PostHog Inbox...</p>
          )}

          {page && (
            <>
              {!page.runnable && page.notRunnableReason && (
                <p
                  className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
                  data-attr="posthog-inbox-backlog-not-runnable"
                >
                  {page.notRunnableReason}
                </p>
              )}
              {page.runnable && unsavedChanges && (
                <p className="text-xs text-muted-foreground">Run selected uses the saved version of this automation.</p>
              )}
              <p className="text-xs text-muted-foreground" data-attr="posthog-inbox-backlog-count">
                Talyn read {plural(scanned, 'report')} from the last {page.days} days. {rows.length} of them{' '}
                {rows.length === 1 ? 'matches' : 'match'}.
              </p>

              {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No reports match in this time range.</p>
              ) : (
                <>
                  {showCheckboxes && (
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          aria-label="Select all reports that can run"
                          checked={allSelected}
                          onChange={toggleAll}
                        />
                        Select all
                      </label>
                      <span className="text-xs text-muted-foreground" data-attr="posthog-inbox-backlog-selected">
                        {selected.length} selected
                      </span>
                      {atCap && (
                        <span className="text-xs text-amber-600 dark:text-amber-400" data-attr="posthog-inbox-backlog-cap-note">
                          You can run {MAX_POSTHOG_INBOX_RUN_REPORTS} reports at one time.
                        </span>
                      )}
                      <Button
                        size="sm"
                        className="ml-auto"
                        disabled={selected.length === 0 || running}
                        onClick={() => setConfirming(true)}
                        data-attr="posthog-inbox-backlog-run"
                      >
                        Run selected
                      </Button>
                    </div>
                  )}
                  <ul className="divide-y" data-attr="posthog-inbox-backlog-rows">
                    {rows.map((row) => (
                      <BacklogRow
                        key={row.id}
                        row={row}
                        showCheckbox={showCheckboxes}
                        checked={selected.includes(row.id)}
                        disabled={atCap && !selected.includes(row.id)}
                        onToggle={() => toggle(row.id)}
                      />
                    ))}
                  </ul>
                </>
              )}

              {page.nextOffset !== null && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loading}
                  onClick={() => {
                    if (page.nextOffset !== null) void load(days, page.nextOffset);
                  }}
                  data-attr="posthog-inbox-backlog-more"
                >
                  {loading ? 'Loading...' : 'Load more'}
                </Button>
              )}
            </>
          )}
        </div>
      )}

      {page && (
        <Dialog open={confirming} onOpenChange={(open) => !open && !running && setConfirming(false)}>
          <DialogContent className="max-w-md" role="alertdialog" aria-modal="true" data-attr="posthog-inbox-backlog-confirm">
            <DialogHeader>
              <DialogTitle>Start {plural(selected.length, 'session')}?</DialogTitle>
              <DialogDescription>
                Talyn starts one session for each selected report. Each session opens a pull request.
              </DialogDescription>
            </DialogHeader>
            <p className="text-sm text-muted-foreground" data-attr="posthog-inbox-backlog-confirm-cap">
              {dailyCapLine(page, selected.length)}
            </p>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={running}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void run()} disabled={running} data-attr="posthog-inbox-backlog-confirm-run">
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : `Start ${plural(selected.length, 'session')}`}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

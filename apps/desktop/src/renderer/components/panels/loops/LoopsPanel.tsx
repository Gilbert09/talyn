import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Pencil, Play, Plus, Repeat, Trash2 } from 'lucide-react';
import type { LoopInput, LoopRun, LoopWithStats } from '@talyn/shared';
import {
  describeSchedule,
  presetForCron,
  LOOP_DISABLED_REASON_LABELS,
  LOOP_RUN_FAILURE_LABELS,
  LOOP_RUN_STATUS_LABELS,
  LOOP_TARGET_LABELS,
} from '@talyn/shared';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { toast, type ToastAction } from '../../../stores/toast';
import { useNavigationStore } from '../../../stores/navigation';
import { useWorkspaceStore } from '../../../stores/workspace';
import { maybeHandleBillingLimit, useBillingStore } from '../../../stores/billing';
import { captureAnalyticsException, trackEvent } from '../../../lib/analytics';
import { cn } from '../../../lib/utils';
import { takeAutomationTarget, useAutomationFocus } from '../../../lib/automationFocus';
import { FeedbackButton } from '../workflows/FeedbackButton';
import { useLoops } from './useLoops';
import { LoopEditorPage } from './LoopEditorPage';
import { LoopRunsList } from './LoopRunsList';

/**
 * Loops — recurring prompts on a cron schedule.
 *
 * Not built on `GitHubPageShell` for the reason the Workflows page is not: that
 * shell is PR-shaped, and a loop is not a PR.
 *
 * Each row leads with **next run** and **last run**, because the question
 * somebody actually has about a schedule is "is this still happening?" — and a
 * loop that silently stopped looks exactly like one that has nothing to do,
 * unless both ends of the answer are on screen.
 */

function StatCell({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-16">
      <div className="text-[13px] font-medium tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function relativePast(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function relativeFuture(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const mins = Math.round((then - Date.now()) / 60000);
  // A next-run in the past is not a bug: the sweep runs every 30 seconds, and
  // a loop overdue by a minute is one that is about to fire.
  if (mins <= 0) return 'due now';
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function LoopRow({
  loop,
  expanded,
  onToggleExpanded,
  onEdit,
  onDelete,
  onSetEnabled,
  onRunNow,
  starting,
  liveRuns,
}: {
  loop: LoopWithStats;
  expanded: boolean;
  onToggleExpanded: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSetEnabled: (enabled: boolean) => void;
  onRunNow: () => void;
  /** A run-now request is in flight. The server answers only once the session or task exists. */
  starting: boolean;
  liveRuns: ReturnType<typeof useLoops>['liveRuns'];
}) {
  const { stats } = loop;
  return (
    <div>
      <div className="flex items-start gap-3 px-3 py-2">
        <button
          className="mt-0.5 text-muted-foreground hover:text-foreground"
          onClick={onToggleExpanded}
          title={expanded ? 'Hide history' : 'Show history'}
          data-attr="loop-toggle-history"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn('text-[13px] font-medium', !loop.enabled && 'text-muted-foreground')}>
              {loop.name}
            </span>
            {!loop.enabled && <Badge variant="secondary">Off</Badge>}
            {stats.failures7d > 0 && (
              <Badge variant="warning">
                {stats.failures7d} problem{stats.failures7d === 1 ? '' : 's'} this week
              </Badge>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {describeSchedule(loop.cron, loop.timezone)} &middot; {loop.repoFullName} &middot;{' '}
            {LOOP_TARGET_LABELS[loop.target]} &middot; <span className="font-mono text-xs">{loop.model}</span>
          </p>
          {/* The engine switched this off. Says which reason, because every one
              of them has a different fix. */}
          {loop.disabledReason && (
            <p className="mt-0.5 text-xs text-yellow-500">
              {LOOP_DISABLED_REASON_LABELS[loop.disabledReason]}
            </p>
          )}
        </div>

        <div className="flex items-start gap-4 pr-2">
          <StatCell
            label="next run"
            value={loop.enabled ? relativeFuture(loop.nextRunAt) : 'paused'}
          />
          <StatCell
            label={stats.lastStatus ? LOOP_RUN_STATUS_LABELS[stats.lastStatus] : 'last run'}
            value={relativePast(stats.lastRunAt)}
          />
          <StatCell label="7d" value={stats.runs7d} />
          <StatCell label="all time" value={stats.runsTotal} />
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant={loop.enabled ? 'secondary' : 'outline'}
            size="sm"
            data-attr="loop-toggle-enabled"
            onClick={() => onSetEnabled(!loop.enabled)}
          >
            {loop.enabled ? 'On' : 'Off'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRunNow}
            disabled={starting}
            title={starting ? 'Starting a run' : 'Run now'}
            data-attr="loop-run-now"
          >
            {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={onEdit} title="Edit">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onDelete} title="Delete">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="border-t">
          {starting && (
            <p className="flex items-center gap-2 border-b px-3 py-2 text-[13px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Starting a run&hellip;
            </p>
          )}
          <LoopRunsList loopId={loop.id} liveRuns={liveRuns[loop.id]} />
        </div>
      )}
    </div>
  );
}

export function LoopsPanel() {
  const { loops, error, create, update, remove, setEnabled, runNow, liveRuns, agents } = useLoops();
  const [view, setView] = useState<{ mode: 'list' } | { mode: 'edit'; loop: LoopWithStats | null }>({
    mode: 'list',
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LoopWithStats | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [starting, setStarting] = useState<ReadonlySet<string>>(() => new Set());
  const navigate = useNavigationStore((s) => s.navigate);
  const selectTask = useWorkspaceStore((s) => s.selectTask);
  const setActivePanel = useWorkspaceStore((s) => s.setActivePanel);

  /**
   * The one loop event the server cannot see.
   *
   * Everything else is captured in the routes on purpose — a client that
   * reports nothing must not be able to hide adoption. Abandonment only exists
   * here: somebody who opens the editor and never saves makes no request at all.
   */
  const openEditor = (loop: LoopWithStats | null) => {
    trackEvent('loop_editor_opened', { mode: loop ? 'edit' : 'create' });
    setView({ mode: 'edit', loop });
  };

  // The command palette asked for one of these loops: open its editor once the list is here.
  const focus = useAutomationFocus((s) => s.target);
  useEffect(() => {
    const loop = takeAutomationTarget('loop', 'schedule', loops);
    if (loop) openEditor(loop);
  }, [focus, loops]);

  /**
   * Start a new loop — unless the free plan has no slot left, in which case
   * pitch the upgrade instead of opening the editor.
   *
   * The server gate is the real one; this only moves the refusal to before the
   * form. Writing a prompt, picking a schedule and an agent and THEN being told
   * you may not keep it is the worst order to learn it in. The snapshot is
   * owner-wide, so it counts loops in workspaces this page cannot see.
   *
   * `status` may be null (still loading) or the limit null (unlimited / billing
   * off); both mean "no reason to refuse" and fall through to the editor.
   */
  const openNew = () => {
    const status = useBillingStore.getState().status;
    if (status && status.loopLimit != null && status.loops >= status.loopLimit) {
      trackEvent('paywall_shown', {
        // The same event the 402 path fires, so the funnel keeps one
        // denominator; `trigger` is what says this one came before the request.
        reason: 'loop_limit',
        trigger: 'loop_new',
        loops: status.loops,
        loop_limit: status.loopLimit,
        plan: status.plan,
      });
      useBillingStore.getState().setUpgradeModalOpen(true, 'loop_limit');
      return;
    }
    openEditor(null);
  };

  const save = async (input: LoopInput) => {
    if (view.mode === 'edit' && view.loop) {
      await update(view.loop.id, input);
      trackEvent('loop_saved', { new: false, schedule_kind: presetForCron(input.cron).kind, internet_access: Boolean(input.internetAccess) });
      toast.success('Automation saved');
    } else {
      try {
        await create(input);
      } catch (err) {
        // A free plan that filled its last slot elsewhere (another window,
        // another workspace) only finds out here. The modal explains it, so
        // swallow the throw and leave the editor open with the user's work in it.
        if (maybeHandleBillingLimit(err, 'loop_create')) {
          captureAnalyticsException(err, { flow: 'loop_save' });
          return;
        }
        throw err;
      }
      trackEvent('loop_saved', { new: true, schedule_kind: presetForCron(input.cron).kind, internet_access: Boolean(input.internetAccess) });
      toast.success('Automation created');
      // Keep the owner-wide count current, so the NEXT click is pre-empted
      // rather than round-tripping to the same refusal.
      void useBillingStore.getState().refresh();
    }
    setView({ mode: 'list' });
  };

  if (view.mode === 'edit') {
    return (
      <LoopEditorPage
        editing={view.loop}
        agents={agents}
        onCancel={() => setView({ mode: 'list' })}
        onSave={save}
      />
    );
  }

  /**
   * Perform the delete the dialog is asking about.
   *
   * The confirmation is a dialog rather than a second click on the same button.
   * Click-to-arm put the question in a toast — the corner nobody is looking at
   * — and made one gesture mean both "ask" and "do", so an impatient second
   * click on a slow row deleted without anyone reading anything.
   */
  const doDelete = async () => {
    const loop = pendingDelete;
    if (!loop) return;
    setDeleting(true);
    try {
      await remove(loop.id);
      // Closed only on success, so a failure leaves the dialog open with the
      // error beside it rather than dropping the user back with no explanation.
      setPendingDelete(null);
      trackEvent('loop_deleted');
      toast.success('Automation deleted');
      // A deleted row gives its free-plan slot back — re-read the count so
      // the create button stops pre-empting on a limit the user is no longer at.
      void useBillingStore.getState().refresh();
    } catch (err) {
      captureAnalyticsException(err, { flow: 'loop_delete' });
      toast.error('Could not delete', err instanceof Error ? err.message : undefined);
    } finally {
      setDeleting(false);
    }
  };

  /** A button on the toast that goes to what the run started. */
  const openRunAction = (run: LoopRun): ToastAction | undefined => {
    const sessionId = run.sessionId;
    if (sessionId) return { label: 'Open session', onClick: () => navigate({ view: 'workbench', id: sessionId }) };
    const taskId = run.taskId;
    if (taskId) {
      return {
        label: 'Open task',
        onClick: () => {
          selectTask(taskId);
          setActivePanel('queue');
        },
      };
    }
    return undefined;
  };

  /**
   * Run now.
   *
   * The request returns only after the session or task exists, which takes some
   * seconds. So the row shows that it is starting at once, and the toast at the
   * end says what the run did — "started" for a run that was refused is wrong.
   */
  const doRunNow = async (loop: LoopWithStats) => {
    if (starting.has(loop.id)) return;
    setStarting((prev) => new Set(prev).add(loop.id));
    setExpandedId(loop.id);
    try {
      const run = await runNow(loop.id);
      trackEvent('loop_run_now');
      const reason = run?.failureCode ? LOOP_RUN_FAILURE_LABELS[run.failureCode] : run?.error ?? undefined;
      if (!run) {
        toast.info('Run requested', 'Watch the history for what it did.');
      } else if (run.status === 'failed') {
        toast.error('The run did not start', reason);
      } else if (run.status === 'waiting_slot') {
        toast.info('The run is waiting to start', reason);
      } else if (run.status === 'skipped') {
        toast.info('The run was skipped', reason);
      } else {
        toast.success(
          `Started ${loop.name}`,
          run.target === 'session' ? 'A new session is working on it.' : 'A new task is working on it.',
          openRunAction(run)
        );
      }
    } catch (err) {
      captureAnalyticsException(err, { flow: 'loop_run_now' });
      toast.error('Could not run that', err instanceof Error ? err.message : undefined);
    } finally {
      setStarting((prev) => {
        const next = new Set(prev);
        next.delete(loop.id);
        return next;
      });
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-1">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          An automation runs on a schedule and starts a session or a task.
        </p>
        <FeedbackButton surface="loops" />
        <Button size="sm" onClick={openNew} data-attr="loop-new">
          <Plus className="mr-1 h-3.5 w-3.5" />
          New automation
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {error && <p className="mb-3 text-[13px] text-red-500">{error}</p>}

        {/* `null` is loading, `[]` is genuinely none. Rendering the empty state
            for both would flash "no loops" at somebody who has ten. */}
        {loops === null ? (
          <p className="text-[13px] text-muted-foreground">Loading automations...</p>
        ) : loops.length === 0 ? (
          <div className="mx-auto max-w-lg py-10 text-center">
            <Repeat className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
            <h2 className="text-[13px] font-medium">No automations yet</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              An automation runs the same prompt on a repository on a schedule — sweep yesterday&rsquo;s
              failing checks every morning, keep dependencies current every Monday, or draft the
              release notes every Friday at five.
            </p>
            <Button className="mt-4" onClick={openNew}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Create an automation
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-border/60 rounded-lg border bg-card">
            {loops.map((loop) => (
              <LoopRow
                key={loop.id}
                loop={loop}
                liveRuns={liveRuns}
                expanded={expandedId === loop.id}
                onToggleExpanded={() => setExpandedId((id) => (id === loop.id ? null : loop.id))}
                onEdit={() => openEditor(loop)}
                onDelete={() => setPendingDelete(loop)}
                onRunNow={() => void doRunNow(loop)}
                starting={starting.has(loop.id)}
                onSetEnabled={(enabled) => {
                  void setEnabled(loop, enabled)
                    .then(() => trackEvent(enabled ? 'loop_enabled' : 'loop_disabled'))
                    .catch((err: unknown) => {
                      captureAnalyticsException(err, { flow: 'loop_toggle' });
                      toast.error('Could not change that', err instanceof Error ? err.message : undefined);
                    });
                }}
              />
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this automation?"
        description={
          <>
            Deleting <span className="font-medium text-foreground">{pendingDelete?.name}</span> 
            also removes its run history. Nothing it already did is undone.
          </>
        }
        confirmLabel="Delete"
        busy={deleting}
        onConfirm={() => void doDelete()}
        onCancel={() => setPendingDelete(null)}
      />

    </div>
  );
}

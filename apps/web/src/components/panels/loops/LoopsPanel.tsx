import { useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, Play, Plus, Repeat, Trash2 } from 'lucide-react';
import type { LoopInput, LoopWithStats } from '@talyn/shared';
import {
  describeSchedule,
  LOOP_DISABLED_REASON_LABELS,
  LOOP_RUN_STATUS_LABELS,
} from '@talyn/shared';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { toast } from '../../../stores/toast';
import { trackEvent } from '../../../lib/analytics';
import { cn } from '../../../lib/utils';
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
      <div className="text-sm font-medium tabular-nums">{value}</div>
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
  liveRuns,
}: {
  loop: LoopWithStats;
  expanded: boolean;
  onToggleExpanded: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSetEnabled: (enabled: boolean) => void;
  onRunNow: () => void;
  liveRuns: ReturnType<typeof useLoops>['liveRuns'];
}) {
  const { stats } = loop;
  return (
    <div className="rounded-lg border">
      <div className="flex items-start gap-3 p-4">
        <button
          className="mt-0.5 text-muted-foreground hover:text-foreground"
          onClick={onToggleExpanded}
          title={expanded ? 'Hide history' : 'Show history'}
          data-attr="loop-toggle-history"
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn('font-medium', !loop.enabled && 'text-muted-foreground')}>
              {loop.name}
            </span>
            {!loop.enabled && <Badge variant="secondary">Off</Badge>}
            {stats.failures7d > 0 && (
              <Badge variant="warning">
                {stats.failures7d} problem{stats.failures7d === 1 ? '' : 's'} this week
              </Badge>
            )}
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {describeSchedule(loop.cron, loop.timezone)} &middot; {loop.repoFullName} &middot;{' '}
            <span className="font-mono text-xs">{loop.model}</span>
          </p>
          {/* The engine switched this off. Says which reason, because every one
              of them has a different fix. */}
          {loop.disabledReason && (
            <p className="mt-1 text-xs text-yellow-500">
              {LOOP_DISABLED_REASON_LABELS[loop.disabledReason]}
            </p>
          )}
        </div>

        <div className="flex items-start gap-5 pr-2">
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
          <Button variant="ghost" size="sm" onClick={onRunNow} title="Run now">
            <Play className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onEdit} title="Edit">
            <Pencil className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onDelete} title="Delete">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="border-t">
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
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

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

  const openNew = () => openEditor(null);

  const save = async (input: LoopInput) => {
    if (view.mode === 'edit' && view.loop) {
      await update(view.loop.id, input);
      toast.success('Loop saved');
    } else {
      await create(input);
      toast.success('Loop created');
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

  const doDelete = async (loop: LoopWithStats) => {
    // Two clicks rather than a modal: deleting a loop also deletes its history
    // (the runs cascade), but nothing it already did is undone.
    if (confirmDelete !== loop.id) {
      setConfirmDelete(loop.id);
      window.setTimeout(() => setConfirmDelete((id) => (id === loop.id ? null : id)), 4000);
      toast.info('Click delete again to confirm', 'This also removes its run history.');
      return;
    }
    setConfirmDelete(null);
    try {
      await remove(loop.id);
      toast.success('Loop deleted');
    } catch (err) {
      toast.error('Could not delete', err instanceof Error ? err.message : undefined);
    }
  };

  const doRunNow = async (loop: LoopWithStats) => {
    try {
      await runNow(loop.id);
      // Deliberately not "started": a run-now can legitimately end as
      // "waiting for a task slot", and the history is where the answer is.
      setExpandedId(loop.id);
      toast.info('Run requested', 'Watch the history for what it did.');
    } catch (err) {
      toast.error('Could not run that', err instanceof Error ? err.message : undefined);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b px-6 py-4">
        <Repeat className="h-5 w-5" />
        <div className="flex-1">
          <h1 className="text-lg font-semibold">Loops</h1>
          <p className="text-sm text-muted-foreground">
            Run a prompt on a schedule. Every run starts a cloud task on the agent you pick, and
            opens a pull request if the work warrants one.
          </p>
        </div>
        <FeedbackButton surface="loops" />
        <Button onClick={openNew} data-attr="loop-new">
          <Plus className="mr-1 h-4 w-4" />
          New loop
        </Button>
      </header>

      <div className="flex-1 overflow-auto p-6">
        {error && <p className="mb-4 text-sm text-red-500">{error}</p>}

        {/* `null` is loading, `[]` is genuinely none. Rendering the empty state
            for both would flash "no loops" at somebody who has ten. */}
        {loops === null ? (
          <p className="text-sm text-muted-foreground">Loading loops...</p>
        ) : loops.length === 0 ? (
          <div className="mx-auto max-w-lg py-12 text-center">
            <Repeat className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <h2 className="font-medium">No loops yet</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              A loop runs the same prompt on a repository on a schedule — sweep yesterday&rsquo;s
              failing checks every morning, keep dependencies current every Monday, or draft the
              release notes every Friday at five.
            </p>
            <Button className="mt-4" onClick={openNew}>
              <Plus className="mr-1 h-4 w-4" />
              Create your first loop
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {loops.map((loop) => (
              <LoopRow
                key={loop.id}
                loop={loop}
                liveRuns={liveRuns}
                expanded={expandedId === loop.id}
                onToggleExpanded={() => setExpandedId((id) => (id === loop.id ? null : loop.id))}
                onEdit={() => openEditor(loop)}
                onDelete={() => void doDelete(loop)}
                onRunNow={() => void doRunNow(loop)}
                onSetEnabled={(enabled) => {
                  void setEnabled(loop, enabled).catch((err: unknown) =>
                    toast.error(
                      'Could not change that',
                      err instanceof Error ? err.message : undefined
                    )
                  );
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

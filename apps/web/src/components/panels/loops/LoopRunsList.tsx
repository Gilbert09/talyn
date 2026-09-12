import { ExternalLink, RefreshCw } from 'lucide-react';
import {
  LOOP_RUN_FAILURE_LABELS,
  LOOP_RUN_STATUS_LABELS,
  type LoopRun,
  type LoopRunStatus,
} from '@talyn/shared';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { cn } from '../../../lib/utils';
import { useLoopRuns } from './useLoops';

/**
 * One loop's history.
 *
 * The columns answer the three questions somebody actually has about a
 * schedule: did it fire when it should have, what did it do, and if it did not
 * run, why not. The last one is why a refusal renders its own sentence instead
 * of a red dot — "skipped" alone sends the reader to the logs.
 */

const STATUS_VARIANT: Record<
  LoopRunStatus,
  'default' | 'secondary' | 'success' | 'warning' | 'error'
> = {
  waiting_slot: 'warning',
  queued: 'secondary',
  running: 'default',
  succeeded: 'success',
  failed: 'error',
  // Grey, not yellow. A skip is the overlap rule working, and a wall of amber
  // would read as a wall of problems on a loop doing exactly what it was told.
  skipped: 'secondary',
};

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * How long the run took, when it is over.
 *
 * Measured from the run's own start rather than the task's, because the wait
 * for a dispatcher tick is part of what a user experiences as "how long this
 * took".
 */
function duration(run: LoopRun): string | null {
  const end = run.task?.completedAt ?? run.settledAt;
  if (!end) return null;
  const ms = new Date(end).getTime() - new Date(run.createdAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/**
 * Whether the firing ran late, and by how much.
 *
 * `scheduled_for` is the occurrence the run stands for, which after a deploy or
 * an outage can be hours before it actually started. Showing the gap is how
 * catch-up stays honest — the alternative is a history that quietly claims the
 * 09:00 run happened at 09:00.
 */
function lateness(run: LoopRun): string | null {
  if (run.trigger === 'manual') return null;
  const gapMs = new Date(run.createdAt).getTime() - new Date(run.scheduledFor).getTime();
  const mins = Math.round(gapMs / 60000);
  if (!Number.isFinite(mins) || mins < 2) return null;
  if (mins < 60) return `${mins}m late`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h late` : `${Math.round(hours / 24)}d late`;
}

function RunRow({ run }: { run: LoopRun }) {
  const late = lateness(run);
  const took = duration(run);
  return (
    <div className="flex items-start gap-3 border-b px-4 py-2.5 last:border-b-0">
      <Badge variant={STATUS_VARIANT[run.status]} className="mt-0.5 shrink-0">
        {LOOP_RUN_STATUS_LABELS[run.status]}
      </Badge>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="tabular-nums">{when(run.createdAt)}</span>
          {run.trigger === 'manual' && <Badge variant="secondary">Run now</Badge>}
          {late && <span className="text-xs text-muted-foreground">{late}</span>}
          {took && <span className="text-xs text-muted-foreground">took {took}</span>}
        </div>
        {/* The reason line. A failure code is a sentence the user can act on;
            a bare error string is what we fall back to when there is no code. */}
        {(run.failureCode || run.error) && (
          <p
            className={cn(
              'mt-0.5 text-xs',
              run.status === 'failed' ? 'text-red-500' : 'text-muted-foreground'
            )}
          >
            {run.failureCode ? LOOP_RUN_FAILURE_LABELS[run.failureCode] : run.error}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
        <span className="font-mono">{run.model}</span>
        {run.task?.prNumber && run.task.prUrl && (
          <a
            className="flex items-center gap-1 hover:text-foreground"
            href={run.task.prUrl}
            target="_blank"
            rel="noreferrer"
          >
            #{run.task.prNumber}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}

export function LoopRunsList({
  loopId,
  liveRuns,
}: {
  loopId: string;
  liveRuns: LoopRun[] | undefined;
}) {
  const { runs, loading, error, loadMore, hasMore } = useLoopRuns(loopId, liveRuns);

  if (error) return <p className="px-4 py-3 text-sm text-red-500">{error}</p>;
  if (loading && runs.length === 0) {
    return <p className="px-4 py-3 text-sm text-muted-foreground">Loading history...</p>;
  }
  if (runs.length === 0) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        This loop has not run yet. It will appear here the moment it does.
      </p>
    );
  }

  return (
    <div>
      {runs.map((run) => (
        <RunRow key={run.id} run={run} />
      ))}
      {hasMore && (
        <div className="px-4 py-2">
          <Button variant="ghost" size="sm" onClick={loadMore} disabled={loading}>
            <RefreshCw className={cn('mr-1 h-3 w-3', loading && 'animate-spin')} />
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

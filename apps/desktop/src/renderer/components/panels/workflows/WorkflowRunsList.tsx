import { ExternalLink } from 'lucide-react';
import type { WorkflowActionOutcome, WorkflowRun, WorkflowRunStatus } from '@talyn/shared';
import {
  WORKFLOW_ACTION_LABELS,
  WORKFLOW_EVENT_LABELS,
  WORKFLOW_RUN_STATUS_LABELS,
} from '@talyn/shared';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { useWorkflowRuns } from './useWorkflows';
import { useWorkspaceStore } from '../../../stores/workspace';

/**
 * One workflow's history.
 *
 * Every run is shown, including the ones that did nothing: a `skipped` row is
 * the rate cap explaining itself, and a `partial` row is the whole reason the
 * per-action outcomes are stored rather than a single boolean. A history that
 * only showed successes would hide exactly the rows worth reading.
 */

function statusVariant(status: WorkflowRunStatus): 'success' | 'warning' | 'error' | 'secondary' {
  switch (status) {
    case 'succeeded':
      return 'success';
    case 'partial':
      return 'warning';
    case 'failed':
      return 'error';
    default:
      // `running` and `skipped` are both "nothing to celebrate, nothing broken".
      return 'secondary';
  }
}

function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function OutcomeLine({ outcome }: { outcome: WorkflowActionOutcome }) {
  const label = WORKFLOW_ACTION_LABELS[outcome.type] ?? outcome.type;
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className={outcome.ok ? 'text-green-500' : 'text-red-500'}>{outcome.ok ? '+' : 'x'}</span>
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">{outcome.detail ?? outcome.error ?? ''}</span>
    </div>
  );
}

export function WorkflowRunsList({
  workflowId,
  liveRuns,
}: {
  workflowId: string;
  liveRuns: WorkflowRun[] | undefined;
}) {
  const { runs, loading, error, loadMore, hasMore } = useWorkflowRuns(workflowId, liveRuns);
  const setActivePanel = useWorkspaceStore((s) => s.setActivePanel);
  const selectTask = useWorkspaceStore((s) => s.selectTask);

  if (error) {
    return <p className="p-4 text-sm text-red-500">{error}</p>;
  }
  if (loading && runs.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">Loading history...</p>;
  }
  if (runs.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        This workflow has not run yet. It fires on the next matching pull request event.
      </p>
    );
  }

  return (
    <div className="divide-y">
      {runs.map((run) => (
        <div key={run.id} className="space-y-1.5 px-4 py-3">
          <div className="flex items-center gap-2 text-sm">
            <Badge variant={statusVariant(run.status)}>
              {WORKFLOW_RUN_STATUS_LABELS[run.status]}
            </Badge>
            <span className="text-muted-foreground">
              {WORKFLOW_EVENT_LABELS[run.event] ?? run.event}
            </span>
            <span className="text-muted-foreground">on</span>
            {run.prUrl ? (
              <a
                href={run.prUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 font-medium hover:underline"
              >
                {run.repoFullName}#{run.prNumber}
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              <span className="font-medium">
                {run.repoFullName}#{run.prNumber}
              </span>
            )}
            <span className="ml-auto text-xs text-muted-foreground">
              {relative(run.createdAt)}
            </span>
          </div>

          {run.prTitle && (
            <p className="truncate text-xs text-muted-foreground">{run.prTitle}</p>
          )}

          <div className="space-y-0.5">
            {run.actions.map((outcome, i) => (
              <OutcomeLine key={i} outcome={outcome} />
            ))}
          </div>

          {run.taskId && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => {
                selectTask(run.taskId);
                setActivePanel('queue');
              }}
            >
              Open the task it started
            </Button>
          )}
        </div>
      ))}

      {hasMore && (
        <div className="p-3">
          <Button variant="outline" size="sm" onClick={loadMore} disabled={loading}>
            {loading ? 'Loading...' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}

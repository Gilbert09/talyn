import { useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2, Workflow } from 'lucide-react';
import type { WorkflowInput, WorkflowWithStats } from '@talyn/shared';
import {
  describeWorkflowActions,
  describeWorkflowTrigger,
  WORKFLOW_RUN_STATUS_LABELS,
} from '@talyn/shared';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { toast } from '../../../stores/toast';
import { trackEvent } from '../../../lib/analytics';
import { cn } from '../../../lib/utils';
import { FeedbackButton } from './FeedbackButton';
import { useWorkflows } from './useWorkflows';
import { WorkflowEditorPage } from './WorkflowEditorPage';
import { WorkflowRunsList } from './WorkflowRunsList';

/**
 * Workflows — user-defined PR automation.
 *
 * Deliberately not built on `GitHubPageShell`: that shell is PR-shaped (its
 * `rows: PRRow[]` drives the Copy-list action, the empty states and the
 * cohort announcement the adaptive poller reads), and a workflow is not a PR.
 *
 * Each row carries its own stats, because the question a user actually has
 * about an automation is "is this still firing?" — and a rule that quietly
 * stopped matching looks identical to one that never had anything to do,
 * unless the counters are on screen next to it.
 */

function StatCell({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-16">
      <div className="text-sm font-medium tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function relative(iso: string | null): string {
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

function WorkflowRow({
  workflow,
  expanded,
  onToggleExpanded,
  onEdit,
  onDelete,
  onSetEnabled,
  liveRuns,
}: {
  workflow: WorkflowWithStats;
  expanded: boolean;
  onToggleExpanded: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSetEnabled: (enabled: boolean) => void;
  liveRuns: ReturnType<typeof useWorkflows>['liveRuns'];
}) {
  const { stats } = workflow;
  return (
    <div className="rounded-lg border">
      <div className="flex items-start gap-3 p-4">
        <button
          className="mt-0.5 text-muted-foreground hover:text-foreground"
          onClick={onToggleExpanded}
          title={expanded ? 'Hide history' : 'Show history'}
          data-attr="workflow-toggle-history"
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn('font-medium', !workflow.enabled && 'text-muted-foreground')}>
              {workflow.name}
            </span>
            {!workflow.enabled && <Badge variant="secondary">Off</Badge>}
            {stats.failures7d > 0 && (
              <Badge variant="warning">
                {stats.failures7d} problem{stats.failures7d === 1 ? '' : 's'} this week
              </Badge>
            )}
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            When {describeWorkflowTrigger(workflow).toLowerCase()} &rarr;{' '}
            {describeWorkflowActions(workflow).toLowerCase()}
          </p>
        </div>

        <div className="flex items-start gap-5 pr-2">
          <StatCell label="24h" value={stats.runs24h} />
          <StatCell label="7d" value={stats.runs7d} />
          <StatCell label="all time" value={stats.runsTotal} />
          <StatCell label="tasks" value={stats.tasksStarted} />
          <StatCell
            label={stats.lastStatus ? WORKFLOW_RUN_STATUS_LABELS[stats.lastStatus] : 'last run'}
            value={relative(stats.lastRunAt)}
          />
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant={workflow.enabled ? 'secondary' : 'outline'}
            size="sm"
            data-attr="workflow-toggle-enabled"
            onClick={() => onSetEnabled(!workflow.enabled)}
          >
            {workflow.enabled ? 'On' : 'Off'}
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
          <WorkflowRunsList workflowId={workflow.id} liveRuns={liveRuns[workflow.id]} />
        </div>
      )}
    </div>
  );
}

export function WorkflowsPanel() {
  const {
    workflows,
    error,
    create,
    update,
    remove,
    setEnabled,
    liveRuns,
    suggestions,
    loadGithubSuggestions,
  } = useWorkflows();
  /**
   * The editor is a PAGE, not a modal — but not a route either.
   *
   * `activePanel` is the app's whole routing vocabulary and `PANEL_PATHS` is a flat
   * `Record<ActivePanel, string>` of static paths, so a parameterised
   * `/workflows/:id` would mean changing that contract on the web fork while the
   * desktop (which has no URLs at all) kept view state anyway — two different
   * mechanisms for one screen. This keeps both forks identical. The cost is honest:
   * no deep link to a specific workflow's editor.
   */
  const [view, setView] = useState<{ mode: 'list' } | { mode: 'edit'; workflow: WorkflowWithStats | null }>(
    { mode: 'list' }
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  /**
   * The one workflow event the server cannot see.
   *
   * Everything else is captured in the routes, deliberately — a client that
   * reports nothing must not be able to hide adoption. But abandonment only
   * exists on the client: somebody who opens the editor and never saves makes no
   * request at all, and "opened 40, created 3" is the shape of a form that is
   * too hard, which no server-side event can tell you.
   */
  const openEditor = (workflow: WorkflowWithStats | null) => {
    trackEvent('workflow_editor_opened', { mode: workflow ? 'edit' : 'create' });
    setView({ mode: 'edit', workflow });
  };

  const openNew = () => openEditor(null);

  const save = async (input: WorkflowInput) => {
    if (view.mode === 'edit' && view.workflow) {
      await update(view.workflow.id, input);
      toast.success('Workflow saved');
    } else {
      await create(input);
      toast.success('Workflow created');
    }
    setView({ mode: 'list' });
  };

  if (view.mode === 'edit') {
    return (
      <WorkflowEditorPage
        editing={view.workflow}
        suggestions={suggestions}
        onNeedGithubSuggestions={loadGithubSuggestions}
        onCancel={() => setView({ mode: 'list' })}
        onSave={save}
      />
    );
  }

  const doDelete = async (workflow: WorkflowWithStats) => {
    // Two clicks rather than a modal: deleting a workflow also deletes its
    // history (the runs cascade), but nothing it already did is undone, so this
    // is not a destructive action that warrants a whole dialog.
    if (confirmDelete !== workflow.id) {
      setConfirmDelete(workflow.id);
      window.setTimeout(() => setConfirmDelete((id) => (id === workflow.id ? null : id)), 4000);
      toast.info('Click delete again to confirm', 'This also removes its run history.');
      return;
    }
    setConfirmDelete(null);
    try {
      await remove(workflow.id);
      toast.success('Workflow deleted');
    } catch (err) {
      toast.error('Could not delete', err instanceof Error ? err.message : undefined);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b px-6 py-4">
        <Workflow className="h-5 w-5" />
        <div className="flex-1">
          <h1 className="text-lg font-semibold">Workflows</h1>
          <p className="text-sm text-muted-foreground">
            Automate what happens on a pull request. Fires on every PR in the repositories this
            workspace watches, including ones you did not open.
          </p>
        </div>
        <FeedbackButton surface="workflows" />
        <Button onClick={openNew} data-attr="workflow-new">
          <Plus className="mr-1 h-4 w-4" />
          New workflow
        </Button>
      </header>

      <div className="flex-1 overflow-auto p-6">
        {error && <p className="mb-4 text-sm text-red-500">{error}</p>}

        {/* `null` is loading, `[]` is genuinely none. Rendering the empty state
            for both would flash "no workflows" at somebody who has ten. */}
        {workflows === null ? (
          <p className="text-sm text-muted-foreground">Loading workflows...</p>
        ) : workflows.length === 0 ? (
          <div className="mx-auto max-w-lg py-12 text-center">
            <Workflow className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <h2 className="font-medium">No workflows yet</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              A workflow watches for something on a pull request and then acts: label it, pull in a
              reviewer, comment, add it to My PRs, run a skill, or send it to the merge queue.
            </p>
            <Button className="mt-4" onClick={openNew}>
              <Plus className="mr-1 h-4 w-4" />
              Create your first workflow
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {workflows.map((workflow) => (
              <WorkflowRow
                key={workflow.id}
                workflow={workflow}
                liveRuns={liveRuns}
                expanded={expandedId === workflow.id}
                onToggleExpanded={() =>
                  setExpandedId((id) => (id === workflow.id ? null : workflow.id))
                }
                onEdit={() => openEditor(workflow)}
                onDelete={() => void doDelete(workflow)}
                onSetEnabled={(enabled) => {
                  void setEnabled(workflow, enabled).catch((err: unknown) =>
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

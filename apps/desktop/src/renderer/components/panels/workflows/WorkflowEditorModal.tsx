import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type {
  WorkflowAction,
  WorkflowActionType,
  WorkflowActorMatch,
  WorkflowConditions,
  WorkflowInput,
  WorkflowTriggerEvent,
  WorkflowWithStats,
} from '@talyn/shared';
import {
  availableWorkflowConditions,
  emptyWorkflowAction,
  emptyWorkflowInput,
  MAX_WORKFLOW_NAME_LENGTH,
  pruneWorkflowConditions,
  WORKFLOW_ACTION_LABELS,
  WORKFLOW_ACTION_TYPES,
  WORKFLOW_EVENT_LABELS,
  WORKFLOW_EVENTS_REQUIRING_TRACKED_PR,
  WORKFLOW_TRIGGER_EVENTS,
  workflowInputProblem,
  workflowToInput,
} from '@talyn/shared';
import { Button } from '../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { Input } from '../../ui/input';
import { Select } from '../../ui/select';
import { Textarea } from '../../ui/textarea';
import { cn } from '../../../lib/utils';
import { useWorkspaceStore } from '../../../stores/workspace';

/**
 * The workflow editor.
 *
 * Three sections in the order the sentence reads: WHEN (trigger events), IF
 * (conditions), THEN (actions). Which conditions are offered depends on the
 * trigger — `availableWorkflowConditions` mirrors what the validator will
 * accept, so the form cannot compose a workflow the API then refuses — and
 * changing the trigger PRUNES the conditions that no longer apply, or the save
 * would 400 about a field the user can no longer see.
 */

interface Props {
  open: boolean;
  /** The workflow being edited, or null to create a new one. */
  editing: WorkflowWithStats | null;
  onClose: () => void;
  onSave: (input: WorkflowInput) => Promise<void>;
}

/** A comma-separated text field over a string list. */
function ListField({
  label,
  hint,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  hint?: string;
  values: string[] | undefined;
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  // Held as text while typing, so a trailing comma does not vanish mid-word.
  const joined = (values ?? []).join(', ');
  const [text, setText] = useState(joined);
  useEffect(() => {
    setText(joined);
  }, [joined]);
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <Input
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          onChange(
            e.target.value
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean)
          );
        }}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Exact logins, or a class. "Anyone" is the absence of a constraint. */
function ActorField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: WorkflowActorMatch | undefined;
  onChange: (next: WorkflowActorMatch | undefined) => void;
}) {
  const kind = value?.kind ?? 'any';
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <Select
        value={kind}
        onChange={(e) => {
          const next = e.target.value as WorkflowActorMatch['kind'];
          if (next === 'any') onChange(undefined);
          else if (next === 'logins') onChange({ kind: 'logins', logins: [] });
          else onChange({ kind: next });
        }}
      >
        <option value="any">Anyone</option>
        <option value="human">Only people</option>
        <option value="bot">Only bots</option>
        <option value="logins">Specific accounts</option>
      </Select>
      {kind === 'logins' && (
        <ListField
          label="GitHub logins"
          values={value?.kind === 'logins' ? value.logins : []}
          placeholder="dependabot[bot], alice"
          onChange={(logins) => onChange({ kind: 'logins', logins })}
        />
      )}
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/** The editor row for one action. */
function ActionRow({
  action,
  onChange,
  onRemove,
  canRemove,
}: {
  action: WorkflowAction;
  onChange: (next: WorkflowAction) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Select
          className="flex-1"
          value={action.type}
          onChange={(e) => onChange(emptyWorkflowAction(e.target.value as WorkflowActionType))}
        >
          {WORKFLOW_ACTION_TYPES.map((t) => (
            <option key={t} value={t}>
              {WORKFLOW_ACTION_LABELS[t]}
            </option>
          ))}
        </Select>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          disabled={!canRemove}
          title={canRemove ? 'Remove this action' : 'A workflow needs at least one action'}
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>

      {(action.type === 'add_labels' || action.type === 'remove_labels') && (
        <ListField
          label="Labels"
          values={action.labels}
          placeholder="needs-review, frontend"
          onChange={(labels) => onChange({ ...action, labels })}
        />
      )}

      {action.type === 'request_reviewers' && (
        <>
          <ListField
            label="People"
            values={action.users}
            placeholder="alice, bob"
            onChange={(users) => onChange({ ...action, users })}
          />
          <ListField
            label="Teams"
            hint="Team slugs, without the org prefix."
            values={action.teams}
            placeholder="frontend, platform"
            onChange={(teams) => onChange({ ...action, teams })}
          />
        </>
      )}

      {action.type === 'assign' && (
        <ListField
          label="People"
          hint="GitHub ignores anyone who is not a collaborator, without erroring, so Talyn checks what came back and reports the difference."
          values={action.users}
          placeholder="alice"
          onChange={(users) => onChange({ ...action, users })}
        />
      )}

      {action.type === 'comment' && (
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Comment</label>
          <Textarea
            rows={3}
            value={action.body}
            placeholder="Thanks {{pr.author}} - this targets {{pr.baseBranch}}."
            onChange={(e) => onChange({ ...action, body: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            These are filled in: {'{{pr.number}}'}, {'{{pr.title}}'}, {'{{pr.url}}'},{' '}
            {'{{pr.author}}'}, {'{{pr.baseBranch}}'}, {'{{pr.headBranch}}'}, {'{{repo}}'},{' '}
            {'{{actor}}'} and {'{{event}}'}.
          </p>
        </div>
      )}

      {action.type === 'run_skill' && (
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Skill</label>
          <Input
            value={action.skillKey}
            placeholder="repo:owner/repo:my-skill"
            onChange={(e) => onChange({ ...action, skillKey: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            A repo skill (<code>repo:owner/repo:name</code>) or one saved to the workspace (
            <code>platform:id</code>). A skill on your own machine cannot be used, because
            workflows run on the server.
          </p>
        </div>
      )}

      {action.type === 'run_prompt' && (
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Prompt</label>
          <Textarea
            rows={4}
            value={action.prompt}
            placeholder="Review this PR for missing tests and leave your findings as review comments."
            onChange={(e) => onChange({ ...action, prompt: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            The PR is named for the agent already. Write only the instruction.
          </p>
        </div>
      )}

      {action.type === 'enqueue_merge_queue' && (
        <div className="space-y-1">
          <Select
            label="Merge method"
            value={action.method ?? ''}
            onChange={(e) =>
              onChange({
                ...action,
                method: (e.target.value || undefined) as 'squash' | 'merge' | 'rebase' | undefined,
              })
            }
          >
            <option value="">Whatever the PR is set to</option>
            <option value="squash">Squash</option>
            <option value="merge">Merge commit</option>
            <option value="rebase">Rebase</option>
          </Select>
          <p className="text-xs text-muted-foreground">
            Goes through Talyn&apos;s merge queue rather than merging directly, so it still works
            on a branch governed by trunk or a ruleset, and it waits for checks.
          </p>
        </div>
      )}

      {action.type === 'watch_pr' && (
        <p className="text-xs text-muted-foreground">
          Adds the PR to My PRs, exactly as pasting its URL does.
        </p>
      )}

      {(action.type === 'run_skill' || action.type === 'run_prompt') && (
        <p className="text-xs text-muted-foreground">
          Starts a cloud task, so it counts against your plan&apos;s in-flight limit. Talyn never
          starts a second run on a PR that already has one.
        </p>
      )}
    </div>
  );
}

export function WorkflowEditorModal({ open, editing, onClose, onSave }: Props) {
  const repositories = useWorkspaceStore((s) => s.repositories);
  const [input, setInput] = useState<WorkflowInput>(emptyWorkflowInput);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setInput(editing ? workflowToInput(editing) : emptyWorkflowInput());
    setSaveError(null);
  }, [open, editing]);

  const conditions = input.conditions ?? {};
  const allowed = useMemo(() => availableWorkflowConditions(input.events), [input.events]);
  const problem = useMemo(() => workflowInputProblem(input), [input]);

  const setConditions = (next: WorkflowConditions) => setInput((p) => ({ ...p, conditions: next }));

  const toggleEvent = (event: WorkflowTriggerEvent) => {
    setInput((prev) => {
      const events = prev.events.includes(event)
        ? prev.events.filter((e) => e !== event)
        : [...prev.events, event];
      // Prune conditions the new trigger set cannot carry, or the save 400s
      // about a field that is no longer on screen.
      return {
        ...prev,
        events,
        conditions: pruneWorkflowConditions(prev.conditions ?? {}, events),
      };
    });
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(input);
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save this workflow');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl" onClose={onClose}>
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit workflow' : 'New workflow'}</DialogTitle>
          <DialogDescription>
            When something happens on a pull request in this workspace&apos;s repositories, do
            these things.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-1">
            <label className="text-sm font-medium">Name</label>
            <Input
              value={input.name}
              maxLength={MAX_WORKFLOW_NAME_LENGTH}
              placeholder="Label new PRs"
              onChange={(e) => setInput((p) => ({ ...p, name: e.target.value }))}
            />
          </div>

          {/* WHEN */}
          <section className="space-y-2">
            <h3 className="text-sm font-medium">When</h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {WORKFLOW_TRIGGER_EVENTS.map((event) => {
                const trackedOnly = WORKFLOW_EVENTS_REQUIRING_TRACKED_PR.includes(event);
                return (
                  <label
                    key={event}
                    className="flex items-start gap-2 text-sm cursor-pointer py-0.5"
                    title={
                      trackedOnly
                        ? 'Only fires on PRs Talyn already tracks. Check events for untracked PRs are dropped before they reach the workflow engine.'
                        : undefined
                    }
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={input.events.includes(event)}
                      onChange={() => toggleEvent(event)}
                    />
                    <span className={cn(trackedOnly && 'text-muted-foreground')}>
                      {WORKFLOW_EVENT_LABELS[event]}
                      {trackedOnly && <span className="ml-1 text-xs">(tracked PRs only)</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          </section>

          {/* IF */}
          <section className="space-y-3">
            <h3 className="text-sm font-medium">
              Only if <span className="font-normal text-muted-foreground">(all of these)</span>
            </h3>

            <ListField
              label="Repositories"
              hint={
                repositories.length > 0
                  ? `Leave empty for all of them: ${repositories.map((r) => r.fullName).join(', ')}`
                  : 'Leave empty for every repository this workspace watches.'
              }
              values={conditions.repos}
              placeholder="owner/repo"
              onChange={(repos) => setConditions({ ...conditions, repos })}
            />

            <div className="grid grid-cols-2 gap-3">
              <ListField
                label="Base branches"
                values={conditions.baseBranches}
                placeholder="main, master"
                onChange={(baseBranches) => setConditions({ ...conditions, baseBranches })}
              />
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Title contains</label>
                <Input
                  value={conditions.titleContains ?? ''}
                  placeholder="fix:"
                  onChange={(e) =>
                    setConditions({ ...conditions, titleContains: e.target.value || undefined })
                  }
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <ListField
                label="Has any label"
                values={conditions.labelsAny}
                onChange={(labelsAny) => setConditions({ ...conditions, labelsAny })}
              />
              <ListField
                label="Has all labels"
                values={conditions.labelsAll}
                onChange={(labelsAll) => setConditions({ ...conditions, labelsAll })}
              />
              <ListField
                label="Has none of"
                values={conditions.labelsNone}
                onChange={(labelsNone) => setConditions({ ...conditions, labelsNone })}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <ActorField
                label="Opened by"
                hint="The PR's author."
                value={conditions.author}
                onChange={(author) => setConditions({ ...conditions, author })}
              />
              <ActorField
                label="Done by"
                hint="Whoever performed the event: the commenter, the reviewer, the person who added the label."
                value={conditions.actor}
                onChange={(actor) => setConditions({ ...conditions, actor })}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Draft"
                value={conditions.draft === undefined ? '' : String(conditions.draft)}
                onChange={(e) =>
                  setConditions({
                    ...conditions,
                    draft: e.target.value === '' ? undefined : e.target.value === 'true',
                  })
                }
              >
                <option value="">Either</option>
                <option value="false">Not a draft</option>
                <option value="true">Drafts only</option>
              </Select>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  Stop after (runs per PR per hour)
                </label>
                <Input
                  type="number"
                  min={1}
                  value={input.maxRunsPerPrPerHour ?? 5}
                  onChange={(e) =>
                    setInput((p) => ({ ...p, maxRunsPerPrPerHour: Number(e.target.value) }))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  A loop breaker. Talyn already ignores its own actions; this bounds an echo from
                  somebody else reacting to them.
                </p>
              </div>
            </div>

            {/* Trigger-specific conditions, offered only where they apply. */}
            {allowed.reviewStates && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Review verdict</label>
                <div className="flex gap-4">
                  {(['approved', 'changes_requested', 'commented'] as const).map((state) => (
                    <label key={state} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={(conditions.reviewStates ?? []).includes(state)}
                        onChange={(e) => {
                          const current = conditions.reviewStates ?? [];
                          const next = e.target.checked
                            ? [...current, state]
                            : current.filter((s) => s !== state);
                          setConditions({
                            ...conditions,
                            reviewStates: next.length > 0 ? next : undefined,
                          });
                        }}
                      />
                      {state === 'changes_requested'
                        ? 'Changes requested'
                        : state === 'approved'
                          ? 'Approved'
                          : 'Commented'}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {allowed.labelName && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  The label that changed
                </label>
                <Input
                  value={conditions.labelName ?? ''}
                  placeholder="needs-review"
                  onChange={(e) =>
                    setConditions({ ...conditions, labelName: e.target.value || undefined })
                  }
                />
              </div>
            )}

            {allowed.targetIsViewer && (
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={conditions.targetIsViewer === true}
                  onChange={(e) =>
                    setConditions({ ...conditions, targetIsViewer: e.target.checked || undefined })
                  }
                />
                Only when it is me
              </label>
            )}

            {allowed.checkConclusions && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Checks</label>
                <div className="flex gap-4">
                  {(['success', 'failure'] as const).map((c) => (
                    <label key={c} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={(conditions.checkConclusions ?? []).includes(c)}
                        onChange={(e) => {
                          const current = conditions.checkConclusions ?? [];
                          const next = e.target.checked
                            ? [...current, c]
                            : current.filter((x) => x !== c);
                          setConditions({
                            ...conditions,
                            checkConclusions: next.length > 0 ? next : undefined,
                          });
                        }}
                      />
                      {c === 'success' ? 'Passed' : 'Failed'}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {allowed.bodyContains && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  Comment or review contains
                </label>
                <Input
                  value={conditions.bodyContains ?? ''}
                  placeholder="please rebase"
                  onChange={(e) =>
                    setConditions({ ...conditions, bodyContains: e.target.value || undefined })
                  }
                />
              </div>
            )}
          </section>

          {/* THEN */}
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Then</h3>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setInput((p) => ({
                    ...p,
                    actions: [...p.actions, emptyWorkflowAction('comment')],
                  }))
                }
              >
                <Plus className="w-4 h-4 mr-1" />
                Add action
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Run in order, top to bottom.</p>
            <div className="space-y-2">
              {input.actions.map((action, i) => (
                <ActionRow
                  key={i}
                  action={action}
                  canRemove={input.actions.length > 1}
                  onChange={(next) =>
                    setInput((p) => ({
                      ...p,
                      actions: p.actions.map((a, j) => (j === i ? next : a)),
                    }))
                  }
                  onRemove={() =>
                    setInput((p) => ({ ...p, actions: p.actions.filter((_, j) => j !== i) }))
                  }
                />
              ))}
            </div>
          </section>
        </div>

        <DialogFooter>
          <div className="flex-1 self-center text-left text-xs text-red-500">
            {saveError ?? (problem && input.name.trim() ? problem : null)}
          </div>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || problem !== null}>
            {saving ? 'Saving...' : editing ? 'Save changes' : 'Create workflow'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

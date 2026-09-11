import { useMemo, useState } from 'react';
import { ArrowLeft, Plus, X } from 'lucide-react';
import type {
  WorkflowAction,
  WorkflowActionType,
  WorkflowActorMatch,
  WorkflowCheckConclusion,
  WorkflowConditionSpec,
  WorkflowConditions,
  WorkflowInput,
  WorkflowReviewState,
  WorkflowSuggestions,
  WorkflowTriggerEvent,
  WorkflowWithStats,
} from '@talyn/shared';
import {
  availableWorkflowConditions,
  emptyWorkflowAction,
  emptyWorkflowConditionValue,
  emptyWorkflowInput,
  MAX_WORKFLOW_NAME_LENGTH,
  pruneWorkflowConditions,
  WORKFLOW_ACTION_LABELS,
  WORKFLOW_ACTION_TYPES,
  WORKFLOW_CONDITION_SPECS,
  WORKFLOW_EVENT_LABELS,
  WORKFLOW_EVENTS_REQUIRING_TRACKED_PR,
  WORKFLOW_TRIGGER_EVENTS,
  workflowConditionSpec,
  workflowInputProblem,
  workflowToInput,
} from '@talyn/shared';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Select } from '../../ui/select';
import { Textarea } from '../../ui/textarea';
import { cn } from '../../../lib/utils';
import {
  ActorField,
  ChoiceSet,
  DropdownButton,
  EditorRow,
  PeopleField,
  Section,
  TextField,
  TokenField,
} from './workflowFields';

/**
 * The workflow editor, as a page.
 *
 * It was a modal, and a modal was the wrong container: a workflow is composed
 * over minutes from three independent lists, and a dialog that scrolls internally
 * while dimming the thing you are automating gives none of the room that needs.
 *
 * The composition is ADDITIVE rather than a form. A new workflow opens with one
 * trigger, no conditions and no actions, and everything after that arrives
 * through an "Add ..." menu — so the page only ever shows the rules that exist,
 * and the menus only ever offer what the current trigger can carry
 * (`availableWorkflowConditions` reads the same event sets the validator does, so
 * the form cannot compose something the API then refuses).
 */

interface Props {
  /** The workflow being edited, or null for a new one. */
  editing: WorkflowWithStats | null;
  suggestions: WorkflowSuggestions | null;
  onCancel: () => void;
  onSave: (input: WorkflowInput) => Promise<void>;
}

const REVIEW_STATE_OPTIONS: ReadonlyArray<{ value: WorkflowReviewState; label: string }> = [
  { value: 'approved', label: 'Approved' },
  { value: 'changes_requested', label: 'Changes requested' },
  { value: 'commented', label: 'Commented' },
];

const CHECK_OPTIONS: ReadonlyArray<{ value: WorkflowCheckConclusion; label: string }> = [
  { value: 'success', label: 'Passed' },
  { value: 'failure', label: 'Failed' },
];

/** The widget for one condition, chosen by its spec's `input`. */
function ConditionInput({
  spec,
  conditions,
  setConditions,
  suggestions,
}: {
  spec: WorkflowConditionSpec;
  conditions: WorkflowConditions;
  setConditions: (next: WorkflowConditions) => void;
  suggestions: WorkflowSuggestions | null;
}) {
  const set = (value: unknown) => setConditions({ ...conditions, [spec.key]: value });

  switch (spec.input) {
    case 'repos':
      return (
        <TokenField
          values={conditions.repos ?? []}
          suggestions={suggestions?.repos ?? []}
          placeholder="owner/repo"
          onChange={set}
        />
      );
    case 'branches':
      return (
        <TokenField
          values={conditions.baseBranches ?? []}
          suggestions={suggestions?.branches ?? []}
          placeholder="main"
          onChange={set}
        />
      );
    case 'labels':
      return (
        <TokenField
          values={(conditions[spec.key] as string[] | undefined) ?? []}
          suggestions={suggestions?.labels ?? []}
          placeholder="needs-review"
          onChange={set}
        />
      );
    case 'label':
      return (
        <TokenField
          // One label, but the same chip widget — so the suggestion list is the
          // same one the multi-label fields use.
          values={conditions.labelName ? [conditions.labelName] : []}
          suggestions={suggestions?.labels ?? []}
          placeholder="needs-review"
          onChange={(next) => set(next[next.length - 1] ?? '')}
        />
      );
    case 'text':
      return (
        <TextField
          value={(conditions[spec.key] as string | undefined) ?? ''}
          placeholder={spec.key === 'titleContains' ? 'fix:' : 'please rebase'}
          onChange={set}
        />
      );
    case 'actor':
      return (
        <ActorField
          value={conditions[spec.key] as WorkflowActorMatch | undefined}
          suggestions={suggestions}
          onChange={set}
        />
      );
    case 'draft':
      return (
        <Select
          value={conditions.draft === undefined ? '' : String(conditions.draft)}
          onChange={(e) => set(e.target.value === '' ? undefined : e.target.value === 'true')}
        >
          <option value="false">Not a draft</option>
          <option value="true">Drafts only</option>
        </Select>
      );
    case 'baseIsDefault':
      return (
        <Select
          value={conditions.baseIsDefault === undefined ? '' : String(conditions.baseIsDefault)}
          onChange={(e) => set(e.target.value === '' ? undefined : e.target.value === 'true')}
        >
          <option value="false">No — stacked on another branch</option>
          <option value="true">Yes — targets the default branch</option>
        </Select>
      );
    case 'reviewStates':
      return (
        <ChoiceSet
          options={REVIEW_STATE_OPTIONS}
          selected={conditions.reviewStates ?? []}
          onChange={set}
        />
      );
    case 'checkConclusions':
      return (
        <ChoiceSet
          options={CHECK_OPTIONS}
          selected={conditions.checkConclusions ?? []}
          onChange={set}
        />
      );
  }
}

/** The widget for one action, chosen by its type. */
function ActionInput({
  action,
  onChange,
  suggestions,
}: {
  action: WorkflowAction;
  onChange: (next: WorkflowAction) => void;
  suggestions: WorkflowSuggestions | null;
}) {
  switch (action.type) {
    case 'add_labels':
    case 'remove_labels':
      return (
        <TokenField
          values={action.labels}
          suggestions={suggestions?.labels ?? []}
          placeholder="needs-review"
          onChange={(labels) => onChange({ ...action, labels })}
        />
      );
    case 'request_reviewers':
      return (
        <PeopleField
          logins={action.users ?? []}
          teams={action.teams ?? []}
          suggestions={suggestions}
          onChange={({ logins, teams }) =>
            onChange({ ...action, users: logins, teams })
          }
        />
      );
    case 'assign':
      return (
        <PeopleField
          logins={action.users}
          teams={[]}
          includeTeams={false}
          suggestions={suggestions}
          hint="GitHub ignores anyone who is not a collaborator, without erroring, so Talyn checks what came back and reports the difference."
          onChange={({ logins }) => onChange({ ...action, users: logins })}
        />
      );
    case 'comment':
      return (
        <div className="space-y-1">
          <Textarea
            rows={3}
            value={action.body}
            placeholder="Thanks {{pr.author}} - this targets {{pr.baseBranch}}."
            onChange={(e) => onChange({ ...action, body: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Filled in: {'{{pr.number}}'}, {'{{pr.title}}'}, {'{{pr.url}}'}, {'{{pr.author}}'},{' '}
            {'{{pr.baseBranch}}'}, {'{{pr.headBranch}}'}, {'{{repo}}'}, {'{{actor}}'},{' '}
            {'{{event}}'}.
          </p>
        </div>
      );
    case 'run_skill':
      return (
        <div className="space-y-1">
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
      );
    case 'run_prompt':
      return (
        <div className="space-y-1">
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
      );
    case 'enqueue_merge_queue':
      return (
        <div className="space-y-1">
          <Select
            value={action.method ?? ''}
            onChange={(e) =>
              onChange({
                ...action,
                method: (e.target.value || undefined) as
                  | 'squash'
                  | 'merge'
                  | 'rebase'
                  | undefined,
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
      );
    case 'watch_pr':
      return null;
  }
}

/** One line describing what an action does, for its row heading. */
const ACTION_HINTS: Record<WorkflowActionType, string> = {
  add_labels: 'Additive — GitHub keeps the labels already on the PR.',
  remove_labels: 'A label that is already absent counts as done.',
  request_reviewers: 'The PR author is dropped automatically; asking them would fail the whole call.',
  assign: 'Assignees must be collaborators on the repository.',
  comment: 'Posted as Talyn on the PR conversation.',
  run_skill: 'Starts a cloud task. Counts against your plan, and never runs twice on one PR.',
  run_prompt: 'Starts a cloud task. Counts against your plan, and never runs twice on one PR.',
  watch_pr: 'Adds the PR to My PRs, exactly as pasting its URL does.',
  enqueue_merge_queue: 'Waits for checks and handles a gated base branch.',
};

export function WorkflowEditorPage({ editing, suggestions, onCancel, onSave }: Props) {
  const [input, setInput] = useState<WorkflowInput>(() =>
    editing ? workflowToInput(editing) : emptyWorkflowInput()
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  /**
   * Whether the user has tried to save yet.
   *
   * Nothing is wrong with a half-built workflow — that is what building one looks
   * like. Telling somebody "a workflow needs at least one action" while they are
   * still typing the NAME is scolding them for not having finished, so validation
   * stays quiet until they ask for it by pressing Save, and only then goes live
   * (updating as they fix it, which is useful once they are looking for it).
   */
  const [attempted, setAttempted] = useState(false);

  const conditions = input.conditions ?? {};
  const problem = useMemo(() => workflowInputProblem(input), [input]);

  // The menus are generated from the specs, minus what is already on the page —
  // so "Add condition" never offers a duplicate, and never offers a condition the
  // current trigger cannot carry.
  const addableConditions = useMemo(
    () => availableWorkflowConditions(input.events, conditions),
    [input.events, conditions]
  );
  const activeConditionKeys = useMemo(
    () =>
      WORKFLOW_CONDITION_SPECS.filter((s) => conditions[s.key] !== undefined).map((s) => s.key),
    [conditions]
  );
  const addableEvents = useMemo(
    () => WORKFLOW_TRIGGER_EVENTS.filter((e) => !input.events.includes(e)),
    [input.events]
  );

  const setConditions = (next: WorkflowConditions) => setInput((p) => ({ ...p, conditions: next }));

  const removeCondition = (key: keyof WorkflowConditions) =>
    setInput((p) => {
      const next = { ...(p.conditions ?? {}) };
      delete next[key];
      return { ...p, conditions: next };
    });

  const addEvent = (event: string) =>
    setInput((p) => ({ ...p, events: [...p.events, event as WorkflowTriggerEvent] }));

  const removeEvent = (event: WorkflowTriggerEvent) =>
    setInput((p) => {
      const events = p.events.filter((e) => e !== event);
      // Pruning here is what stops the save 400ing about a condition whose
      // trigger is no longer selected — and the condition row disappears with it,
      // so the page never shows a rule that cannot apply.
      return { ...p, events, conditions: pruneWorkflowConditions(p.conditions ?? {}, events) };
    });

  const save = async () => {
    // The button stays ENABLED while the workflow is incomplete, so that pressing
    // it is how you find out what is missing. A disabled button that explains
    // nothing is the other half of the same problem.
    if (problem) {
      setAttempted(true);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(input);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save this workflow');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b px-6 py-4">
        <Button variant="ghost" size="sm" onClick={onCancel} data-attr="workflow-editor-back">
          <ArrowLeft className="mr-1 h-4 w-4" />
          Workflows
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">
            {input.name.trim() || (editing ? 'Workflow' : 'New workflow')}
          </h1>
        </div>
        {/* Only when editing. A workflow you are creating is on — nobody composes
            a rule in order to leave it switched off, and the list row has the
            toggle for the moment that changes. */}
        {editing && (
          <Button
            variant={input.enabled === false ? 'outline' : 'secondary'}
            size="sm"
            onClick={() => setInput((p) => ({ ...p, enabled: p.enabled === false }))}
          >
            {input.enabled === false ? 'Off' : 'On'}
          </Button>
        )}
        <Button onClick={save} disabled={saving} data-attr="workflow-save">
          {saving ? 'Saving...' : editing ? 'Save' : 'Create'}
        </Button>
      </header>

      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl space-y-4 p-6">
          {(saveError ?? (attempted ? problem : null)) && (
            <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-500">
              {saveError ?? problem}
            </p>
          )}

          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="workflow-name">
              Name
            </label>
            <Input
              id="workflow-name"
              className="h-10 text-base"
              value={input.name}
              maxLength={MAX_WORKFLOW_NAME_LENGTH}
              placeholder="Label new PRs from bots"
              onChange={(e) => setInput((p) => ({ ...p, name: e.target.value }))}
            />
          </div>

          {/* ---- WHEN ---- */}
          <Section
            title="When this happens"
            description="Any one of these events on a pull request in the repositories this workspace watches."
            action={
              <DropdownButton
                label="Add trigger"
                options={addableEvents.map((e) => ({
                  value: e,
                  label: WORKFLOW_EVENT_LABELS[e],
                  hint: WORKFLOW_EVENTS_REQUIRING_TRACKED_PR.includes(e)
                    ? 'Only fires on PRs Talyn already tracks'
                    : undefined,
                }))}
                emptyHint="Every trigger is already selected"
                onPick={addEvent}
              />
            }
          >
            {input.events.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Pick at least one trigger — a workflow with none can never run.
              </p>
            ) : (
              <>
                {/* Compact, but with some weight: a full-width row per trigger
                    gave one short label the footprint of a paragraph, and the
                    original filter-chip was too slight for a load-bearing part of
                    the rule. Squared corners, a solid fill and body-sized text
                    sit between the two. */}
                <div className="flex flex-wrap gap-2">
                  {input.events.map((e) => (
                    <span
                      key={e}
                      className={cn(
                        'inline-flex items-center gap-2 rounded-md border bg-muted/60 py-1.5 pl-3 pr-1.5 text-sm font-medium',
                        WORKFLOW_EVENTS_REQUIRING_TRACKED_PR.includes(e) && 'border-dashed'
                      )}
                    >
                      {WORKFLOW_EVENT_LABELS[e]}
                      <button
                        className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                        onClick={() => removeEvent(e)}
                        aria-label={`Remove ${WORKFLOW_EVENT_LABELS[e]}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
                {/* The caveat as text rather than a tooltip on each chip: it is
                    the difference between a rule that fires and one that silently
                    never does, which is not tooltip-grade information. */}
                {input.events.some((e) => WORKFLOW_EVENTS_REQUIRING_TRACKED_PR.includes(e)) && (
                  <p className="text-xs text-muted-foreground">
                    {input.events
                      .filter((e) => WORKFLOW_EVENTS_REQUIRING_TRACKED_PR.includes(e))
                      .map((e) => WORKFLOW_EVENT_LABELS[e])
                      .join(' and ')}{' '}
                    only fires on PRs Talyn already tracks — check events for untracked PRs are
                    dropped before they reach the workflow engine.
                  </p>
                )}
              </>
            )}
          </Section>

          {/* ---- IF ---- */}
          <Section
            title="Only if"
            description="Every condition has to hold. Add none and the workflow runs on every PR the trigger fires for."
            action={
              <DropdownButton
                label="Add condition"
                options={addableConditions.map((s) => ({
                  value: s.key,
                  label: s.label,
                  hint: s.hint,
                }))}
                emptyHint={
                  input.events.length === 0
                    ? 'Pick a trigger first'
                    : 'Every condition for these triggers is already added'
                }
                onPick={(key) => {
                  const spec = workflowConditionSpec(key as keyof WorkflowConditions);
                  if (spec) setConditions({ ...conditions, [spec.key]: emptyWorkflowConditionValue(spec) });
                }}
              />
            }
          >
            {activeConditionKeys.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No conditions. This runs on every pull request the trigger fires for, including
                ones you did not open.
              </p>
            ) : (
              activeConditionKeys.map((key) => {
                const spec = workflowConditionSpec(key)!;
                return (
                  <EditorRow
                    key={key}
                    title={spec.label}
                    hint={spec.hint}
                    onRemove={() => removeCondition(key)}
                  >
                    <ConditionInput
                      spec={spec}
                      conditions={conditions}
                      setConditions={setConditions}
                      suggestions={suggestions}
                    />
                  </EditorRow>
                );
              })
            )}
            {suggestions?.partial && (
              <p className="text-xs text-muted-foreground">
                Some suggestions could not be loaded from GitHub. Typed values still work.
              </p>
            )}
          </Section>

          {/* ---- THEN ---- */}
          <Section
            title="Do this"
            description="In order, top to bottom."
            action={
              <DropdownButton
                label="Add action"
                options={WORKFLOW_ACTION_TYPES.map((t) => ({
                  value: t,
                  label: WORKFLOW_ACTION_LABELS[t],
                  hint: ACTION_HINTS[t],
                }))}
                onPick={(type) =>
                  setInput((p) => ({
                    ...p,
                    actions: [...p.actions, emptyWorkflowAction(type as WorkflowActionType)],
                  }))
                }
              />
            }
          >
            {input.actions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing yet. Add at least one action — labelling, asking for a review, commenting,
                running a skill, or sending the PR to the merge queue.
              </p>
            ) : (
              input.actions.map((action, i) => (
                <EditorRow
                  key={`${action.type}-${i}`}
                  title={WORKFLOW_ACTION_LABELS[action.type]}
                  hint={ACTION_HINTS[action.type]}
                  onRemove={() =>
                    setInput((p) => ({ ...p, actions: p.actions.filter((_, j) => j !== i) }))
                  }
                >
                  <ActionInput
                    action={action}
                    suggestions={suggestions}
                    onChange={(next) =>
                      setInput((p) => ({
                        ...p,
                        actions: p.actions.map((a, j) => (j === i ? next : a)),
                      }))
                    }
                  />
                </EditorRow>
              ))
            )}
          </Section>

          {/* ---- Advanced ---- */}
          <div>
            <Button variant="ghost" size="sm" onClick={() => setShowAdvanced((v) => !v)}>
              <Plus
                className={cn('mr-1 h-4 w-4 transition-transform', showAdvanced && 'rotate-45')}
              />
              Advanced
            </Button>
            {showAdvanced && (
              <div className="mt-2 rounded-lg border p-4">
                <label className="text-xs font-medium text-muted-foreground">
                  Stop after this many runs on one PR per hour
                </label>
                <Input
                  type="number"
                  min={1}
                  className="mt-1 max-w-32"
                  value={input.maxRunsPerPrPerHour ?? 5}
                  onChange={(e) =>
                    setInput((p) => ({ ...p, maxRunsPerPrPerHour: Number(e.target.value) }))
                  }
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  A loop breaker. Talyn already ignores its own actions; this bounds an echo from
                  somebody else reacting to them.
                </p>
              </div>
            )}
          </div>

          {/* The same action as the header's, where you finish reading. The header
              copy is for a long form you have scrolled up in; this one is for the
              end of the sentence you just wrote. */}
          <div className="flex items-center justify-end gap-3 border-t pt-4">
            {attempted && problem && (
              <p className="flex-1 text-xs text-red-500">{problem}</p>
            )}
            <Button variant="ghost" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving} data-attr="workflow-save-inline">
              {saving ? 'Saving...' : editing ? 'Save changes' : 'Create workflow'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

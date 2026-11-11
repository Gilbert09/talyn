import { captureAnalyticsException } from '../../../lib/analytics';
import { useCallback, useMemo, useState } from 'react';
import { ArrowLeft, Plus, X } from 'lucide-react';
import type {
  WorkflowActionType,
  WorkflowConditions,
  WorkflowInput,
  WorkflowIntegration,
  WorkflowSuggestions,
  WorkflowTriggerEvent,
  WorkflowWithStats,
} from '@talyn/shared';
import {
  availableWorkflowConditions,
  emptyWorkflowAction,
  emptyWorkflowConditionValue,
  emptyWorkflowInput,
  pruneWorkflowConditions,
  WORKFLOW_ACTION_LABELS,
  WORKFLOW_CONDITION_SPECS,
  WORKFLOW_EVENT_LABELS,
  WORKFLOW_EVENTS_REQUIRING_TRACKED_PR,
  workflowConditionSpec,
  workflowInputProblem,
  workflowToInput,
  workflowVocabulary,
  workflowIntegrationOf,
} from '@talyn/shared';
import { Button } from '../../ui/button';
import { cn } from '../../../lib/utils';
import { DropdownButton, EditorRow, Section, WorkflowEnabledButton, WorkflowNameField, WorkflowRunCapField } from './workflowFields';
import { GithubActionInput, GithubConditionInput } from './githubFields';
import { SlackActionInput, SlackConditions, SlackReplyNotice, StartSessionInput, useSlackRuleSettings } from './slackFields';

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
  integration: WorkflowIntegration;
  /** The workflow being edited, or null for a new one. */
  editing: WorkflowWithStats | null;
  suggestions: WorkflowSuggestions | null;
  /**
   * Ask for the suggestion lists that cost GitHub requests — labels, people,
   * teams — for the repositories this workflow names.
   *
   * Called when the user opens a field that needs them rather than when the
   * editor opens, and scoped to the workflow's own repositories: labels are
   * per-repository, and reading all of them to populate one dropdown is what made
   * opening the editor expensive.
   */
  onNeedGithubSuggestions: (repos: string[]) => void;
  onCancel: () => void;
  onSave: (input: WorkflowInput) => Promise<void>;
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
  run_code_review:
    'Reviews the PR and puts the findings in Talyn. Does not use a task slot; the free plan runs one review at a time.',
  // Not offered by this editor yet. The Slack and session editors come later.
  start_session: 'Starts a session with this prompt.',
  slack_reply: 'Replies in the thread of the Slack message.',
  slack_react: 'Adds a reaction to the Slack message.',
};

export function WorkflowEditorPage({
  integration,
  editing,
  suggestions,
  onNeedGithubSuggestions,
  onCancel,
  onSave,
}: Props) {
  const [input, setInput] = useState<WorkflowInput>(() =>
    editing ? workflowToInput(editing) : emptyWorkflowInput(integration)
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

  const kind = workflowIntegrationOf(input);
  const vocabulary = workflowVocabulary(kind);
  const conditions = input.conditions ?? {};
  const slackSettings = useSlackRuleSettings(conditions.slackTeamId, kind === 'slack');
  const canReply = slackSettings.install?.canReply !== false;
  const problem = useMemo(() => workflowInputProblem(input), [input]);

  // The scope every GitHub-backed field asks within: the repositories this
  // workflow names. Empty means the workflow is unscoped, which the backend
  // answers from a bounded sample and flags `partial` — there is no honest way
  // to offer "the labels" of eighty repositories in one dropdown.
  const scopedRepos = useMemo(() => conditions.repos ?? [], [conditions.repos]);
  const needSuggestions = useCallback(
    () => onNeedGithubSuggestions(scopedRepos),
    [onNeedGithubSuggestions, scopedRepos]
  );

  // The menus are generated from the specs, minus what is already on the page —
  // so "Add condition" never offers a duplicate, and never offers a condition the
  // current trigger cannot carry.
  const addableConditions = useMemo(
    () => kind === 'slack' ? [] : availableWorkflowConditions(input.events, conditions),
    [kind, input.events, conditions]
  );
  const activeConditionKeys = useMemo(
    () =>
      WORKFLOW_CONDITION_SPECS.filter((s) => conditions[s.key] !== undefined).map((s) => s.key),
    [conditions]
  );
  const addableEvents = useMemo(
    () => vocabulary.events.map((item) => item.event).filter((e) => !input.events.includes(e)),
    [input.events, vocabulary]
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
      return { ...p, events, conditions: kind === 'slack' ? p.conditions : pruneWorkflowConditions(p.conditions ?? {}, events) };
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
      await onSave(kind === 'github'
        ? { ...input, actions: input.actions.map((action) => action.type === 'start_session'
          ? { ...action, repositoryId: null } : action) }
        : input);
    } catch (err) {
      captureAnalyticsException(err, { flow: 'workflow_save' });
      setSaveError(err instanceof Error ? err.message : 'Could not save this automation');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b px-6 py-4">
        <Button variant="ghost" size="sm" onClick={onCancel} data-attr="workflow-editor-back">
          <ArrowLeft className="mr-1 h-4 w-4" />
          {kind === 'slack' ? 'Slack automations' : 'Automations'}
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">
            {input.name.trim() || (editing ? 'Automation' : 'New automation')}
          </h1>
        </div>
        {/* Only when editing. A workflow you are creating is on — nobody composes
            a rule in order to leave it switched off, and the list row has the
            toggle for the moment that changes. */}
        {editing && <WorkflowEnabledButton enabled={input.enabled !== false} onChange={(enabled) => setInput((p) => ({ ...p, enabled }))} />}
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

          <WorkflowNameField value={input.name} integration={kind} onChange={(name) => setInput((p) => ({ ...p, name }))} />

          {/* ---- WHEN ---- */}
          <Section
            title="When this happens"
            description={kind === 'slack' ? 'When a message appears in a selected channel.' : 'Any one of these events on a pull request in the repositories this workspace watches.'}
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
                Pick at least one trigger — an automation with none can never run.
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
          {kind === 'slack' ? (
            <Section title="Only if" description="Choose a Slack workspace and its channels.">
              <SlackConditions conditions={conditions} onChange={setConditions} settings={slackSettings} />
            </Section>
          ) : (
          <Section
            title="Only if"
            description="Every condition has to hold. Add none and the automation runs on every PR the trigger fires for."
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
                    <GithubConditionInput
                      spec={spec}
                      conditions={conditions}
                      setConditions={setConditions}
                      suggestions={suggestions}
                      onNeedSuggestions={needSuggestions}
                    />
                  </EditorRow>
                );
              })
            )}
            {kind === 'github' && suggestions?.partial && (
              <p className="text-xs text-muted-foreground">
                {scopedRepos.length === 0
                  ? 'Showing labels from some of this workspace’s repositories. Add a repository condition to see exactly its labels — or type any value.'
                  : 'Some suggestions could not be loaded from GitHub. Typed values still work.'}
              </p>
            )}
          </Section>
          )}

          {/* ---- THEN ---- */}
          <Section
            title="Do this"
            description="In order, top to bottom."
            action={
              <DropdownButton
                label="Add action"
                options={vocabulary.actions.map(({ type: t }) => ({
                  value: t,
                  label: WORKFLOW_ACTION_LABELS[t],
                  hint: ACTION_HINTS[t],
                  disabled: t === 'slack_reply' && !canReply,
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
            {kind === 'slack' && !canReply && <SlackReplyNotice />}
            {input.actions.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {kind === 'slack' ? 'Add an action for matching messages.' : 'Nothing yet. Add at least one action — labelling, asking for a review, commenting, running a skill, or sending the PR to the merge queue.'}
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
                  {action.type === 'start_session' ? (
                    <StartSessionInput action={action} integration={kind} onChange={(next) => setInput((p) => ({ ...p, actions: p.actions.map((a, j) => j === i ? next : a) }))} />
                  ) : action.type === 'slack_reply' || action.type === 'slack_react' ? (
                    <SlackActionInput action={action} onChange={(next) => setInput((p) => ({ ...p, actions: p.actions.map((a, j) => j === i ? next : a) }))} />
                  ) : (
                    <GithubActionInput action={action} suggestions={suggestions} onNeedSuggestions={needSuggestions} onChange={(next) => setInput((p) => ({ ...p, actions: p.actions.map((a, j) => j === i ? next : a) }))} />
                  )}
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
            {showAdvanced && <WorkflowRunCapField value={input.maxRunsPerPrPerHour ?? 5} integration={kind} onChange={(maxRunsPerPrPerHour) => setInput((p) => ({ ...p, maxRunsPerPrPerHour }))} />}
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
              {saving ? 'Saving...' : editing ? 'Save changes' : 'Create automation'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

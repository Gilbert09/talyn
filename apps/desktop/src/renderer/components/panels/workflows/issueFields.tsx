import { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import type {
  IssueAssigneeMatch,
  IssueWorkflowConditionSpec,
  IssueWorkflowIntegration,
  LinearConnection,
  LinearEditorOptions,
  LinearStatus,
  WorkflowAction,
  WorkflowConditions,
  WorkflowSuggestions,
  WorkflowTriggerEvent,
} from '@talyn/shared';
import {
  ISSUE_ASSIGNEE_KIND_LABELS,
  ISSUE_ASSIGNEE_KINDS,
  issueConditionSpecsFor,
  LINEAR_PRIORITY_NAMES,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { captureAnalyticsException } from '../../../lib/analytics';
import { cn } from '../../../lib/utils';
import { useWorkspaceStore } from '../../../stores/workspace';
import { Select } from '../../ui/select';
import { Textarea } from '../../ui/textarea';
import { ChoiceSet, DropdownButton, EditorRow, TextField, TokenField } from './workflowFields';

/**
 * The editor parts of an issue rule (Linear, GitHub Issues): the conditions,
 * the write-back settings of the start action, and the two write-back actions.
 *
 * The same file is in apps/web/src/components/panels/workflows/. Keep the two in step.
 */

export interface LinearRuleData {
  status: LinearStatus | null;
  statusError: string | null;
  options: LinearEditorOptions | null;
  connection: LinearConnection | null;
}

/** The Linear connections, and the editor options of the chosen one. */
export function useLinearRuleData(connectionId: string | undefined, enabled: boolean): LinearRuleData {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const [status, setStatus] = useState<LinearStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [options, setOptions] = useState<LinearEditorOptions | null>(null);

  useEffect(() => {
    if (!enabled || !workspaceId) return;
    let active = true;
    api.linear
      .getStatus(workspaceId)
      .then((next) => {
        if (!active) return;
        setStatus(next);
        setStatusError(null);
      })
      .catch((err: unknown) => {
        captureAnalyticsException(err, { flow: 'linear_status' });
        if (active) setStatusError(err instanceof Error ? err.message : 'Could not load Linear.');
      });
    return () => {
      active = false;
    };
  }, [enabled, workspaceId]);

  useEffect(() => {
    setOptions(null);
    if (!enabled || !workspaceId || !connectionId) return;
    let active = true;
    api.linear
      .options(workspaceId, connectionId)
      .then((next) => {
        if (active) setOptions(next);
      })
      .catch(() => {
        // The fields still take typed values.
        if (active) setOptions({ teams: [], labels: [], states: [], projects: [], partial: true });
      });
    return () => {
      active = false;
    };
  }, [enabled, workspaceId, connectionId]);

  const connection = status?.connections.find((c) => c.id === connectionId) ?? null;
  return { status, statusError, options, connection };
}

const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

/** The assignee kinds this tracker allows. `talyn` needs a Linear grant that can assign. */
export function issueAssigneeKinds(
  integration: IssueWorkflowIntegration,
  canAssign: boolean
): Array<(typeof ISSUE_ASSIGNEE_KINDS)[number]> {
  return ISSUE_ASSIGNEE_KINDS.filter((kind) => {
    if (kind === 'talyn') return integration === 'linear' && canAssign;
    if (kind === 'me') return integration === 'github_issues';
    return true;
  });
}

function emptyIssueConditionValue(
  spec: IssueWorkflowConditionSpec,
  integration: IssueWorkflowIntegration,
  canAssign: boolean
): WorkflowConditions[keyof WorkflowConditions] {
  switch (spec.input) {
    case 'connection':
    case 'label':
    case 'text':
      return '';
    case 'assignee':
      return { kind: issueAssigneeKinds(integration, canAssign)[0]! } as IssueAssigneeMatch;
    default:
      return [];
  }
}

/** Drops a condition whose only event is gone, so the save does not refuse it. */
export function pruneIssueConditions(
  integration: IssueWorkflowIntegration,
  conditions: WorkflowConditions,
  events: readonly WorkflowTriggerEvent[]
): WorkflowConditions {
  const next = { ...conditions };
  for (const spec of issueConditionSpecsFor(integration)) {
    if (spec.appliesTo && !spec.appliesTo.some((e) => events.includes(e))) delete next[spec.key];
  }
  return next;
}

function AssigneeField({
  integration,
  value,
  canAssign,
  suggestions,
  onNeedSuggestions,
  onChange,
}: {
  integration: IssueWorkflowIntegration;
  value: IssueAssigneeMatch | undefined;
  canAssign: boolean;
  suggestions: string[];
  onNeedSuggestions?: () => void;
  onChange: (next: IssueAssigneeMatch) => void;
}) {
  const allowed = issueAssigneeKinds(integration, canAssign);
  // A saved rule keeps its choice on screen, also when the grant lost the scope.
  const kinds = value && !allowed.includes(value.kind) ? [...allowed, value.kind] : allowed;
  return (
    <div className="space-y-2" data-attr="issue-assignee-field">
      <div className="flex flex-wrap gap-1" role="group" aria-label="Assigned to">
        {kinds.map((kind) => (
          <button
            key={kind}
            type="button"
            aria-pressed={value?.kind === kind}
            onClick={() => onChange(kind === 'people' ? { kind: 'people', people: [] } : ({ kind } as IssueAssigneeMatch))}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors',
              value?.kind === kind ? 'border-transparent bg-primary text-primary-foreground' : 'hover:bg-accent'
            )}
          >
            {value?.kind === kind && <Check className="h-3 w-3" />}
            {ISSUE_ASSIGNEE_KIND_LABELS[kind]}
          </button>
        ))}
      </div>
      {value?.kind === 'talyn' && !canAssign && (
        <p className="text-xs text-amber-500">
          This Linear connection cannot assign issues to Talyn. Reconnect Linear to allow it.
        </p>
      )}
      {integration === 'linear' && !canAssign && value?.kind !== 'talyn' && (
        <p className="text-xs text-muted-foreground">
          To match issues assigned to Talyn, reconnect Linear and allow Talyn to be assigned.
        </p>
      )}
      {value?.kind === 'people' && (
        <TokenField
          label="People"
          values={value.people}
          suggestions={suggestions}
          onNeedSuggestions={onNeedSuggestions}
          placeholder={integration === 'linear' ? 'Name or email' : 'GitHub login'}
          onChange={(people) => onChange({ kind: 'people', people })}
        />
      )}
    </div>
  );
}

function IssueConditionInput({
  spec,
  integration,
  conditions,
  setConditions,
  linear,
  suggestions,
  onNeedSuggestions,
}: {
  spec: IssueWorkflowConditionSpec;
  integration: IssueWorkflowIntegration;
  conditions: WorkflowConditions;
  setConditions: (next: WorkflowConditions) => void;
  linear: LinearRuleData;
  suggestions: WorkflowSuggestions | null;
  onNeedSuggestions: () => void;
}) {
  const set = (value: unknown) => setConditions({ ...conditions, [spec.key]: value });
  const list = (conditions[spec.key] as string[] | undefined) ?? [];
  const isLinear = integration === 'linear';
  const options = linear.options;

  switch (spec.input) {
    case 'connection': {
      const connections = linear.status?.connections ?? [];
      return (
        <div className="space-y-1">
          <Select
            aria-label={spec.label}
            className="block"
            value={conditions.connectionId ?? ''}
            onChange={(e) => set(e.target.value)}
          >
            <option value="">Pick a Linear workspace</option>
            {conditions.connectionId && !connections.some((c) => c.id === conditions.connectionId) && (
              <option value={conditions.connectionId}>Disconnected workspace</option>
            )}
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.organizationName ?? c.urlKey ?? c.organizationId}
              </option>
            ))}
          </Select>
          {linear.statusError ? (
            <p className="text-xs text-red-500">{linear.statusError}</p>
          ) : linear.status && connections.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No Linear workspace is connected. Connect one on the Connection tab.
            </p>
          ) : null}
        </div>
      );
    }
    case 'repos':
      return (
        <TokenField values={list} onChange={set} suggestions={suggestions?.repos ?? []} placeholder="owner/repo" />
      );
    case 'teams':
      return (
        <TokenField
          values={list}
          onChange={set}
          suggestions={(options?.teams ?? []).map((t) => t.key)}
          renderSuggestion={(key) => {
            const team = options?.teams.find((t) => t.key === key);
            return team ? `${team.key} · ${team.name}` : key;
          }}
          placeholder="ENG"
        />
      );
    case 'projects':
      return (
        <TokenField values={list} onChange={set} suggestions={unique((options?.projects ?? []).map((p) => p.name))} placeholder="Project name" />
      );
    case 'statuses':
      return (
        <TokenField
          values={list}
          onChange={set}
          suggestions={isLinear ? unique((options?.states ?? []).map((s) => s.name)) : ['open', 'closed']}
          placeholder={isLinear ? 'Todo' : 'open'}
        />
      );
    case 'priorities':
      return (
        <ChoiceSet
          options={LINEAR_PRIORITY_NAMES.map((name) => ({ value: name as string, label: name }))}
          selected={list}
          onChange={set}
        />
      );
    case 'labels':
      return (
        <TokenField
          values={list}
          onChange={set}
          suggestions={isLinear ? unique((options?.labels ?? []).map((l) => l.name)) : suggestions?.labels ?? []}
          onNeedSuggestions={isLinear ? undefined : onNeedSuggestions}
          placeholder="bug"
        />
      );
    case 'label': {
      const value = (conditions[spec.key] as string | undefined) ?? '';
      return (
        <TokenField
          values={value ? [value] : []}
          onChange={(values) => set(values.at(-1) ?? '')}
          suggestions={isLinear ? unique((options?.labels ?? []).map((l) => l.name)) : suggestions?.labels ?? []}
          onNeedSuggestions={isLinear ? undefined : onNeedSuggestions}
          placeholder="bug"
        />
      );
    }
    case 'assignee':
      return (
        <AssigneeField
          integration={integration}
          value={conditions.issueAssignee}
          canAssign={linear.connection?.canAssign === true}
          suggestions={isLinear ? [] : (suggestions?.people ?? []).map((p) => p.login)}
          onNeedSuggestions={isLinear ? undefined : onNeedSuggestions}
          onChange={set}
        />
      );
    case 'people':
      return (
        <TokenField
          values={list}
          onChange={set}
          suggestions={(suggestions?.people ?? []).map((p) => p.login)}
          onNeedSuggestions={onNeedSuggestions}
          placeholder="alice"
        />
      );
    case 'text':
      return <TextField value={(conditions[spec.key] as string | undefined) ?? ''} onChange={set} />;
  }
}

/** The "Only if" rows of an issue rule. A required condition is always on the page. */
export function IssueConditions({
  integration,
  conditions,
  events,
  setConditions,
  linear,
  suggestions,
  onNeedSuggestions,
}: {
  integration: IssueWorkflowIntegration;
  conditions: WorkflowConditions;
  events: readonly WorkflowTriggerEvent[];
  setConditions: (next: WorkflowConditions) => void;
  linear: LinearRuleData;
  suggestions: WorkflowSuggestions | null;
  onNeedSuggestions: () => void;
}) {
  const specs = useMemo(() => issueConditionSpecsFor(integration), [integration]);
  const applies = (spec: IssueWorkflowConditionSpec) => !spec.appliesTo || spec.appliesTo.some((e) => events.includes(e));
  const shown = specs.filter((s) => s.required || conditions[s.key] !== undefined);
  const addable = specs.filter((s) => !s.required && conditions[s.key] === undefined && applies(s));
  const canAssign = linear.connection?.canAssign === true;

  const remove = (key: keyof WorkflowConditions) => {
    const next = { ...conditions };
    delete next[key];
    setConditions(next);
  };

  return (
    <div className="space-y-3" data-attr="issue-conditions">
      {shown.map((spec) => {
        const input = (
          <IssueConditionInput
            spec={spec}
            integration={integration}
            conditions={conditions}
            setConditions={setConditions}
            linear={linear}
            suggestions={suggestions}
            onNeedSuggestions={onNeedSuggestions}
          />
        );
        return spec.required ? (
          <div key={spec.key} className="rounded-md border bg-card/40 p-3">
            <div className="text-sm font-medium">{spec.label}</div>
            <p className="mt-0.5 text-xs text-muted-foreground">{spec.hint}</p>
            <div className="mt-2.5">{input}</div>
          </div>
        ) : (
          <EditorRow key={spec.key} title={spec.label} hint={spec.hint} onRemove={() => remove(spec.key)}>
            {input}
          </EditorRow>
        );
      })}
      {shown.every((s) => s.required) && (
        <p className="text-sm text-muted-foreground">
          No other conditions. This runs on every issue the trigger fires for.
        </p>
      )}
      <DropdownButton
        label="Add condition"
        options={addable.map((s) => ({ value: s.key, label: s.label, hint: s.hint }))}
        emptyHint="Every condition for these triggers is already added"
        onPick={(key) => {
          const spec = specs.find((s) => s.key === key);
          if (spec) setConditions({ ...conditions, [spec.key]: emptyIssueConditionValue(spec, integration, canAssign) });
        }}
      />
      {integration === 'linear' && linear.options?.partial && (
        <p className="text-xs text-muted-foreground">
          Some suggestions could not be loaded from Linear. Typed values still work.
        </p>
      )}
    </div>
  );
}

/** The two write-back settings of an issue rule's start action. Both are on by default. */
export function IssueWriteBackFields({
  action,
  integration,
  onChange,
}: {
  action: Extract<WorkflowAction, { type: 'start_session' | 'start_task' }>;
  integration: IssueWorkflowIntegration;
  onChange: (next: WorkflowAction) => void;
}) {
  const doneLabel = integration === 'linear' ? 'done' : 'closed';
  const set = (key: 'issueStartComment' | 'issueDoneOnMerge', checked: boolean) => {
    const next = { ...action };
    // Only `false` is stored. On is the default.
    if (checked) delete next[key];
    else next[key] = false;
    onChange(next);
  };
  return (
    <div className="space-y-2 border-t pt-3" data-attr="issue-write-back">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={action.issueStartComment !== false}
          onChange={(e) => set('issueStartComment', e.target.checked)}
        />
        Comment on the issue when work starts
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={action.issueDoneOnMerge !== false}
          onChange={(e) => set('issueDoneOnMerge', e.target.checked)}
        />
        Move the issue to {doneLabel} when the fix merges
      </label>
      <p className="text-xs text-muted-foreground">
        When the fix merges, Talyn always comments on the issue with the pull request link.
      </p>
    </div>
  );
}

/** The form of `issue_comment` and `issue_set_status`. */
export function IssueActionInput({
  action,
  integration,
  linear,
  onChange,
}: {
  action: Extract<WorkflowAction, { type: 'issue_comment' | 'issue_set_status' }>;
  integration: IssueWorkflowIntegration;
  linear: LinearRuleData;
  onChange: (next: WorkflowAction) => void;
}) {
  if (action.type === 'issue_comment') {
    return (
      <div className="space-y-1">
        <label className="block text-xs font-medium text-muted-foreground">
          Comment
          <Textarea
            className="mt-1"
            rows={3}
            value={action.body}
            placeholder="Talyn is on it: {{session.url}}"
            onChange={(e) => onChange({ ...action, body: e.target.value })}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          You can use {'{{issue.identifier}}'}, {'{{issue.url}}'}, {'{{issue.title}}'}, {'{{session.url}}'} and{' '}
          {'{{task.url}}'}.
        </p>
      </div>
    );
  }
  if (integration === 'github_issues') {
    return (
      <label className="block text-xs font-medium text-muted-foreground">
        Status
        <Select
          className="mt-1 block"
          value={action.status}
          onChange={(e) => onChange({ ...action, status: e.target.value })}
        >
          <option value="done">Closed as completed</option>
          <option value="closed">Closed</option>
          <option value="open">Open</option>
        </Select>
      </label>
    );
  }
  const states = unique((linear.options?.states ?? []).map((s) => s.name));
  return (
    <TokenField
      label="Status"
      hint={'"done" is the first completed status of the issue\'s team. You can also type a status name.'}
      values={action.status ? [action.status] : []}
      suggestions={['done', ...states]}
      placeholder="done"
      onChange={(values) => onChange({ ...action, status: values.at(-1) ?? '' })}
    />
  );
}

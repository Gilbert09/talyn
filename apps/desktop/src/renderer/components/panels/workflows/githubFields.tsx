import type { CodeReviewPreset, WorkflowAction, WorkflowActorMatch, WorkflowCheckConclusion, WorkflowConditionSpec, WorkflowConditions, WorkflowReviewState, WorkflowSuggestions } from '@talyn/shared';
import { CODE_REVIEW_PRESET_LABELS, CODE_REVIEW_PRESETS, WORKFLOW_ACTOR_KIND_LABELS, WORKFLOW_ACTOR_KINDS } from '@talyn/shared';
import { Input } from '../../ui/input';
import { Select } from '../../ui/select';
import { Textarea } from '../../ui/textarea';
import { ChoiceSet, TextField, TokenField } from './workflowFields';
import { Check } from 'lucide-react';
import { cn } from '../../../lib/utils';

/** People and teams share a field; the suggestion list says which is which. */
export function PeopleField({
  logins,
  teams,
  onChange,
  suggestions,
  label,
  hint,
  includeTeams = true,
  onNeedSuggestions,
}: {
  logins: string[];
  teams: string[];
  onChange: (next: { logins: string[]; teams: string[] }) => void;
  suggestions: WorkflowSuggestions | null;
  label?: string;
  hint?: string;
  includeTeams?: boolean;
  onNeedSuggestions?: () => void;
}) {
  const TEAM_PREFIX = 'team:';
  // One field over two lists, because "who" is one question. A value prefixed
  // `team:` is a team; the prefix is also what a user types to name a team the
  // suggestion list could not offer (listing teams needs `members: read`).
  const values = [...logins, ...teams.map((t) => `${TEAM_PREFIX}${t}`)];
  const people = suggestions?.people ?? [];
  const suggested = [
    ...people.map((p) => p.login),
    ...(includeTeams ? (suggestions?.teams ?? []).map((t) => `${TEAM_PREFIX}${t}`) : []),
  ];
  const botLogins = new Set(people.filter((p) => p.isBot).map((p) => p.login.toLowerCase()));

  return (
    <TokenField
      label={label}
      onNeedSuggestions={onNeedSuggestions}
      hint={
        hint ??
        (includeTeams
          ? 'GitHub logins. Prefix a team slug with "team:".'
          : 'GitHub logins.')
      }
      values={values}
      suggestions={suggested}
      placeholder={includeTeams ? 'alice, team:frontend' : 'alice'}
      renderSuggestion={(v) => (
        <span className="flex items-center justify-between gap-2">
          <span>{v.startsWith(TEAM_PREFIX) ? v.slice(TEAM_PREFIX.length) : v}</span>
          <span className="text-xs text-muted-foreground">
            {v.startsWith(TEAM_PREFIX) ? 'team' : botLogins.has(v.toLowerCase()) ? 'bot' : ''}
          </span>
        </span>
      )}
      onChange={(next) =>
        onChange({
          logins: next.filter((v) => !v.startsWith(TEAM_PREFIX)),
          teams: next
            .filter((v) => v.startsWith(TEAM_PREFIX))
            .map((v) => v.slice(TEAM_PREFIX.length))
            .filter(Boolean),
        })
      }
    />
  );
}

/**
 * Who a condition is about: anyone, me, any person, any bot, or named accounts.
 *
 * "Me" is a first-class option rather than something you express by typing your
 * own login — it keeps working when the connected account changes, and it is what
 * "run a skill when I am asked to review" actually means.
 */
export function ActorField({
  value,
  onChange,
  suggestions,
  hint,
  onNeedSuggestions,
}: {
  value: WorkflowActorMatch | undefined;
  onChange: (next: WorkflowActorMatch) => void;
  suggestions: WorkflowSuggestions | null;
  hint?: string;
  onNeedSuggestions?: () => void;
}) {
  const kind = value?.kind ?? 'any';
  const logins = value?.kind === 'logins' ? value.logins : [];
  const teams = value?.kind === 'logins' ? (value.teams ?? []) : [];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {WORKFLOW_ACTOR_KINDS.map((k) => (
          <button
            key={k}
            onClick={() =>
              onChange(k === 'logins' ? { kind: 'logins', logins: [], teams: [] } : { kind: k })
            }
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors',
              kind === k
                ? 'border-transparent bg-primary text-primary-foreground'
                : 'hover:bg-accent'
            )}
          >
            {kind === k && <Check className="h-3 w-3" />}
            {WORKFLOW_ACTOR_KIND_LABELS[k]}
          </button>
        ))}
      </div>
      {kind === 'logins' && (
        <PeopleField
          logins={logins}
          teams={teams}
          suggestions={suggestions}
          onNeedSuggestions={onNeedSuggestions}
          onChange={(next) => onChange({ kind: 'logins', ...next })}
        />
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
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
export function GithubConditionInput({
  spec,
  conditions,
  setConditions,
  suggestions,
  onNeedSuggestions,
}: {
  spec: WorkflowConditionSpec;
  conditions: WorkflowConditions;
  setConditions: (next: WorkflowConditions) => void;
  suggestions: WorkflowSuggestions | null;
  onNeedSuggestions: () => void;
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
          onNeedSuggestions={onNeedSuggestions}
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
          onNeedSuggestions={onNeedSuggestions}
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
          onNeedSuggestions={onNeedSuggestions}
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
export function GithubActionInput({
  action,
  onChange,
  suggestions,
  onNeedSuggestions,
}: {
  action: WorkflowAction;
  onChange: (next: WorkflowAction) => void;
  suggestions: WorkflowSuggestions | null;
  onNeedSuggestions: () => void;
}) {
  switch (action.type) {
    case 'add_labels':
    case 'remove_labels':
      return (
        <TokenField
          values={action.labels}
          suggestions={suggestions?.labels ?? []}
          placeholder="needs-review"
          onNeedSuggestions={onNeedSuggestions}
          onChange={(labels) => onChange({ ...action, labels })}
        />
      );
    case 'request_reviewers':
      return (
        <PeopleField
          logins={action.users ?? []}
          teams={action.teams ?? []}
          suggestions={suggestions}
          onNeedSuggestions={onNeedSuggestions}
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
          onNeedSuggestions={onNeedSuggestions}
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
    case 'run_code_review':
      return (
        <div className="space-y-1">
          <Select
            value={action.preset ?? ''}
            onChange={(e) =>
              onChange({
                ...action,
                preset: (e.target.value || undefined) as CodeReviewPreset | undefined,
              })
            }
          >
            {/* Empty is the default and stays the default: a workflow written
                before a team settles on a depth keeps following that setting
                rather than pinning whatever happened to be current. */}
            <option value="">Whatever the workspace is set to</option>
            {CODE_REVIEW_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {CODE_REVIEW_PRESET_LABELS[preset]}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            Findings appear in Talyn.
          </p>
        </div>
      );
    case 'watch_pr':
      return null;
  }
}


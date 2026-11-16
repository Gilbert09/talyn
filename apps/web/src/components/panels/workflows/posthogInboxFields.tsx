import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  PostHogInboxConditionSpec,
  PostHogInboxDryRun,
  PostHogInboxReportPreview,
  PostHogInboxScoutMatch,
  PostHogInboxStatus,
  WorkflowConditions,
  WorkflowInput,
  WorkflowSuggestions,
} from '@talyn/shared';
import {
  DEFAULT_POSTHOG_INBOX_RUNS_PER_DAY,
  MAX_WORKFLOW_RUNS_PER_DAY,
  POSTHOG_INBOX_ACTIONABILITY,
  POSTHOG_INBOX_ACTIONABILITY_LABELS,
  POSTHOG_INBOX_CONDITION_SPECS,
  POSTHOG_INBOX_PRIORITIES,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { captureAnalyticsException } from '../../../lib/analytics';
import { useNavigationStore } from '../../../stores/navigation';
import { useWorkspaceStore } from '../../../stores/workspace';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { ChoiceSet, DropdownButton, EditorRow, TextField, TokenField } from './workflowFields';

/**
 * The editor parts of a PostHog Inbox rule: the conditions, the connection
 * notice, the daily cap and the dry run preview.
 *
 * The same file is in apps/desktop/src/renderer/components/panels/workflows/. Keep the two in step.
 */

/** Source products to suggest. Any other value can be typed. */
const SOURCE_PRODUCT_SUGGESTIONS = ['error_tracking', 'session_replay'];

export interface PostHogInboxStatusState {
  status: PostHogInboxStatus | null;
  error: string | null;
}

/** Whether Talyn can read the workspace's PostHog Inbox. */
export function usePostHogInboxStatus(enabled: boolean): PostHogInboxStatusState {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const [status, setStatus] = useState<PostHogInboxStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !workspaceId) return;
    let active = true;
    api.workflows
      .posthogInboxStatus(workspaceId)
      .then((next) => {
        if (!active) return;
        setStatus(next);
        setError(null);
      })
      .catch((err: unknown) => {
        captureAnalyticsException(err, { flow: 'posthog_inbox_status' });
        if (active) setError(err instanceof Error ? err.message : 'Could not check the PostHog connection.');
      });
    return () => {
      active = false;
    };
  }, [enabled, workspaceId]);

  return { status, error };
}

function OpenPostHogCodeButton({ children }: { children: React.ReactNode }) {
  const navigate = useNavigationStore((s) => s.navigate);
  return (
    <Button
      variant="outline"
      size="sm"
      data-attr="posthog-inbox-open-posthog"
      onClick={() => navigate({ view: 'integrations', kind: 'posthog' })}
    >
      {children}
    </Button>
  );
}

function formatTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

/** What the editor says about the PostHog connection. */
export function PostHogInboxConnectionNotice({ status, error }: PostHogInboxStatusState) {
  if (error) {
    return (
      <p className="text-sm text-red-500" data-attr="posthog-inbox-status-error">
        Could not check the PostHog connection. {error}
      </p>
    );
  }
  if (!status) return null;

  if (status.access === 'not_connected' || status.access === 'reconnect') {
    const reconnect = status.access === 'reconnect';
    return (
      <div
        className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2"
        data-attr={`posthog-inbox-${status.access}`}
      >
        <div className="flex-1 text-sm">
          <p className="font-medium text-amber-600 dark:text-amber-400">
            {reconnect ? 'Reconnect PostHog to let Talyn read your Inbox.' : 'Connect PostHog first.'}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {reconnect
              ? status.reason ?? 'The PostHog connection does not have the Inbox permissions.'
              : 'Talyn reads the Inbox through your PostHog connection. Until you connect PostHog, this automation never runs.'}
          </p>
        </div>
        <OpenPostHogCodeButton>{reconnect ? 'Reconnect PostHog' : 'Connect PostHog'}</OpenPostHogCodeButton>
      </div>
    );
  }

  const polled = formatTime(status.lastPolledAt);
  return (
    <div className="space-y-1 text-xs text-muted-foreground" data-attr={`posthog-inbox-${status.access}`}>
      <p>
        {status.access === 'unknown'
          ? 'Talyn has not read your Inbox with this PostHog API key yet. Use Preview matches to test it.'
          : `Talyn reads the Inbox of PostHog project ${status.projectId ?? 'unknown'}.`}{' '}
        {polled ? `Last checked ${polled}.` : 'Not checked yet.'}
      </p>
      {status.lastError && <p className="text-red-500">The last check failed. {status.lastError}</p>}
    </div>
  );
}

/** A one-line note for the rules list: these rules use the PostHog Code connection. */
export function PostHogInboxConnectionNote() {
  const navigate = useNavigationStore((s) => s.navigate);
  return (
    <p className="border-b px-6 py-2 text-xs text-muted-foreground" data-attr="posthog-inbox-connection">
      Uses your PostHog connection.{' '}
      <button
        type="button"
        className="underline hover:text-foreground"
        onClick={() => navigate({ view: 'integrations', kind: 'posthog' })}
      >
        Open PostHog Code
      </button>
    </p>
  );
}

/** The Connection tab of the PostHog Inbox page. The connection itself is on the PostHog Code page. */
export function PostHogInboxConnectionSection() {
  const state = usePostHogInboxStatus(true);
  return (
    <div className="space-y-3 rounded-lg border p-4" data-attr="posthog-inbox-connection-section">
      <p className="text-sm">
        PostHog Inbox automations use your PostHog connection. Connect or reconnect PostHog on the PostHog Code page.
      </p>
      <PostHogInboxConnectionNotice {...state} />
      <OpenPostHogCodeButton>Open PostHog Code</OpenPostHogCodeButton>
    </div>
  );
}

function emptyPostHogInboxConditionValue(spec: PostHogInboxConditionSpec): unknown {
  switch (spec.input) {
    case 'actionability':
      return ['immediately_actionable'];
    case 'scouts':
      return {};
    case 'text':
      return '';
    case 'number':
      return 2;
    default:
      return [];
  }
}

function ScoutsField({
  value,
  onChange,
}: {
  value: PostHogInboxScoutMatch | undefined;
  onChange: (next: PostHogInboxScoutMatch) => void;
}) {
  const set = (key: 'include' | 'exclude', list: string[]) => {
    const next = { ...(value ?? {}) };
    if (list.length > 0) next[key] = list;
    else delete next[key];
    onChange(next);
  };
  return (
    <div className="space-y-2">
      <TokenField
        label="Include"
        values={value?.include ?? []}
        suggestions={[]}
        placeholder="Scout skill name"
        onChange={(list) => set('include', list)}
      />
      <TokenField
        label="Exclude"
        values={value?.exclude ?? []}
        suggestions={[]}
        placeholder="Scout skill name"
        onChange={(list) => set('exclude', list)}
      />
    </div>
  );
}

function PostHogInboxConditionInput({
  spec,
  conditions,
  setConditions,
  suggestions,
  onNeedSuggestions,
}: {
  spec: PostHogInboxConditionSpec;
  conditions: WorkflowConditions;
  setConditions: (next: WorkflowConditions) => void;
  suggestions: WorkflowSuggestions | null;
  onNeedSuggestions: () => void;
}) {
  const set = (value: unknown) => setConditions({ ...conditions, [spec.key]: value });
  const list = (conditions[spec.key] as string[] | undefined) ?? [];

  switch (spec.input) {
    case 'repos':
      return <TokenField values={list} onChange={set} suggestions={suggestions?.repos ?? []} placeholder="owner/repo" />;
    case 'priorities':
      return (
        <ChoiceSet
          options={POSTHOG_INBOX_PRIORITIES.map((p) => ({ value: p as string, label: p }))}
          selected={list}
          onChange={set}
        />
      );
    case 'actionability':
      return (
        <div className="space-y-1">
          <ChoiceSet
            options={POSTHOG_INBOX_ACTIONABILITY.map((a) => ({
              value: a as string,
              label: POSTHOG_INBOX_ACTIONABILITY_LABELS[a],
            }))}
            selected={list}
            onChange={set}
          />
          {list.length === 0 && (
            <p className="text-xs text-muted-foreground">Nothing picked. Only reports ready to fix match.</p>
          )}
        </div>
      );
    case 'list':
      return (
        <TokenField values={list} onChange={set} suggestions={SOURCE_PRODUCT_SUGGESTIONS} placeholder="error_tracking" />
      );
    case 'scouts':
      return <ScoutsField value={conditions.scouts} onChange={set} />;
    case 'people':
      return (
        <TokenField
          values={list}
          onChange={set}
          suggestions={(suggestions?.people ?? []).map((p) => p.login)}
          onNeedSuggestions={onNeedSuggestions}
          placeholder="GitHub login"
        />
      );
    case 'text':
      return <TextField value={(conditions[spec.key] as string | undefined) ?? ''} onChange={set} />;
    case 'number':
      return (
        <Input
          type="number"
          min={1}
          aria-label={spec.label}
          className="max-w-32"
          value={(conditions[spec.key] as number | undefined) ?? ''}
          onChange={(e) => set(Number(e.target.value))}
        />
      );
  }
}

/** The "Only if" rows of a PostHog Inbox rule. */
export function PostHogInboxConditions({
  conditions,
  setConditions,
  suggestions,
  onNeedSuggestions,
}: {
  conditions: WorkflowConditions;
  setConditions: (next: WorkflowConditions) => void;
  suggestions: WorkflowSuggestions | null;
  onNeedSuggestions: () => void;
}) {
  const shown = POSTHOG_INBOX_CONDITION_SPECS.filter((s) => s.required || conditions[s.key] !== undefined);
  const addable = POSTHOG_INBOX_CONDITION_SPECS.filter((s) => !s.required && conditions[s.key] === undefined);

  const remove = (key: keyof WorkflowConditions) => {
    const next = { ...conditions };
    delete next[key];
    setConditions(next);
  };

  return (
    <div className="space-y-3" data-attr="posthog-inbox-conditions">
      {shown.map((spec) => (
        <EditorRow key={spec.key} title={spec.label} hint={spec.hint} onRemove={() => remove(spec.key)}>
          <PostHogInboxConditionInput
            spec={spec}
            conditions={conditions}
            setConditions={setConditions}
            suggestions={suggestions}
            onNeedSuggestions={onNeedSuggestions}
          />
        </EditorRow>
      ))}
      {shown.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No conditions. This runs on every report PostHog judged ready to fix, in any repository connected to this
          workspace.
        </p>
      )}
      <DropdownButton
        label="Add condition"
        options={addable.map((s) => ({ value: s.key, label: s.label, hint: s.hint }))}
        emptyHint="Every condition is already added"
        onPick={(key) => {
          const spec = POSTHOG_INBOX_CONDITION_SPECS.find((s) => s.key === key);
          if (spec) setConditions({ ...conditions, [spec.key]: emptyPostHogInboxConditionValue(spec) });
        }}
      />
    </div>
  );
}

/** The daily cap of a PostHog Inbox rule. Empty means the default cap. */
export function PostHogInboxDailyCapField({
  value,
  onChange,
}: {
  value: number | null | undefined;
  onChange: (value: number | null) => void;
}) {
  return (
    <div className="mt-2 rounded-lg border p-4" data-attr="posthog-inbox-daily-cap">
      <label className="text-xs font-medium text-muted-foreground" htmlFor="workflow-runs-per-day">
        Runs per day
      </label>
      <Input
        id="workflow-runs-per-day"
        type="number"
        min={1}
        max={MAX_WORKFLOW_RUNS_PER_DAY}
        className="mt-1 max-w-32"
        value={value ?? ''}
        placeholder={String(DEFAULT_POSTHOG_INBOX_RUNS_PER_DAY)}
        onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))}
      />
      <p className="mt-1 text-xs text-muted-foreground">
        Each run starts a session, and one PostHog project can make many reports. Empty means{' '}
        {DEFAULT_POSTHOG_INBOX_RUNS_PER_DAY} runs per day.
      </p>
    </div>
  );
}

function ReportRow({ report }: { report: PostHogInboxReportPreview }) {
  return (
    <li className="flex items-start gap-3 py-1.5 text-sm">
      <div className="min-w-0 flex-1">
        <a href={report.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
          {report.title || `Report ${report.id}`}
        </a>
        <div className="text-xs text-muted-foreground">
          {[
            report.priority,
            report.repository ?? 'No repository',
            `${report.signalCount} signal${report.signalCount === 1 ? '' : 's'}`,
          ]
            .filter(Boolean)
            .join(' · ')}
          {!report.matched && report.reason ? ` · ${report.reason}` : ''}
        </div>
      </div>
    </li>
  );
}

/** "Preview matches": the reports the unsaved rule would act on now. Starts nothing. */
export function PostHogInboxPreview({ input, problem }: { input: WorkflowInput; problem: string | null }) {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const [result, setResult] = useState<PostHogInboxDryRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showProblem, setShowProblem] = useState(false);
  const request = useRef(0);

  // A changed rule makes the old preview wrong.
  const conditionsKey = useMemo(() => JSON.stringify(input.conditions ?? {}), [input.conditions]);
  useEffect(() => {
    request.current += 1;
    setResult(null);
    setError(null);
    setLoading(false);
  }, [conditionsKey]);
  useEffect(() => {
    if (!problem) setShowProblem(false);
  }, [problem]);

  const preview = async () => {
    if (problem) {
      setShowProblem(true);
      return;
    }
    if (!workspaceId) return;
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const next = await api.workflows.posthogInboxDryRun(workspaceId, input);
      if (request.current === id) setResult(next);
    } catch (err) {
      captureAnalyticsException(err, { flow: 'posthog_inbox_dry_run' });
      if (request.current === id) setError(err instanceof Error ? err.message : 'Could not read the PostHog Inbox.');
    } finally {
      if (request.current === id) setLoading(false);
    }
  };

  return (
    <section className="rounded-lg border" data-attr="posthog-inbox-preview">
      <header className="flex items-start gap-3 border-b px-4 py-3">
        <div className="flex-1">
          <h2 className="text-sm font-semibold">Preview matches</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Shows the reports this automation would act on now. The preview starts nothing.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void preview()} disabled={loading} data-attr="posthog-inbox-preview-run">
          {loading ? 'Reading...' : 'Preview matches'}
        </Button>
      </header>
      {(showProblem && problem) || error || result ? (
        <div className="space-y-3 p-4">
          {showProblem && problem && (
            <p className="text-sm text-red-500">Fix this first, then preview again. {problem}</p>
          )}
          {error && <p className="text-sm text-red-500">{error}</p>}
          {result && (
            <>
              <p className="text-xs text-muted-foreground">
                Talyn read {result.scanned} report{result.scanned === 1 ? '' : 's'}. {result.matches.length} of them{' '}
                {result.matches.length === 1 ? 'matches' : 'match'}.
                {result.truncated && ' PostHog has more reports than the preview reads.'}
              </p>
              {result.matches.length === 0 ? (
                <p className="text-sm text-muted-foreground">No reports match now.</p>
              ) : (
                <ul className="divide-y" data-attr="posthog-inbox-preview-matches">
                  {result.matches.map((report) => (
                    <ReportRow key={report.id} report={report} />
                  ))}
                </ul>
              )}
              {result.skipped.length > 0 && (
                <details data-attr="posthog-inbox-preview-skipped">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    {result.skipped.length} skipped report{result.skipped.length === 1 ? '' : 's'}
                  </summary>
                  <ul className="mt-1 divide-y">
                    {result.skipped.map((report) => (
                      <ReportRow key={report.id} report={report} />
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

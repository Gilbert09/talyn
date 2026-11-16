import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, Loader2, Pencil, RefreshCw, Unlink } from 'lucide-react';
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
  POSTHOG_INBOX_OAUTH_UNAVAILABLE_CODE,
  POSTHOG_INBOX_PRIORITIES,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { captureAnalyticsException, trackEvent } from '../../../lib/analytics';
import { openIntegrationSection } from '../../../lib/automationFocus';
import { openExternal } from '../../../lib/openExternal';
import { useWorkspaceStore } from '../../../stores/workspace';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Card } from '../../ui/card';
import { Input } from '../../ui/input';
import { GetKeyLink, POSTHOG_API_KEYS_URL } from '../../widgets/GetKeyLink';
import { ChoiceSet, DropdownButton, EditorRow, TextField, TokenField } from './workflowFields';

/**
 * The editor parts of a PostHog Inbox rule: the conditions, the connection
 * notice, the daily cap and the dry run preview.
 *
 * The same file is in apps/web/src/components/panels/workflows/. Keep the two in step.
 */

/** Source products to suggest. Any other value can be typed. */
const SOURCE_PRODUCT_SUGGESTIONS = ['error_tracking', 'session_replay'];

export interface PostHogInboxStatusState {
  status: PostHogInboxStatus | null;
  error: string | null;
}

export interface PostHogInboxStatusHook extends PostHogInboxStatusState {
  /** Read the status again, for example after a connect in the browser. */
  reload: () => void;
  /** Show a status that a save or a disconnect sent back. */
  setStatus: (next: PostHogInboxStatus) => void;
}

/**
 * Whether Talyn can read the workspace's PostHog Inbox. The status is read
 * again when the window gets focus, because a connect finishes in the browser.
 */
export function usePostHogInboxStatus(enabled: boolean): PostHogInboxStatusHook {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const [status, setStatusState] = useState<PostHogInboxStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only the newest read may land: an older answer must not replace a newer one.
  const request = useRef(0);

  const reload = useCallback(() => {
    if (!enabled || !workspaceId) return;
    const id = ++request.current;
    api.workflows
      .posthogInboxStatus(workspaceId)
      .then((next) => {
        if (request.current !== id) return;
        setStatusState(next);
        setError(null);
      })
      .catch((err: unknown) => {
        captureAnalyticsException(err, { flow: 'posthog_inbox_status' });
        if (request.current === id) setError(err instanceof Error ? err.message : 'Could not check the PostHog connection.');
      });
  }, [enabled, workspaceId]);

  useEffect(() => {
    if (!enabled || !workspaceId) return;
    reload();
    window.addEventListener('focus', reload);
    return () => {
      window.removeEventListener('focus', reload);
      request.current += 1;
    };
  }, [enabled, workspaceId, reload]);

  const setStatus = useCallback((next: PostHogInboxStatus) => {
    request.current += 1;
    setStatusState(next);
    setError(null);
  }, []);

  return { status, error, reload, setStatus };
}

/** Opens the Connection tab of the PostHog Inbox page. */
function openInboxConnection() {
  openIntegrationSection('posthog_inbox', 'connection');
}

function formatTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

function errorCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** The scopes an OAuth grant does not have, as one line. */
function MissingScopes({ scopes }: { scopes: string[] }) {
  if (scopes.length === 0) return null;
  return (
    <p className="mt-0.5 text-xs text-muted-foreground" data-attr="posthog-inbox-missing-scopes">
      Missing permissions: {scopes.join(', ')}.
    </p>
  );
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
              : 'Talyn reads the Inbox through a PostHog connection. Until you connect PostHog, this automation never runs.'}
          </p>
          {reconnect && <MissingScopes scopes={status.missingScopes ?? []} />}
        </div>
        <Button variant="outline" size="sm" data-attr="posthog-inbox-open-connection" onClick={openInboxConnection}>
          {reconnect ? 'Reconnect PostHog' : 'Connect PostHog'}
        </Button>
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
      {status.connection === 'posthog_code' && (
        <p>
          It uses the older PostHog Code connection.{' '}
          <button type="button" className="underline hover:text-foreground" onClick={openInboxConnection}>
            Connect PostHog for the Inbox
          </button>
        </p>
      )}
      {status.lastError && <p className="text-red-500">The last check failed. {status.lastError}</p>}
    </div>
  );
}

/** A one-line note for the rules list: where the PostHog connection of these rules is. */
export function PostHogInboxConnectionNote() {
  return (
    <p className="border-b px-6 py-2 text-xs text-muted-foreground" data-attr="posthog-inbox-connection">
      These automations read the Inbox through your PostHog connection.{' '}
      <button type="button" className="underline hover:text-foreground" onClick={openInboxConnection}>
        Manage the connection
      </button>
    </p>
  );
}

const DEFAULT_POSTHOG_HOST = 'https://us.posthog.com';
const POSTHOG_INBOX_KEY_SCOPE_NOTE = 'the key needs the inbox:read, inbox:write and task:write scopes.';

function ConnectionBadge({ status }: { status: PostHogInboxStatus }) {
  if (status.access === 'reconnect') return <Badge variant="destructive">Reconnect needed</Badge>;
  if (status.access === 'ok' || status.access === 'unknown') {
    return (
      <Badge variant="default" className="bg-green-600">
        <Check className="mr-1 h-3 w-3" />
        Connected
      </Badge>
    );
  }
  return <Badge variant="secondary">Not connected</Badge>;
}

/**
 * The Connection tab of the PostHog Inbox page. The Inbox has its own PostHog
 * connection. An older PostHog Code connection with the Inbox scopes still
 * works until the Inbox gets its own. A disconnect here never touches
 * PostHog Code.
 */
export function PostHogInboxConnectionSection() {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const { status, error: loadError, setStatus } = usePostHogInboxStatus(true);
  const [host, setHost] = useState(DEFAULT_POSTHOG_HOST);
  const [apiKey, setApiKey] = useState('');
  const [projectId, setProjectId] = useState('');
  const [keyForm, setKeyForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the form from the status. The deps are scalars, so a typed value stays.
  useEffect(() => {
    if (status?.host) setHost(status.host);
  }, [status?.host]);
  useEffect(() => {
    if (status?.projectId) setProjectId(status.projectId);
  }, [status?.projectId]);

  if (!status) {
    return (
      <Card className="p-4" data-attr="posthog-inbox-connection-section">
        <h4 className="font-medium">PostHog Inbox</h4>
        {loadError ? (
          <p className="mt-1 text-sm text-red-500">Could not check the PostHog connection. {loadError}</p>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">Checking the PostHog connection...</p>
        )}
      </Card>
    );
  }

  const oauthAvailable = status.oauthAvailable === true;
  const own = status.connection === 'posthog_inbox';
  const legacy = status.connection === 'posthog_code';
  const notConnected = status.access === 'not_connected' || status.connection === null;
  // Without OAuth, the key form is the only way to connect.
  const showKeyForm = keyForm || (notConnected && !oauthAvailable);

  const connectOAuth = async () => {
    if (!workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      const { authorizeUrl } = await api.posthogInbox.startOAuth(workspaceId, {
        host: host.trim() || undefined,
        // Only a pre-selection on PostHog's consent screen. It helps on a reconnect.
        projectId: status.projectId ?? undefined,
      });
      trackEvent('posthog_inbox_oauth_started');
      // The real browser holds the user's PostHog session. The status is read
      // again when this window gets focus.
      await openExternal(authorizeUrl);
    } catch (err) {
      captureAnalyticsException(err, { flow: 'posthog_inbox_oauth_start' });
      if (errorCode(err) === POSTHOG_INBOX_OAUTH_UNAVAILABLE_CODE) {
        setKeyForm(true);
        setError('PostHog sign-in is not set up here. Use a personal API key.');
      } else {
        setError(errorMessage(err, 'Could not start the PostHog sign-in.'));
      }
    } finally {
      setBusy(false);
    }
  };

  // Without OAuth, a reconnect means a new personal API key.
  const reconnect = () => {
    if (oauthAvailable) void connectOAuth();
    else setKeyForm(true);
  };

  const saveKey = async () => {
    if (!workspaceId || !apiKey.trim() || !projectId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.posthogInbox.saveConfig(workspaceId, {
        apiKey: apiKey.trim(),
        projectId: projectId.trim(),
        host: host.trim() || undefined,
      });
      trackEvent('posthog_inbox_connected', { authMethod: 'personal_api_key' });
      setStatus(next);
      setApiKey('');
      setKeyForm(false);
    } catch (err) {
      captureAnalyticsException(err, { flow: 'posthog_inbox_save_key' });
      setError(errorMessage(err, 'Could not save the API key.'));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.posthogInbox.disconnect(workspaceId);
      trackEvent('posthog_inbox_disconnected');
      setStatus(next);
      setKeyForm(false);
    } catch (err) {
      captureAnalyticsException(err, { flow: 'posthog_inbox_disconnect' });
      setError(errorMessage(err, 'Could not disconnect PostHog.'));
    } finally {
      setBusy(false);
    }
  };

  const description = () => {
    if (notConnected) {
      return oauthAvailable
        ? 'Connect PostHog to let Talyn read and claim reports in your Inbox. Talyn asks only for Inbox and task access to one project.'
        : 'Add a personal API key and a project id to let Talyn read your Inbox.';
    }
    if (legacy) return 'These automations use your older PostHog Code connection. Connect PostHog for the Inbox to give it its own connection.';
    return status.authMethod === 'oauth'
      ? 'Talyn reads your Inbox with your PostHog account.'
      : 'Talyn reads your Inbox with a personal API key.';
  };

  const polled = formatTime(status.lastPolledAt);
  const errorLine = error && (
    <div className="flex items-start gap-2 text-sm text-destructive" data-attr="posthog-inbox-connect-error">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{error}</span>
    </div>
  );

  return (
    <Card className="p-4" data-attr="posthog-inbox-connection-section">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="font-medium">PostHog Inbox</h4>
            <ConnectionBadge status={status} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{description()}</p>

          {!notConnected && (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm" data-attr="posthog-inbox-connection-details">
              <dt className="text-muted-foreground">Project</dt>
              <dd>{status.projectId ?? 'Unknown'}</dd>
              <dt className="text-muted-foreground">Host</dt>
              <dd>{status.host ?? 'Unknown'}</dd>
              <dt className="text-muted-foreground">Last checked</dt>
              <dd>{polled ?? 'Not checked yet'}</dd>
            </dl>
          )}
          {!notConnected && status.access === 'unknown' && (
            <p className="mt-2 text-xs text-muted-foreground">
              Talyn has not used this API key on your Inbox yet.
            </p>
          )}
          {status.lastError && !notConnected && (
            <p className="mt-2 text-xs text-red-500">The last check failed. {status.lastError}</p>
          )}

          {status.access === 'reconnect' && (
            <div
              className="mt-3 flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2"
              data-attr="posthog-inbox-reconnect-notice"
            >
              <div className="flex-1 text-sm">
                <p className="font-medium text-amber-600 dark:text-amber-400">Reconnect PostHog to let Talyn read your Inbox.</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {status.reason ?? 'The PostHog connection does not have the Inbox permissions.'}
                </p>
                <MissingScopes scopes={status.missingScopes ?? []} />
              </div>
              <Button size="sm" onClick={reconnect} disabled={busy} data-attr="posthog-inbox-reconnect">
                <RefreshCw className="mr-1 h-4 w-4" />
                Reconnect
              </Button>
            </div>
          )}

          {notConnected && oauthAvailable && !showKeyForm && (
            <div className="mt-3 space-y-3">
              <Input
                label="PostHog host"
                aria-label="PostHog host"
                placeholder={DEFAULT_POSTHOG_HOST}
                value={host}
                onChange={(e) => setHost(e.target.value)}
                disabled={busy}
              />
              {errorLine}
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => void connectOAuth()} disabled={busy || !workspaceId} data-attr="posthog-inbox-connect">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Connect with PostHog'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setKeyForm(true)} disabled={busy}>
                  Use a personal API key instead
                </Button>
              </div>
            </div>
          )}

          {showKeyForm && (
            <div className="mt-3 space-y-3" data-attr="posthog-inbox-key-form">
              <Input
                label="Personal API key"
                aria-label="Personal API key"
                type="password"
                placeholder="phx_..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={busy}
              />
              <GetKeyLink url={POSTHOG_API_KEYS_URL} note={POSTHOG_INBOX_KEY_SCOPE_NOTE} />
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Project id"
                  aria-label="Project id"
                  placeholder="e.g. 2"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  disabled={busy}
                />
                <Input
                  label="Host"
                  aria-label="Host"
                  placeholder={DEFAULT_POSTHOG_HOST}
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  disabled={busy}
                />
              </div>
              {errorLine}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => void saveKey()}
                  disabled={busy || !apiKey.trim() || !projectId.trim() || !workspaceId}
                  data-attr="posthog-inbox-save-key"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save and verify'}
                </Button>
                {oauthAvailable && (
                  <Button size="sm" variant="ghost" onClick={() => void connectOAuth()} disabled={busy}>
                    Connect with PostHog instead
                  </Button>
                )}
                {(oauthAvailable || !notConnected) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setKeyForm(false);
                      setApiKey('');
                      setError(null);
                    }}
                    disabled={busy}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          )}

          {!notConnected && !showKeyForm && errorLine && <div className="mt-3">{errorLine}</div>}
        </div>

        {!notConnected && !showKeyForm && (
          <div className="flex shrink-0 flex-col items-end gap-2">
            {legacy && (
              <Button size="sm" onClick={reconnect} disabled={busy} data-attr="posthog-inbox-connect-own">
                Connect PostHog for the Inbox
              </Button>
            )}
            {own && status.access !== 'reconnect' && (
              <Button variant="outline" size="sm" onClick={reconnect} disabled={busy}>
                {oauthAvailable ? <RefreshCw className="mr-1 h-4 w-4" /> : <Pencil className="mr-1 h-4 w-4" />}
                {oauthAvailable ? (status.authMethod === 'oauth' ? 'Reconnect' : 'Switch to PostHog sign-in') : 'Edit'}
              </Button>
            )}
            {own && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void disconnect()}
                disabled={busy}
                data-attr="posthog-inbox-disconnect"
              >
                {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Unlink className="mr-1 h-4 w-4" />}
                Disconnect
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
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

import type { PostHogCodeStatus } from '@talyn/client/native';
import {
  DEFAULT_POSTHOG_CODE_MODEL_ID, DEFAULT_POSTHOG_INBOX_ACTIONABILITY, INVALID_RETURN_TO_CODE, isWorkflowIntegration, POSTHOG_CODE_MODELS,
  POSTHOG_INBOX_ACTIONABILITY_LABELS, POSTHOG_INBOX_CONDITION_SPECS,
  type LinearConnection, type WorkflowConditions, type TrunkIntegrationStatus, type WorkflowIntegration, type WorkspaceSettings,
} from '@talyn/shared';

import type { Tone } from '../../components/UI';

/** Where PostHog hands out personal API keys. Same link as web `GetKeyLink`. */
export const POSTHOG_API_KEYS_URL = 'https://app.posthog.com/settings/user-api-keys';
/** The PostHog Code client only calls the tasks API, so that is all the key needs. */
export const POSTHOG_KEY_SCOPE_NOTE = 'the key needs read + write access to Tasks for your project.';
export const DEFAULT_POSTHOG_HOST = 'https://us.posthog.com';

export const POSTHOG_MODEL_DESCRIPTION = 'Which model PostHog Code runs use. Opus 5 is the most capable model; Fable 5 is the newest.';

export interface Badge { label: string; tone: Tone }

// ---------------------------------------------------------------------------
// PostHog Code
// ---------------------------------------------------------------------------

/** What the card shows, and which action its main button runs. Mirrors web `PostHogCodeCard`. */
export interface PostHogView {
  connected: boolean;
  usingOAuth: boolean;
  needsReauth: boolean;
  oauthAvailable: boolean;
  badge: Badge;
  description: string;
  /** The button beside Disconnect on a connected card. */
  connectedAction: { kind: 'reconnect' | 'switch' | 'edit'; label: string };
}

export function postHogView(status: PostHogCodeStatus | null | undefined): PostHogView {
  const connected = Boolean(status?.connected);
  const usingOAuth = status?.authMethod === 'oauth';
  const needsReauth = status?.needsReauth === true;
  // Strict: an app newer than its backend must not offer a flow the backend cannot start.
  const oauthAvailable = status?.oauthAvailable === true;
  const badge: Badge = needsReauth ? { label: 'Reconnect needed', tone: 'destructive' }
    : connected ? { label: 'Connected', tone: 'success' } : { label: 'Not Connected', tone: 'muted' };
  let description: string;
  if (needsReauth) description = 'PostHog rejected the stored authorization. Reconnect to keep cloud tasks running.';
  else if (connected) {
    description = `Cloud tasks run under project ${status?.projectId} on ${status?.host}${usingOAuth ? ', authorized with your PostHog account.' : '.'}`;
  } else {
    description = oauthAvailable
      ? 'Connect your PostHog account to run tasks on PostHog Code’s cloud sandbox. Talyn asks only for task access to the one project you pick.'
      : 'Add a personal API key + project id to run tasks on PostHog Code’s cloud sandbox.';
  }
  const connectedAction: PostHogView['connectedAction'] = usingOAuth ? { kind: 'reconnect', label: 'Reconnect' }
    : oauthAvailable ? { kind: 'switch', label: 'Switch to PostHog sign-in' } : { kind: 'edit', label: 'Edit' };
  return { connected, usingOAuth, needsReauth, oauthAvailable, badge, description, connectedAction };
}

/** The key form is the landing state only where OAuth is not an option. */
export function keyFormOpen(view: Pick<PostHogView, 'connected' | 'oauthAvailable'>, editing: boolean): boolean {
  return editing || (!view.connected && !view.oauthAvailable);
}

export interface PostHogKeyInput { apiKey: string; projectId: string; host: string }
export interface PostHogKeyConfig { apiKey: string; projectId: string; host?: string }

/** The `saveConfig` body, or null when web would keep Save disabled (no key or no project id). */
export function postHogKeyConfig(input: PostHogKeyInput): PostHogKeyConfig | null {
  const apiKey = input.apiKey.trim();
  const projectId = input.projectId.trim();
  if (!apiKey || !projectId) return null;
  const host = input.host.trim();
  return host ? { apiKey, projectId, host } : { apiKey, projectId };
}

/** The `startOAuth` options. A blank host is left to the server. */
export function postHogOAuthOptions(host: string, projectId: string | undefined, returnTo?: string) {
  return {
    ...(host.trim() ? { host: host.trim() } : {}),
    ...(projectId ? { projectId } : {}),
    ...(returnTo ? { returnTo } : {}),
  };
}

/** The stored PostHog Code model, or the default. A retired id stays as it is. */
export function postHogModelOf(settings: Pick<WorkspaceSettings, 'posthogCodeModel'> | null | undefined): string {
  return settings?.posthogCodeModel ?? DEFAULT_POSTHOG_CODE_MODEL_ID;
}

export function postHogModelLabel(id: string): string {
  return POSTHOG_CODE_MODELS.find((model) => model.id === id)?.label ?? id;
}

// ---------------------------------------------------------------------------
// Trunk
// ---------------------------------------------------------------------------

export const TRUNK_DESCRIPTION = 'Show when pull requests in Trunk’s merge queue will merge. In Trunk, open Settings → Developer → API Keys and create a key; it needs no permissions. Talyn stores it encrypted and never shows it again.';

export interface TrunkView {
  connected: boolean;
  needsReauth: boolean;
  badge: Badge | null;
  description: string;
  /** The button that opens the form on a connected card. */
  replaceLabel: string;
}

/** Mirrors web `TrunkSettingsCard`. */
export function trunkView(status: TrunkIntegrationStatus | null | undefined): TrunkView {
  const connected = status?.connected === true;
  const needsReauth = status?.needsReauth === true;
  return {
    connected,
    needsReauth,
    badge: needsReauth ? { label: 'Reconnect needed', tone: 'warning' } : connected ? { label: 'Connected', tone: 'success' } : null,
    description: needsReauth
      ? `${status?.reauthReason ?? 'Trunk refused the saved API key.'} Paste a new key to see merge ETAs again.`
      : TRUNK_DESCRIPTION,
    replaceLabel: needsReauth ? 'Reconnect' : 'Replace key',
  };
}

/** The form shows until a key is saved, and again while it is being replaced. */
export function trunkFormOpen(view: Pick<TrunkView, 'connected'>, editing: boolean): boolean {
  return !view.connected || editing;
}

/** The token to send, or null when Save stays disabled. */
export function trunkToken(raw: string): string | null {
  const token = raw.trim();
  return token ? token : null;
}

// ---------------------------------------------------------------------------
// Browser flows that return to the app
// ---------------------------------------------------------------------------

/** An older server that refuses the app's return target. The caller asks again without it. */
export function refusesReturnTarget(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return code === INVALID_RETURN_TO_CODE || (status === 400 && code === undefined);
}

/**
 * Starts a browser flow that finishes in the app. When the server refuses the
 * return target, it asks once more without one; that flow then ends on the
 * web, and the screen refetches when the browser closes.
 */
export async function withAppReturn<T>(request: (returnTo?: string) => Promise<T>, base: string): Promise<T> {
  try {
    return await request(base);
  } catch (error) {
    if (!refusesReturnTarget(error)) throw error;
    return request(undefined);
  }
}

/** Only an https address may open in the browser. */
export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Issue integrations
// ---------------------------------------------------------------------------

/** The rule list an integration card opens. Only the workflow integrations have their own; the rest read as GitHub. */
export function ruleIntegration(kind: string): WorkflowIntegration {
  return kind !== 'schedule' && isWorkflowIntegration(kind) ? kind : 'github';
}

/** GitHub Issues rides the GitHub connection, so its card needs GitHub connected as well as the flag. */
export function githubIssuesAvailable(githubConnected: boolean): boolean {
  return githubConnected;
}

export interface LinearConnectionView { id: string; name: string; needsReconnect: boolean; detail: string }

export function linearConnectionView(connection: LinearConnection): LinearConnectionView {
  const name = connection.organizationName ?? connection.urlKey ?? 'Linear workspace';
  const needsReconnect = connection.reauthRequiredAt !== null;
  return {
    id: connection.id, name, needsReconnect,
    detail: needsReconnect ? (connection.reauthReason ?? 'Linear ended the connection. Connect again.') : 'Connected',
  };
}

/** The `linear=error` return carries a message; any other return carries none. */
export function linearReturnError(url: string): string | null {
  try {
    const params = new URL(url).searchParams;
    return params.get('linear') === 'error' ? (params.get('message') ?? 'Linear sign-in did not finish.') : null;
  } catch { return null; }
}

/** What a PostHog Inbox rule filters on, one line per condition it sets. Actionability always shows, with PostHog's default when unset. */
export function postHogInboxConditionFacts(conditions: WorkflowConditions | null | undefined): Array<{ label: string; value: string }> {
  const c = conditions ?? {};
  const actionabilityLabel = (value: string) => (POSTHOG_INBOX_ACTIONABILITY_LABELS as Record<string, string>)[value] ?? value;
  const facts: Array<{ label: string; value: string }> = [];
  for (const spec of POSTHOG_INBOX_CONDITION_SPECS) {
    let value = '';
    switch (spec.key) {
      case 'repositories': case 'priorities': case 'sourceProducts': case 'suggestedReviewers':
        value = (c[spec.key] ?? []).join(', ');
        break;
      case 'actionability':
        value = (c.actionability ?? [...DEFAULT_POSTHOG_INBOX_ACTIONABILITY]).map(actionabilityLabel).join(', ');
        break;
      case 'scouts': {
        const parts = [];
        if (c.scouts?.include?.length) parts.push(`only ${c.scouts.include.join(', ')}`);
        if (c.scouts?.exclude?.length) parts.push(`not ${c.scouts.exclude.join(', ')}`);
        value = parts.join('; ');
        break;
      }
      case 'titleContains': case 'summaryContains':
        value = c[spec.key]?.trim() ? `“${c[spec.key]!.trim()}”` : '';
        break;
      case 'minSignalCount':
        value = typeof c.minSignalCount === 'number' && c.minSignalCount > 0 ? String(c.minSignalCount) : '';
        break;
    }
    if (value) facts.push({ label: spec.label, value });
  }
  return facts;
}

/** The daily cap line of a rule, or null when it has none. */
export function dailyCapText(maxRunsPerDay: number | null | undefined): string | null {
  return typeof maxRunsPerDay === 'number' && maxRunsPerDay > 0 ? `${maxRunsPerDay} ${maxRunsPerDay === 1 ? 'run' : 'runs'} a day` : null;
}

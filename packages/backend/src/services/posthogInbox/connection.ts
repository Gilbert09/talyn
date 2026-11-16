import type { PostHogInboxAccess, PostHogInboxConnectionSource } from '@talyn/shared';
import { POSTHOG_INBOX_CLAIM_SCOPES, POSTHOG_INBOX_REQUIRED_SCOPES, POSTHOG_INBOX_SCOPES } from '@talyn/shared';
import { isEncryptedEnvelope } from '../tokenCrypto.js';
import { getPostHogCodeCredentials, readApiKey } from '../posthogCode/credentials.js';
import { PostHogHostNotAllowedError } from '../posthogCode/hostPolicy.js';
import {
  normalizeHost,
  readAuthMethod,
  readPostHogIntegration,
  type PostHogIntegrationRow,
} from '../posthogCode/integrationRow.js';
import { PostHogInboxClient } from './api.js';
import { inboxRowCredentials, readInboxRow } from './credentials.js';
import type { PostHogInboxConnectionRef } from './facts.js';

/**
 * The workspace's PostHog connection, as PostHog Inbox rules use it.
 *
 * The Inbox has its own connection: an `integrations` row of type
 * `posthog_inbox`, with an OAuth grant or a personal API key. When it exists,
 * it is the only one used, in any state.
 *
 * When it does not, an older PostHog Code row (type `posthog`) is used if it
 * can serve the Inbox: an OAuth grant with `inbox:read` that PostHog has not
 * revoked, or a personal API key (its scopes show only when PostHog answers).
 * That keeps workspaces that set up Inbox rules on PostHog Code working with
 * no reconnect. A PostHog Code grant without the Inbox scopes is not used.
 *
 * `getPostHogInboxConnection` is the single entry point for the poller, the
 * dry run, the claims and the webhook.
 */
export interface PostHogInboxConnection extends PostHogInboxConnectionRef {
  authMethod: 'oauth' | 'personal_api_key';
  client: PostHogInboxClient;
}

function grantedScopes(scope: string | null | undefined): Set<string> {
  return new Set((scope ?? '').split(/\s+/).filter(Boolean));
}

/** Whether a stored OAuth scope string grants the Inbox read. */
export function scopeGrantsInbox(scope: string | null | undefined): boolean {
  return grantedScopes(scope).has(POSTHOG_INBOX_SCOPES[0]);
}

/**
 * Whether a stored OAuth scope string lets Talyn claim a report and attach its
 * pull request: `inbox:write` and `task:write`. Without both, the rules start
 * no session, because a session must not start without a claim.
 */
export function scopeGrantsInboxClaims(scope: string | null | undefined): boolean {
  const granted = grantedScopes(scope);
  return POSTHOG_INBOX_CLAIM_SCOPES.every((s) => granted.has(s));
}

/** The editor's notice for a grant that can read the Inbox but not claim. */
export const CLAIM_SCOPES_MISSING_REASON =
  'The PostHog connection cannot claim Inbox reports, so the automations start no sessions. ' +
  'Connect PostHog again to grant the inbox:write and task:write permissions.';

/** The required Inbox scopes a stored OAuth scope string does not hold. */
export function missingInboxScopes(scope: string | null | undefined): string[] {
  const granted = grantedScopes(scope);
  return POSTHOG_INBOX_REQUIRED_SCOPES.filter((s) => !granted.has(s));
}

/**
 * Whether a PostHog Code row may serve the Inbox, when the Inbox has no row
 * of its own. A revoked grant does not: the user cannot reconnect PostHog Code
 * from the Inbox page, so the Inbox asks for its own connection instead.
 */
export function postHogCodeRowServesInbox(row: PostHogIntegrationRow | null): boolean {
  if (!row || !row.enabled || !row.config.projectId) return false;
  if (readAuthMethod(row.config) === 'oauth') {
    const oauth = row.config.oauth;
    return Boolean(
      oauth && isEncryptedEnvelope(oauth.accessTokenEnc) && !oauth.reauthRequiredAt && scopeGrantsInbox(oauth.scope)
    );
  }
  return readApiKey(row.config) !== null;
}

/** The row the Inbox uses: its own, else a PostHog Code row that can serve it. */
async function resolveInboxRow(
  workspaceId: string
): Promise<{ source: PostHogInboxConnectionSource; row: PostHogIntegrationRow } | null> {
  const own = await readInboxRow(workspaceId);
  if (own) return { source: 'posthog_inbox', row: own };
  const code = await readPostHogIntegration(workspaceId);
  if (postHogCodeRowServesInbox(code)) return { source: 'posthog_code', row: code as PostHogIntegrationRow };
  return null;
}

export interface StoredInboxAccess {
  access: PostHogInboxAccess;
  reason: string | null;
  authMethod: 'oauth' | 'personal_api_key' | null;
  projectId: string | null;
  host: string | null;
  integrationId: string | null;
  /** Which row the Inbox uses, or null. */
  connection: PostHogInboxConnectionSource | null;
  /** OAuth only: the required Inbox scopes the grant lacks. */
  missingScopes: string[];
  /** The connection can read the Inbox, even when it cannot claim (`access` is then `reconnect`). */
  canRead?: boolean;
}

const NOT_CONNECTED_REASON = 'Connect PostHog on the PostHog Inbox page first.';

/**
 * What the stored connection says about Inbox access, before any request.
 * A personal API key cannot be read for its scopes, so it is `unknown` until
 * the poller has used it.
 */
export async function storedInboxAccess(workspaceId: string): Promise<StoredInboxAccess> {
  const resolved = await resolveInboxRow(workspaceId);
  const none: StoredInboxAccess = {
    access: 'not_connected',
    reason: NOT_CONNECTED_REASON,
    authMethod: null,
    projectId: null,
    host: null,
    integrationId: null,
    connection: null,
    missingScopes: [],
  };
  if (!resolved) return none;
  const { source, row } = resolved;
  if (!row.enabled || !row.config.projectId) {
    return { ...none, integrationId: row.id, connection: source };
  }
  const authMethod = readAuthMethod(row.config);
  let host: string;
  try {
    host = normalizeHost(row.config.host);
  } catch (err) {
    if (!(err instanceof PostHogHostNotAllowedError)) throw err;
    return {
      ...none,
      access: 'reconnect',
      reason: `Talyn no longer allows the PostHog host ${err.host}. Connect PostHog again.`,
      authMethod,
      projectId: row.config.projectId,
      host: err.host,
      integrationId: row.id,
      connection: source,
    };
  }
  const base = {
    authMethod,
    projectId: row.config.projectId,
    host,
    integrationId: row.id,
    connection: source,
    missingScopes: [] as string[],
  };
  if (authMethod === 'oauth') {
    const oauth = row.config.oauth;
    if (!oauth || !isEncryptedEnvelope(oauth.accessTokenEnc)) {
      return { ...base, access: 'not_connected', reason: NOT_CONNECTED_REASON };
    }
    const missingScopes = missingInboxScopes(oauth.scope);
    if (oauth.reauthRequiredAt) {
      return { ...base, missingScopes, access: 'reconnect', reason: 'PostHog ended the connection. Connect PostHog again.' };
    }
    if (!scopeGrantsInbox(oauth.scope)) {
      return {
        ...base,
        missingScopes,
        access: 'reconnect',
        reason: 'The PostHog connection cannot read the Inbox. Connect PostHog again to grant the Inbox permissions.',
      };
    }
    if (!scopeGrantsInboxClaims(oauth.scope)) {
      return { ...base, missingScopes, access: 'reconnect', reason: CLAIM_SCOPES_MISSING_REASON, canRead: true };
    }
    return { ...base, missingScopes, access: 'ok', reason: null, canRead: true };
  }
  if (readApiKey(row.config) === null) {
    return { ...base, access: 'not_connected', reason: NOT_CONNECTED_REASON };
  }
  return { ...base, access: 'unknown', reason: null };
}

/**
 * The connection to use, or null when the workspace has no usable one (none,
 * disabled, a grant without `inbox:read`, or one PostHog revoked).
 *
 * `claim` (the default, for the poller, the webhook and the session start)
 * also needs a grant that can claim reports (`inbox:write` and `task:write`):
 * the rules never start a session without a claim. `read` (the dry run) does
 * not. A personal API key is tried either way: PostHog's 403 says whether it
 * can.
 */
export async function getPostHogInboxConnection(
  workspaceId: string,
  purpose: 'claim' | 'read' = 'claim'
): Promise<PostHogInboxConnection | null> {
  const stored = await storedInboxAccess(workspaceId);
  const usable =
    stored.access === 'ok' || stored.access === 'unknown' || (purpose === 'read' && stored.canRead === true);
  if (!usable) return null;
  if (!stored.integrationId) return null;
  const creds =
    stored.connection === 'posthog_inbox'
      ? inboxRowCredentials(workspaceId, await readInboxRow(workspaceId))
      : await getPostHogCodeCredentials(workspaceId);
  if (!creds || creds.reauthRequired) return null;
  return {
    id: stored.integrationId,
    workspaceId,
    projectId: creds.projectId,
    host: creds.host,
    authMethod: creds.authMethod,
    client: new PostHogInboxClient(creds.getToken, creds.projectId, creds.host),
  };
}

import type { PostHogInboxAccess } from '@talyn/shared';
import { POSTHOG_INBOX_CLAIM_SCOPES, POSTHOG_INBOX_SCOPES } from '@talyn/shared';
import { isEncryptedEnvelope } from '../tokenCrypto.js';
import { getPostHogCodeCredentials } from '../posthogCode/credentials.js';
import { normalizeHost, readAuthMethod, readPostHogIntegration } from '../posthogCode/integrationRow.js';
import { PostHogInboxClient } from './api.js';
import type { PostHogInboxConnectionRef } from './facts.js';

/**
 * The workspace's PostHog connection, as PostHog Inbox rules use it.
 *
 * It is the same `integrations` row (type `posthog`) that PostHog Code uses,
 * with either auth method. An OAuth grant made before Inbox rules has only
 * `task:*`: it keeps working for PostHog Code, and the Inbox reads say
 * `reconnect` until the user connects again (the new grant asks for
 * `inbox:read inbox:write` too).
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

/**
 * What the stored connection says about Inbox access, before any request.
 * A personal API key cannot be read for its scopes, so it is `unknown` until
 * the poller has used it.
 */
export async function storedInboxAccess(
  workspaceId: string
): Promise<{
  access: PostHogInboxAccess;
  reason: string | null;
  authMethod: 'oauth' | 'personal_api_key' | null;
  projectId: string | null;
  host: string | null;
  integrationId: string | null;
  /** The connection can read the Inbox, even when it cannot claim (`access` is then `reconnect`). */
  canRead?: boolean;
}> {
  const row = await readPostHogIntegration(workspaceId);
  if (!row || !row.enabled || !row.config.projectId) {
    return { access: 'not_connected', reason: 'Connect PostHog on the PostHog Code page first.', authMethod: null, projectId: null, host: null, integrationId: row?.id ?? null };
  }
  const authMethod = readAuthMethod(row.config);
  const base = { authMethod, projectId: row.config.projectId, host: normalizeHost(row.config.host), integrationId: row.id };
  if (authMethod === 'oauth') {
    const oauth = row.config.oauth;
    if (!oauth || !isEncryptedEnvelope(oauth.accessTokenEnc)) {
      return { ...base, access: 'not_connected', reason: 'Connect PostHog on the PostHog Code page first.' };
    }
    if (oauth.reauthRequiredAt) {
      return { ...base, access: 'reconnect', reason: 'PostHog ended the connection. Connect PostHog again.' };
    }
    if (!scopeGrantsInbox(oauth.scope)) {
      return {
        ...base,
        access: 'reconnect',
        reason: 'The PostHog connection was made before Inbox automations and cannot read the Inbox. Connect PostHog again to grant it.',
      };
    }
    if (!scopeGrantsInboxClaims(oauth.scope)) {
      return { ...base, access: 'reconnect', reason: CLAIM_SCOPES_MISSING_REASON, canRead: true };
    }
    return { ...base, access: 'ok', reason: null, canRead: true };
  }
  return { ...base, access: 'unknown', reason: null };
}

/**
 * The connection to use, or null when the workspace has no usable one (none,
 * disabled, a grant without `inbox:read`, or one PostHog revoked).
 *
 * `claim` (the default, for the poller and the session start) also needs a
 * grant that can claim reports (`inbox:write` and `task:write`): the rules
 * never start a session without a claim. `read` (the dry run) does not.
 * A personal API key is tried either way: PostHog's 403 says whether it can.
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
  const creds = await getPostHogCodeCredentials(workspaceId);
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

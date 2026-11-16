import type { PostHogInboxAccess } from '@talyn/shared';
import { POSTHOG_INBOX_SCOPES } from '@talyn/shared';
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

/** Whether a stored OAuth scope string grants the Inbox read. */
export function scopeGrantsInbox(scope: string | null | undefined): boolean {
  const granted = new Set((scope ?? '').split(/\s+/).filter(Boolean));
  return granted.has(POSTHOG_INBOX_SCOPES[0]);
}

/**
 * What the stored connection says about Inbox access, before any request.
 * A personal API key cannot be read for its scopes, so it is `unknown` until
 * the poller has used it.
 */
export async function storedInboxAccess(
  workspaceId: string
): Promise<{ access: PostHogInboxAccess; reason: string | null; authMethod: 'oauth' | 'personal_api_key' | null; projectId: string | null; host: string | null; integrationId: string | null }> {
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
    return { ...base, access: 'ok', reason: null };
  }
  return { ...base, access: 'unknown', reason: null };
}

/**
 * The connection to read the Inbox with, or null when the workspace has no
 * usable one (none, disabled, a grant without `inbox:read`, or one PostHog
 * revoked). A personal API key is tried: PostHog's 403 says whether it can.
 */
export async function getPostHogInboxConnection(workspaceId: string): Promise<PostHogInboxConnection | null> {
  const stored = await storedInboxAccess(workspaceId);
  if (stored.access !== 'ok' && stored.access !== 'unknown') return null;
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

import { encryptString } from '../tokenCrypto.js';
import { credentialsFromRow, type PostHogCodeCredentials } from '../posthogCode/credentials.js';
import {
  deletePostHogRow,
  normalizeHost,
  POSTHOG_INBOX_INTEGRATION_TYPE,
  readPostHogRow,
  upsertPostHogRow,
  type PostHogIntegrationRow,
} from '../posthogCode/integrationRow.js';
import { ensureFreshInboxAccessToken } from './oauth.js';

/**
 * The PostHog Inbox's own connection: the `posthog_inbox` row. An OAuth grant
 * (`posthogInbox/oauth.ts`) or a personal API key, stored the same way as the
 * PostHog Code row but never mixed with it.
 */

export function readInboxRow(workspaceId: string): Promise<PostHogIntegrationRow | null> {
  return readPostHogRow(POSTHOG_INBOX_INTEGRATION_TYPE, workspaceId);
}

/** Credentials from the Inbox row, or null when there is no usable one. */
export function inboxRowCredentials(
  workspaceId: string,
  row: PostHogIntegrationRow | null
): PostHogCodeCredentials | null {
  return credentialsFromRow(row, (opts) => ensureFreshInboxAccessToken(workspaceId, { force: opts?.forceRefresh }));
}

/**
 * Store a personal API key on the Inbox row (encrypted). It replaces an OAuth
 * grant there: the two are alternatives, and a leftover refresh token would be
 * a live credential nobody believes is there.
 */
export async function storeInboxApiKey(
  workspaceId: string,
  input: { apiKey: string; projectId: string; host?: string }
): Promise<void> {
  const host = normalizeHost(input.host);
  await upsertPostHogRow(POSTHOG_INBOX_INTEGRATION_TYPE, workspaceId, () => ({
    apiKeyEnc: encryptString(input.apiKey),
    projectId: input.projectId,
    host,
    authMethod: 'personal_api_key',
  }));
}

/** Remove the Inbox's own connection. The PostHog Code row is not touched. */
export async function removeInboxConnection(workspaceId: string): Promise<void> {
  await deletePostHogRow(POSTHOG_INBOX_INTEGRATION_TYPE, workspaceId);
}

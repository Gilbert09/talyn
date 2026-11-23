import { POSTHOG_INBOX_OAUTH_SCOPES } from '@talyn/shared';
import {
  assertStateKind,
  ensureFreshPostHogToken,
  exchangeAuthorizationCode,
  markPostHogReauthRequired,
  startPostHogAuthorization,
  type PendingState,
  type StartAuthorizationInput,
} from '../posthogOAuth/core.js';
import { POSTHOG_INBOX_INTEGRATION_TYPE, upsertPostHogRow } from '../posthogCode/integrationRow.js';

/**
 * The PostHog Inbox's own OAuth connection. Same client identity, callback URL
 * and state table as PostHog Code (`services/posthogOAuth/core.ts`); the state
 * row's `kind` is `posthog_inbox`, and the grant is stored on the
 * `posthog_inbox` row. It never touches the PostHog Code row.
 *
 * Scopes (checked against PostHog's OpenAPI): `inbox:read` lists and reads
 * reports and their artefacts, `inbox:write` claims a report, and `task:write`
 * attaches a pull request to the claim. `openid` makes it an OIDC grant. The
 * project comes from the consent screen's project picker
 * (`required_access_level=project`) and self-introspection, which needs no scope.
 */

export async function startInboxAuthorization(
  input: Omit<StartAuthorizationInput, 'mobileReturn'>
): Promise<{ authorizeUrl: string; state: string }> {
  return startPostHogAuthorization({ ...input, kind: 'posthog_inbox', scopes: POSTHOG_INBOX_OAUTH_SCOPES });
}

/**
 * Exchange the code and store the grant on the Inbox row. Refuses a state that
 * the PostHog Code flow minted. A personal API key on the row is dropped: the
 * two are alternatives.
 */
export async function completeInboxAuthorization(input: {
  code: string;
  state: PendingState;
}): Promise<{ workspaceId: string; userId: string; projectId: string; host: string; scope: string | null }> {
  assertStateKind(input.state, 'posthog_inbox');
  const { workspaceId, userId } = input.state;
  const { projectId, host, oauth } = await exchangeAuthorizationCode(input);
  await upsertPostHogRow(POSTHOG_INBOX_INTEGRATION_TYPE, workspaceId, () => ({
    projectId,
    host,
    authMethod: 'oauth',
    oauth,
  }));
  return { workspaceId, userId, projectId, host, scope: oauth.scope ?? null };
}

/** A usable access token for the Inbox row, refreshed single-flight. */
export function ensureFreshInboxAccessToken(workspaceId: string, opts: { force?: boolean } = {}): Promise<string> {
  return ensureFreshPostHogToken(POSTHOG_INBOX_INTEGRATION_TYPE, workspaceId, opts);
}

/** Flag the Inbox connection as needing re-consent. */
export function markInboxReauthRequired(workspaceId: string, reason: string): Promise<void> {
  return markPostHogReauthRequired(POSTHOG_INBOX_INTEGRATION_TYPE, workspaceId, reason);
}

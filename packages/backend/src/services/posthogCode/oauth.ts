import { POSTHOG_INBOX_SCOPES } from '@talyn/shared';
import {
  assertStateKind,
  consumePostHogState,
  createPkcePair,
  ensureFreshPostHogToken,
  exchangeAuthorizationCode,
  markPostHogReauthRequired,
  PostHogOAuthError,
  PostHogReauthRequiredError,
  resetPostHogOAuthInflightForTests,
  startPostHogAuthorization,
  type PendingState,
  type StartAuthorizationInput,
} from '../posthogOAuth/core.js';
import { POSTHOG_INTEGRATION_TYPE, upsertPostHogIntegration } from './integrationRow.js';

/**
 * The PostHog Code OAuth connect flow and its token lifecycle. The PKCE, state,
 * token endpoint and refresh code is shared with the PostHog Inbox connection
 * in `services/posthogOAuth/core.ts`; this module only knows the PostHog Code
 * scopes and the `posthog` row.
 *
 * PostHog's tasks API accepts `pha_` bearer tokens with the same scope + team
 * enforcement as a personal API key (posthog/permissions.py). What OAuth buys
 * over a pasted key: the user never handles a credential, the grant is scoped
 * to ONE project, and it is revocable from PostHog's own settings.
 */

/** Scopes PostHog Code asks for. `task:*` is everything the cloud-task API
 *  needs; `openid` makes it a proper OIDC grant.
 *
 *  `inbox:*` is still asked for: a PostHog Code grant with it also serves
 *  PostHog Inbox rules until the workspace connects the Inbox on its own
 *  (`services/posthogInbox/connection.ts`). */
const SCOPES = ['openid', 'task:read', 'task:write', ...POSTHOG_INBOX_SCOPES] as const;

export { createPkcePair, PostHogOAuthError, PostHogReauthRequiredError };
export type { PendingState, StartAuthorizationInput };

export async function startAuthorization(
  input: StartAuthorizationInput
): Promise<{ authorizeUrl: string; state: string }> {
  return startPostHogAuthorization({ ...input, kind: 'posthog_code', scopes: SCOPES });
}

/** Consume a pending state of either kind. The callback routes it by `kind`. */
export const consumeState = consumePostHogState;

/**
 * Exchange an authorization code, discover which project the user granted, and
 * store the result as the workspace's PostHog Code credentials. Refuses a
 * state that the PostHog Inbox flow minted.
 */
export async function completeAuthorization(input: {
  code: string;
  state: PendingState;
}): Promise<{ workspaceId: string; userId: string; projectId: string; host: string }> {
  assertStateKind(input.state, 'posthog_code');
  const { workspaceId, userId } = input.state;
  const { projectId, host, oauth } = await exchangeAuthorizationCode(input);

  // The mutator returns the WHOLE next config, so this deliberately drops any
  // `apiKeyEnc` the row was carrying: the user just connected via OAuth, and
  // leaving a personal API key behind means a revoked grant could silently fall
  // back to a credential they believe they replaced.
  await upsertPostHogIntegration(workspaceId, () => ({
    projectId,
    host,
    authMethod: 'oauth',
    oauth,
  }));

  return { workspaceId, userId, projectId, host };
}

/** A usable PostHog Code access token. See `ensureFreshPostHogToken`. */
export function ensureFreshAccessToken(
  workspaceId: string,
  opts: { force?: boolean } = {}
): Promise<string> {
  return ensureFreshPostHogToken(POSTHOG_INTEGRATION_TYPE, workspaceId, opts);
}

/** Flag the PostHog Code connection as needing re-consent. */
export function markReauthRequired(workspaceId: string, reason: string): Promise<void> {
  return markPostHogReauthRequired(POSTHOG_INTEGRATION_TYPE, workspaceId, reason);
}

/** Tests: clear the in-flight single-flight map between cases. */
export function resetOAuthInflightForTests(): void {
  resetPostHogOAuthInflightForTests();
}

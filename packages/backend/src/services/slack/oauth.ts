import { createHash, randomBytes } from 'node:crypto';
import { eq, lt } from 'drizzle-orm';
import { getPoolDbClient } from '../../db/client.js';
import { slackInstallations, slackOauthStates } from '../../db/schema.js';
import { decryptString, encryptString, isEncryptedEnvelope } from '../tokenCrypto.js';
import { callSlack } from './api.js';
import { requireSlackAppConfig, SLACK_BOT_SCOPES, SLACK_LINK_SCOPES } from './config.js';
import { installationExists, linkSlackIdentity } from './store.js';

/**
 * The two Slack OAuth flows, which share one callback URL:
 *
 *  - `install`: `oauth/v2/authorize` with the bot scopes. Stores the team's
 *    rotating bot token and links the installing user (`authed_user.id`).
 *  - `link`: "Sign in with Slack" (OpenID Connect). Proves which Slack user
 *    the caller is and links that identity.
 *
 * The state row says which flow a callback belongs to, so the flow is never
 * taken from the request. Both send PKCE, because the app has it on.
 */

export type SlackFlow = 'install' | 'link';

const STATE_TTL_MS = 10 * 60_000;
const SLACK_INSTALL_AUTHORIZE = 'https://slack.com/oauth/v2/authorize';
const SLACK_OIDC_AUTHORIZE = 'https://slack.com/openid/connect/authorize';

/** A refusal whose message is safe and useful to show the person. */
export class SlackOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackOAuthError';
  }
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

export async function startSlackAuthorization(input: {
  flow: SlackFlow;
  userId: string;
  workspaceId: string | null;
  client: 'web' | 'desktop';
}): Promise<{ authorizeUrl: string; state: string }> {
  const config = requireSlackAppConfig();
  const state = base64Url(randomBytes(32));
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  const now = Date.now();

  const db = getPoolDbClient();
  // Opportunistic sweep: these rows are worthless past their TTL.
  await db.delete(slackOauthStates).where(lt(slackOauthStates.expiresAt, new Date(now)));
  await db.insert(slackOauthStates).values({
    stateHash: hashState(state),
    flow: input.flow,
    userId: input.userId,
    workspaceId: input.workspaceId,
    codeVerifierEnc: encryptString(verifier),
    client: input.client,
    expiresAt: new Date(now + STATE_TTL_MS),
  });

  const url = new URL(input.flow === 'install' ? SLACK_INSTALL_AUTHORIZE : SLACK_OIDC_AUTHORIZE);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (input.flow === 'install') {
    url.searchParams.set('scope', SLACK_BOT_SCOPES.join(','));
  } else {
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SLACK_LINK_SCOPES.join(' '));
    url.searchParams.set('nonce', base64Url(randomBytes(16)));
  }
  return { authorizeUrl: url.toString(), state };
}

export interface PendingSlackState {
  flow: SlackFlow;
  userId: string;
  workspaceId: string | null;
  verifier: string;
  client: 'web' | 'desktop';
}

/**
 * Take a pending state. Single use: the DELETE ... RETURNING is the lookup, so
 * a replayed or concurrent callback finds nothing. Expired, undecryptable or
 * unknown-flow rows answer null.
 */
export async function consumeSlackState(state: string): Promise<PendingSlackState | null> {
  if (!state) return null;
  const rows = await getPoolDbClient()
    .delete(slackOauthStates)
    .where(eq(slackOauthStates.stateHash, hashState(state)))
    .returning({
      flow: slackOauthStates.flow,
      userId: slackOauthStates.userId,
      workspaceId: slackOauthStates.workspaceId,
      codeVerifierEnc: slackOauthStates.codeVerifierEnc,
      client: slackOauthStates.client,
      expiresAt: slackOauthStates.expiresAt,
    });
  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  if (row.flow !== 'install' && row.flow !== 'link') return null;
  if (!isEncryptedEnvelope(row.codeVerifierEnc)) return null;
  let verifier: string;
  try {
    verifier = decryptString(row.codeVerifierEnc);
  } catch {
    return null;
  }
  return {
    flow: row.flow,
    userId: row.userId,
    workspaceId: row.workspaceId,
    verifier,
    client: row.client === 'web' ? 'web' : 'desktop',
  };
}

interface InstallResponse extends Record<string, unknown> {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  scope?: unknown;
  bot_user_id?: unknown;
  app_id?: unknown;
  team?: { id?: unknown; name?: unknown } | null;
  authed_user?: { id?: unknown } | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** Finish an install: store the team's bot token and link the installer. */
export async function completeSlackInstall(input: {
  code: string;
  pending: PendingSlackState;
}): Promise<{ teamId: string; teamName: string | null }> {
  const config = requireSlackAppConfig();
  const doc = await callSlack<InstallResponse>('oauth.v2.access', {
    form: {
      code: input.code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code_verifier: input.pending.verifier,
    },
  });

  const teamId = str(doc.team?.id);
  if (!teamId) {
    throw new SlackOAuthError('Org-wide (Enterprise Grid) installs are not supported. Install Talyn in one workspace.');
  }
  const accessToken = str(doc.access_token);
  const botUserId = str(doc.bot_user_id);
  const appId = str(doc.app_id);
  if (!accessToken || !botUserId || !appId || doc.token_type !== 'bot') {
    throw new SlackOAuthError('Slack did not return a bot token. Try the install again.');
  }
  const refreshToken = str(doc.refresh_token);
  const expiresIn = typeof doc.expires_in === 'number' ? doc.expires_in : null;

  // The bot's handle and the workspace URL, for the settings page. Best effort:
  // the install is complete without them.
  let botName: string | null = null;
  let teamUrl: string | null = null;
  try {
    const me = await callSlack<{ user?: unknown; url?: unknown }>('auth.test', { token: accessToken });
    botName = str(me.user);
    teamUrl = str(me.url);
  } catch (err) {
    console.warn(`[slack] auth.test after install failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const now = new Date();
  const values = {
    teamName: str(doc.team?.name),
    teamUrl,
    appId,
    botUserId,
    botName,
    scope: str(doc.scope),
    accessTokenEnc: encryptString(accessToken),
    refreshTokenEnc: refreshToken ? encryptString(refreshToken) : null,
    expiresAt: expiresIn !== null ? new Date(now.getTime() + expiresIn * 1000) : null,
    tokenError: null,
    tokenErrorAt: null,
    refreshLeaseUntil: null,
    installedByUserId: input.pending.userId,
    updatedAt: now,
  };
  await getPoolDbClient()
    .insert(slackInstallations)
    .values({ teamId, ...values, createdAt: now })
    .onConflictDoUpdate({ target: slackInstallations.teamId, set: values });

  // The installer's own Slack id comes from the same TLS response, so it is
  // verified the same way a sign-in would be.
  const installerSlackId = str(doc.authed_user?.id);
  if (installerSlackId) {
    await linkSlackIdentity({
      teamId,
      slackUserId: installerSlackId,
      userId: input.pending.userId,
      workspaceId: input.pending.workspaceId,
    });
  }
  return { teamId, teamName: values.teamName };
}

const CLAIM_USER = 'https://slack.com/user_id';
const CLAIM_TEAM = 'https://slack.com/team_id';

/**
 * Finish a "Sign in with Slack": link the Slack identity Slack vouches for.
 *
 * The identity comes from `openid.connect.userInfo`, called with the access
 * token that `openid.connect.token` just returned to us over TLS for a code
 * bound to our client secret and PKCE verifier. That needs no JWT signature
 * code, and Slack answers the claims itself. The id_token is not parsed.
 */
export async function completeSlackLink(input: {
  code: string;
  pending: PendingSlackState;
}): Promise<{ teamId: string; slackUserId: string }> {
  const config = requireSlackAppConfig();
  const tokenDoc = await callSlack<{ access_token?: unknown }>('openid.connect.token', {
    form: {
      code: input.code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code_verifier: input.pending.verifier,
    },
  });
  const accessToken = str(tokenDoc.access_token);
  if (!accessToken) throw new SlackOAuthError('Slack did not complete the sign-in. Try again.');

  const info = await callSlack<Record<string, unknown>>('openid.connect.userInfo', { token: accessToken });
  const slackUserId = str(info[CLAIM_USER]);
  const teamId = str(info[CLAIM_TEAM]);
  if (!slackUserId || !teamId) {
    throw new SlackOAuthError('Slack did not say which account signed in. Try again.');
  }
  if (!(await installationExists(teamId))) {
    throw new SlackOAuthError(
      'Talyn is not installed in that Slack workspace. Ask someone there to install it from Talyn first, then link your account.'
    );
  }
  await linkSlackIdentity({
    teamId,
    slackUserId,
    userId: input.pending.userId,
    workspaceId: input.pending.workspaceId,
  });
  return { teamId, slackUserId };
}

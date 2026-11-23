import { createHash, randomBytes } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { getPoolDbClient } from '../../db/client.js';
import { inboundOauthStates } from '../../db/schema.js';
import { decryptString, encryptString, isEncryptedEnvelope } from '../tokenCrypto.js';
import { linearGraphql } from './api.js';
import { LINEAR_AUTHORIZE_URL, LINEAR_SCOPES, requireLinearAppConfig } from './config.js';
import { postLinearToken, scopesFrom, tokensFrom, upsertLinearConnection } from './store.js';

/**
 * Connecting Linear: Talyn's OAuth app, installed as an app user
 * (`actor=app`), with PKCE.
 *
 * The same shape as the Slack flow: a single-use state row (10-minute TTL,
 * the PKCE verifier encrypted) records who started the flow, for which
 * workspace, from which client, and where a mobile flow returns. The callback
 * consumes it, exchanges the code, and reads the organization and Talyn's own
 * app user (`viewer`), which the webhook's self-echo check needs.
 */

const KIND = 'linear';
const STATE_TTL_MS = 10 * 60_000;

/** A refusal whose message is safe and useful to show the person. */
export class LinearOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinearOAuthError';
  }
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function hashLinearState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

export async function startLinearAuthorization(input: {
  userId: string;
  workspaceId: string;
  client: 'web' | 'desktop';
  mobileReturn?: string | null;
}): Promise<{ authorizeUrl: string; state: string }> {
  const config = requireLinearAppConfig();
  const state = base64Url(randomBytes(32));
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  const now = Date.now();

  const db = getPoolDbClient();
  // Opportunistic sweep: these rows are worthless past their TTL.
  await db.delete(inboundOauthStates).where(lt(inboundOauthStates.expiresAt, new Date(now)));
  await db.insert(inboundOauthStates).values({
    stateHash: hashLinearState(state),
    kind: KIND,
    userId: input.userId,
    workspaceId: input.workspaceId,
    codeVerifierEnc: encryptString(verifier),
    client: input.client,
    mobileReturn: input.mobileReturn ?? null,
    expiresAt: new Date(now + STATE_TTL_MS),
  });

  const url = new URL(LINEAR_AUTHORIZE_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', LINEAR_SCOPES.join(','));
  url.searchParams.set('state', state);
  url.searchParams.set('actor', 'app');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Always show the consent screen, so a reconnect can pick another organization.
  url.searchParams.set('prompt', 'consent');
  return { authorizeUrl: url.toString(), state };
}

export interface PendingLinearState {
  userId: string;
  workspaceId: string;
  verifier: string;
  client: 'web' | 'desktop';
  /** As stored. The callback validates it again before it redirects there. */
  mobileReturn: string | null;
}

/** Take a pending state. Single use: DELETE ... RETURNING is the lookup. */
export async function consumeLinearState(state: string): Promise<PendingLinearState | null> {
  if (!state) return null;
  const rows = await getPoolDbClient()
    .delete(inboundOauthStates)
    .where(and(eq(inboundOauthStates.stateHash, hashLinearState(state)), eq(inboundOauthStates.kind, KIND)))
    .returning({
      userId: inboundOauthStates.userId,
      workspaceId: inboundOauthStates.workspaceId,
      codeVerifierEnc: inboundOauthStates.codeVerifierEnc,
      client: inboundOauthStates.client,
      mobileReturn: inboundOauthStates.mobileReturn,
      expiresAt: inboundOauthStates.expiresAt,
    });
  const row = rows[0];
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  if (!isEncryptedEnvelope(row.codeVerifierEnc)) return null;
  let verifier: string;
  try {
    verifier = decryptString(row.codeVerifierEnc);
  } catch {
    return null;
  }
  return {
    userId: row.userId,
    workspaceId: row.workspaceId,
    verifier,
    client: row.client === 'web' ? 'web' : 'desktop',
    mobileReturn: row.mobileReturn,
  };
}

interface IdentityDoc {
  viewer?: { id?: unknown } | null;
  organization?: { id?: unknown; name?: unknown; urlKey?: unknown } | null;
}

const IDENTITY_QUERY = 'query TalynIdentity { viewer { id } organization { id name urlKey } }';

/** Finish a connect: exchange the code, read who we are, store the grant. */
export async function completeLinearConnect(input: {
  code: string;
  pending: PendingLinearState;
  now?: number;
}): Promise<{ connectionId: string; organizationName: string | null }> {
  const config = requireLinearAppConfig();
  const now = input.now ?? Date.now();
  const doc = await postLinearToken({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: input.pending.verifier,
  });
  const tokens = tokensFrom(doc, now);
  const identity = await linearGraphql<IdentityDoc>(tokens.accessToken, IDENTITY_QUERY);
  const organizationId = typeof identity.organization?.id === 'string' ? identity.organization.id : '';
  const appUserId = typeof identity.viewer?.id === 'string' ? identity.viewer.id : '';
  if (!organizationId || !appUserId) {
    throw new LinearOAuthError('Linear did not say which workspace was connected. Try again.');
  }
  const organizationName = typeof identity.organization?.name === 'string' ? identity.organization.name : null;
  const connectionId = await upsertLinearConnection({
    workspaceId: input.pending.workspaceId,
    organizationId,
    tokens,
    meta: {
      appUserId,
      scopes: scopesFrom(doc) ?? [...LINEAR_SCOPES],
      organizationName,
      urlKey: typeof identity.organization?.urlKey === 'string' ? identity.organization.urlKey : null,
    },
    createdBy: input.pending.userId,
  });
  return { connectionId, organizationName };
}

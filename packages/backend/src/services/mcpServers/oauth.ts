import { mcpFetch, readMcpBody } from './http.js';
import { createHash, randomBytes } from 'node:crypto';
import type { McpOAuthGrant, McpServerDefinition } from '@talyn/shared';
import { encryptString, decryptString, type EncryptedEnvelope } from '../tokenCrypto.js';
import { withBlockingAdvisoryLock } from '../advisoryLock.js';
import { getDbClient } from '../../db/client.js';
import { webAppUrl } from '../webApp.js';
import { discover, discoverAuthServer, McpDiscoveryError, type AuthServerMetadata } from './discovery.js';

/**
 * Signing in to an MCP server on a workspace's behalf.
 *
 * # Why Talyn can be the client at all
 *
 * The MCP authorization spec is built for exactly this: a client discovers the
 * authorization server from the resource, identifies itself, runs an ordinary
 * authorization-code flow with PKCE, and binds the token to one resource with
 * RFC 8707. Nothing in it assumes the client runs on the user's machine.
 *
 * # Client identity: CIMD first, DCR second
 *
 * **CIMD** (OAuth Client ID Metadata Documents) makes the `client_id` an HTTPS
 * URL pointing at a document describing the client. One hosted document covers
 * every authorization server that supports it, with nothing registered anywhere
 * and nothing to keep in sync.
 *
 * **DCR** (RFC 7591) is what most servers in the wild still speak, and it is
 * what we fall back to — but it is deprecated as of the 2026-07-28 revision
 * with a twelve-month offramp, so leading with it would be building on the leg
 * that is going away. It also leaves an orphan client registration at the
 * vendor every time somebody presses connect, which is why a re-connect reuses
 * the stored one rather than registering again.
 *
 * # What is stored, and what never is
 *
 * The access token, the refresh token and any client secret are AES-256-GCM
 * envelopes. `clientId` is stored in the clear because it travels in an
 * authorize URL a browser visits and is therefore already public. Nothing here
 * is ever returned to a client: `McpOAuthGrant` is a status, not a credential.
 */

/** A flow is one browser trip. Ten minutes is the spec's own suggestion. */
const FLOW_TTL_MS = 10 * 60 * 1000;

/** Refresh this far before expiry, so an in-flight dispatch is not racing it. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const EXCHANGE_TIMEOUT_MS = 15_000;

/**
 * Where the browser comes back to.
 *
 * A hosted HTTPS callback rather than a loopback one, which the spec allows and
 * prefers for a client that is not native — and which sidesteps the
 * localhost-impersonation weakness it warns about, since no other process on
 * the user's machine can answer for talyn.dev.
 */
export function mcpRedirectUri(): string {
  const url = webAppUrl('/mcp/callback');
  if (!url) {
    // Refused rather than defaulted. A redirect URI is what the whole flow is
    // anchored on, and an authorization server told an empty one either refuses
    // outright or — much worse — accepts and sends the code somewhere else.
    throw new McpOAuthUnavailableError(
      'this deployment has no web address configured (WEB_APP_URL), so it cannot host the ' +
        'sign-in callback. Paste an API key instead.'
    );
  }
  return url;
}

/**
 * The CIMD document's URL, which IS this client's identity.
 *
 * Served publicly and statically. An authorization server fetches it to learn
 * the client's name and redirect URIs, so it must be reachable without
 * authentication and must not move — a changed URL is a different client.
 */
export function mcpClientMetadataUrl(): string {
  const url = webAppUrl('/.well-known/oauth-client/talyn.json');
  if (!url) {
    throw new McpOAuthUnavailableError(
      'this deployment has no web address configured (WEB_APP_URL), so it cannot host its ' +
        'client identity document.'
    );
  }
  if (new URL(url).protocol !== 'https:' || new URL(url).hostname === 'localhost') {
    throw new McpOAuthUnavailableError(
      'This server needs a public HTTPS client identity document. ' +
        'Configure WEB_APP_URL with a public HTTPS address, or use a server that supports dynamic registration.'
    );
  }
  return url;
}

/** The stored shape. Never returned to a client — see `grantStatus`. */
export interface StoredMcpOAuth {
  status: 'pending' | 'connected' | 'needs_reauth';
  detail?: string;
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  registrationEndpoint?: string;
  clientId?: string;
  clientSecretEnc?: EncryptedEnvelope;
  clientSource?: 'cimd' | 'dcr' | 'byo';
  scopes?: string[];
  /** The RFC 8707 resource this grant is bound to. */
  resource?: string;
  accessTokenEnc?: EncryptedEnvelope;
  refreshTokenEnc?: EncryptedEnvelope;
  expiresAt?: string;
  checkedAt?: string;
  lastCompletedFlowId?: string;
  /** The one-shot authorize leg in flight, if any. */
  flow?: {
    id: string;
    /** Hashed, never stored raw: the flow row is not a place a code verifier
     *  should be readable from. */
    stateHash: string;
    verifier: string;
    expiresAt: string;
  };
}

/** What a client may see. Deliberately narrower than what is stored. */
export function grantStatus(stored: StoredMcpOAuth | null | undefined): McpOAuthGrant | null {
  if (!stored) return null;
  return {
    status: stored.status,
    ...(stored.detail ? { detail: stored.detail } : {}),
    ...(stored.issuer ? { issuer: stored.issuer } : {}),
    ...(stored.scopes ? { scopes: stored.scopes } : {}),
    ...(stored.clientId ? { clientId: stored.clientId } : {}),
    ...(stored.clientSource ? { clientSource: stored.clientSource } : {}),
    ...(stored.expiresAt ? { expiresAt: stored.expiresAt } : {}),
    ...(stored.checkedAt ? { checkedAt: stored.checkedAt } : {}),
  };
}

export class McpReauthRequiredError extends Error {}

/** This deployment cannot broker a sign-in at all — no web address to come
 *  back to. A configuration fact, not a vendor's refusal, so it reads
 *  differently to the user and is not retried. */
export class McpOAuthUnavailableError extends Error {}

/**
 * The server id a callback's state names.
 *
 * NOT trusted on its own — it only says which row to look at, and that row's
 * stored `stateHash` is what actually authorises the exchange. A forged id
 * finds a flow whose hash does not match, or no flow at all.
 */
export function serverIdFromState(state: string): string | null {
  const id = state.split('.')[0];
  return id && id.length > 0 ? id : null;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

/**
 * Register this client with an authorization server that wants DCR.
 *
 * Only reached when CIMD is unsupported. The response's `client_id` is what
 * every later leg uses; a `client_secret` is stored encrypted, though most MCP
 * servers register a public client and return none.
 */
async function registerClient(
  server: AuthServerMetadata,
  signal: AbortSignal
): Promise<{ clientId: string; clientSecret?: string }> {
  if (!server.registrationEndpoint) {
    throw new McpDiscoveryError(
      'this server does not offer automatic sign-in setup, and Talyn cannot register with it ' +
        'by hand yet — paste an API key instead if it has one'
    );
  }
  const resp = await mcpFetch(server.registrationEndpoint, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Talyn',
      client_uri: webAppUrl('/') ?? undefined,
      redirect_uris: [mcpRedirectUri()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      // Named so a native-client rule does not apply to a hosted redirect.
      application_type: 'web',
    }),
  });
  if (!resp.ok) {
    throw new McpDiscoveryError(`the server refused to set up sign-in (${resp.status})`);
  }
  const doc = (await resp.json()) as { client_id?: unknown; client_secret?: unknown };
  if (typeof doc.client_id !== 'string' || !doc.client_id) {
    throw new McpDiscoveryError('the server set up sign-in but did not say who we are');
  }
  return {
    clientId: doc.client_id,
    ...(typeof doc.client_secret === 'string' ? { clientSecret: doc.client_secret } : {}),
  };
}

export interface StartedFlow {
  stored: StoredMcpOAuth;
  authorizeUrl: string;
  flowId: string;
  expiresAt: string;
  scopes: string[];
}

/**
 * Begin the authorize leg, returning where to send a browser.
 *
 * Re-connecting a server that is already known SKIPS discovery and
 * registration: the endpoints do not move, the client is still a client the
 * authorization server knows, and registering again on every press would leave
 * an orphan at the vendor each time.
 *
 * A connected server STAYS connected while this is in flight. The token it
 * holds still works, and an abandoned consent tab must not report a healthy
 * server as disconnected.
 */
export async function startMcpOAuth(
  server: Pick<McpServerDefinition, 'id' | 'url'>,
  existing: StoredMcpOAuth | null,
  now: Date
): Promise<StartedFlow> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);
  try {
    const redirectUri = mcpRedirectUri();
    const localCallback = new URL(redirectUri).hostname === 'localhost';
    let meta: AuthServerMetadata;
    let resource = existing?.resource ?? server.url;
    let scopes = existing?.scopes ?? [];
    let clientId = existing?.clientId;
    let clientSecret: string | undefined;
    let clientSource = existing?.clientSource;

    if (existing?.authorizationEndpoint && existing.tokenEndpoint && clientId) {
      meta = {
        issuer: existing.issuer ?? '',
        authorizationEndpoint: existing.authorizationEndpoint,
        tokenEndpoint: existing.tokenEndpoint,
        ...(existing.registrationEndpoint
          ? { registrationEndpoint: existing.registrationEndpoint }
          : {}),
        clientIdMetadataDocumentSupported: existing.clientSource === 'cimd',
      };
    } else {
      const found = await discover(server.url);
      meta = found.server;
      resource = found.resource.resource ?? server.url;
      scopes = found.resource.scope ? found.resource.scope.split(/\s+/).filter(Boolean) : [];
      if (meta.clientIdMetadataDocumentSupported && !(localCallback && meta.registrationEndpoint)) {
        // The forward-compatible path: one hosted document, nothing registered.
        clientId = mcpClientMetadataUrl();
        clientSource = 'cimd';
      } else {
        const registered = await registerClient(meta, controller.signal);
        clientId = registered.clientId;
        clientSecret = registered.clientSecret;
        clientSource = 'dcr';
      }
    }

    const verifier = base64url(randomBytes(32));
    // The state carries the SERVER ID as well as its entropy, so the callback
    // page — which is handed nothing but `code` and `state` — knows which
    // server to finish. The id is not a secret (it is already in the URLs this
    // client uses) and the 32 random bytes beside it are what make the value
    // unguessable; the hash below covers the whole string, so neither half can
    // be swapped for another.
    const state = `${server.id}.${base64url(randomBytes(32))}`;
    const flowId = base64url(randomBytes(16));
    const expiresAt = new Date(now.getTime() + FLOW_TTL_MS).toISOString();

    const authorize = new URL(meta.authorizationEndpoint);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', clientId as string);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('code_challenge', base64url(sha256(verifier)));
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('state', state);
    // MUST be sent whether or not the server advertises support: it is what
    // binds the token to THIS endpoint, so a server that leaks one cannot have
    // it spent somewhere else.
    authorize.searchParams.set('resource', resource);
    if (scopes.length > 0) authorize.searchParams.set('scope', scopes.join(' '));

    return {
      stored: {
        ...(existing ?? {}),
        // Deliberately not 'pending' when already connected — the token in hand
        // still works and an abandoned tab must not disconnect a healthy server.
        status: existing?.status === 'connected' ? 'connected' : 'pending',
        issuer: meta.issuer,
        authorizationEndpoint: meta.authorizationEndpoint,
        tokenEndpoint: meta.tokenEndpoint,
        ...(meta.registrationEndpoint ? { registrationEndpoint: meta.registrationEndpoint } : {}),
        clientId,
        ...(clientSecret ? { clientSecretEnc: encryptString(clientSecret) } : {}),
        ...(clientSource ? { clientSource } : {}),
        scopes,
        resource,
        flow: { id: flowId, stateHash: base64url(sha256(state)), verifier, expiresAt },
      },
      authorizeUrl: authorize.toString(),
      flowId,
      expiresAt,
      scopes,
    };
  } finally {
    clearTimeout(timer);
  }
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

async function postToken(
  stored: StoredMcpOAuth,
  body: URLSearchParams,
  signal: AbortSignal
): Promise<TokenResponse> {
  if (!stored.tokenEndpoint) throw new McpDiscoveryError('no token endpoint is known');
  if (stored.clientSecretEnc) {
    body.set('client_secret', decryptString(stored.clientSecretEnc));
  }
  const resp = await mcpFetch(stored.tokenEndpoint, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  const doc = (await resp.json().catch(() => ({}))) as TokenResponse;
  if (!resp.ok || typeof doc.access_token !== 'string') {
    const reason =
      (typeof doc.error_description === 'string' && doc.error_description) ||
      (typeof doc.error === 'string' && doc.error) ||
      `the server answered ${resp.status}`;
    const err = new Error(reason);
    // `invalid_grant` is terminal: the refresh token is spent or revoked and no
    // retry can change that. Distinguished so the caller stops rather than
    // hammering a decision that will not move.
    if (doc.error === 'invalid_grant') throw new McpReauthRequiredError(reason);
    throw err;
  }
  return doc;
}

/** Fold a token response into the stored grant. */
function applyTokens(stored: StoredMcpOAuth, doc: TokenResponse, now: Date): StoredMcpOAuth {
  const expiresIn = typeof doc.expires_in === 'number' ? doc.expires_in : 3600;
  return {
    ...stored,
    status: 'connected',
    detail: undefined,
    accessTokenEnc: encryptString(doc.access_token as string),
    // ROTATION: store the new refresh token, and keep the old one only when the
    // server sent none. OAuth 2.1 requires rotation for a public client, so a
    // response whose new token we dropped would invalidate the whole grant on
    // the next refresh.
    ...(typeof doc.refresh_token === 'string'
      ? { refreshTokenEnc: encryptString(doc.refresh_token) }
      : {}),
    ...(typeof doc.scope === 'string'
      ? { scopes: doc.scope.split(/\s+/).filter(Boolean) }
      : {}),
    expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    checkedAt: now.toISOString(),
    ...(stored.flow ? { lastCompletedFlowId: stored.flow.id } : {}),
    flow: undefined,
  };
}

/**
 * Finish the authorize leg.
 *
 * The state is compared by HASH against the stored flow — a compare-and-clear,
 * so a replayed callback finds no flow rather than a second exchange.
 */
export function validateMcpOAuthState(stored: StoredMcpOAuth, state: string, now: Date) {
  const flow = stored.flow;
  if (!flow) throw new Error('there is no sign-in waiting to be finished');
  if (new Date(flow.expiresAt).getTime() <= now.getTime()) {
    throw new Error('that sign-in took too long — start it again');
  }
  if (base64url(sha256(state)) !== flow.stateHash) {
    throw new Error('that sign-in did not come from here');
  }

  return flow;
}

export async function completeMcpOAuth(
  stored: StoredMcpOAuth,
  state: string,
  code: string,
  now: Date
): Promise<StoredMcpOAuth> {
  const flow = validateMcpOAuthState(stored, state, now);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);
  try {
    const doc = await postToken(
      stored,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: mcpRedirectUri(),
        client_id: stored.clientId ?? '',
        code_verifier: flow.verifier,
        resource: stored.resource ?? '',
      }),
      controller.signal
    );
    return applyTokens(stored, doc, now);
  } finally {
    clearTimeout(timer);
  }
}

function isExpiring(expiresAt: string | undefined, now: Date): boolean {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() - now.getTime() <= REFRESH_MARGIN_MS;
}

/** How a caller reads and writes the grant. Kept abstract so the lock, the
 *  refresh and the storage stay separable and testable. */
export interface McpOAuthStore {
  read: (serverId: string) => Promise<StoredMcpOAuth | null>;
  write: (serverId: string, next: StoredMcpOAuth) => Promise<void>;
}

/**
 * The access token for a server, refreshed if it is close to expiry.
 *
 * Advisory-locked per SERVER, and re-read inside the lock: a refresh token is
 * single-use under rotation, so two replicas both deciding a refresh is owed
 * and both spending the same token is exactly what `invalid_grant` is for.
 */
export async function resolveMcpAccessToken(
  serverId: string,
  store: McpOAuthStore,
  now: Date = new Date()
): Promise<string | null> {
  const stored = await store.read(serverId);
  if (!stored || stored.status === 'needs_reauth') return null;
  if (!stored.accessTokenEnc) return null;
  if (!isExpiring(stored.expiresAt, now)) return decryptString(stored.accessTokenEnc);
  if (!stored.refreshTokenEnc) {
    // Expired with nothing to refresh from. Reported rather than returned: a
    // dead token in a sandbox fails as an upstream 401 that names nothing.
    await store.write(serverId, {
      ...stored,
      status: 'needs_reauth',
      detail: 'the sign-in expired and this server sent no way to renew it',
      accessTokenEnc: undefined,
      checkedAt: now.toISOString(),
    });
    return null;
  }

  return withBlockingAdvisoryLock(getDbClient(), `mcpOAuth:${serverId}`, async () => {
    // Re-read INSIDE the lock: whoever held it before us may already have
    // rotated the pair, and replaying a spent refresh token kills the grant.
    const fresh = (await store.read(serverId)) ?? stored;
    if (fresh.status === 'needs_reauth') return null;
    if (!isExpiring(fresh.expiresAt, now) && fresh.accessTokenEnc) {
      return decryptString(fresh.accessTokenEnc);
    }
    if (!fresh.refreshTokenEnc) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXCHANGE_TIMEOUT_MS);
    try {
      const doc = await postToken(
        fresh,
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: decryptString(fresh.refreshTokenEnc),
          client_id: fresh.clientId ?? '',
          resource: fresh.resource ?? '',
        }),
        controller.signal
      );
      const next = applyTokens(fresh, doc, now);
      await store.write(serverId, next);
      return decryptString(next.accessTokenEnc as EncryptedEnvelope);
    } catch (err) {
      if (err instanceof McpReauthRequiredError) {
        // The vendor's own words, kept: "the refresh token has been revoked"
        // and "this client is no longer registered" are the same status and
        // very different problems.
        await store.write(serverId, {
          ...fresh,
          status: 'needs_reauth',
          detail: err.message,
          accessTokenEnc: undefined,
          refreshTokenEnc: undefined,
          checkedAt: now.toISOString(),
        });
        return null;
      }
      // Transient. The grant is left alone and the next dispatch tries again;
      // clearing it here would turn a vendor's bad minute into a reconnect.
      console.warn(
        `[mcp] could not refresh the sign-in for server ${serverId.slice(0, 8)}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
}

/** Read optional account details from the issuer's advertised profile endpoint. */
export async function readMcpAccount(serverId: string, store: McpOAuthStore): Promise<{ name?: string; email?: string } | null> {
  const stored = await store.read(serverId);
  if (stored?.status !== 'connected' || !stored.issuer) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const token = await resolveMcpAccessToken(serverId, store);
    if (!token) return null;
    const metadata = await discoverAuthServer(stored.issuer, controller.signal);
    if (!metadata.userInfoEndpoint) return null;
    const response = await mcpFetch(metadata.userInfoEndpoint, {
      signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const profile = JSON.parse(await readMcpBody(response, 32 * 1024));
    if (!profile || typeof profile !== 'object') return null;
    const name = typeof profile.name === 'string' ? profile.name.slice(0, 200) : undefined;
    const email = typeof profile.email === 'string' ? profile.email.slice(0, 254) : undefined;
    return name || email ? { name, email } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

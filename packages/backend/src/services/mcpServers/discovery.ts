/**
 * Finding an MCP server's authorization server, per the MCP authorization spec.
 *
 * The chain is fixed and every step is a MUST, so it is written out rather than
 * guessed at:
 *
 *   1. Call the endpoint. A 401 carries `WWW-Authenticate: Bearer
 *      resource_metadata="…"` (RFC 9728).
 *   2. That document is the PROTECTED RESOURCE metadata, and it names one or
 *      more `authorization_servers`.
 *   3. Each of those is resolved to AUTHORIZATION SERVER metadata (RFC 8414 or
 *      OIDC Discovery — a client MUST support both), and for a path-ful issuer
 *      there are three spellings to try, in order.
 *
 * Every response here is a third party's, so every field is checked rather than
 * trusted: an `authorization_endpoint` that is not an https URL is how a
 * discovery chain becomes an open redirect.
 */

/** Bounded because this runs inside a request somebody is waiting on. */
const DISCOVERY_TIMEOUT_MS = 10_000;

/** A metadata document past this is not one we are going to be able to use. */
const MAX_METADATA_BYTES = 512 * 1024;

export interface AuthServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  /** Whether the AS will take an HTTPS client-id metadata document (CIMD). */
  clientIdMetadataDocumentSupported: boolean;
}

export interface ResourceMetadata {
  authorizationServers: string[];
  /** The scope the challenge asked for, which is authoritative for this call. */
  scope?: string;
  resource?: string;
}

export class McpDiscoveryError extends Error {}

async function getJson(url: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  let resp: Response;
  try {
    resp = await fetch(url, { signal, redirect: 'follow', headers: { accept: 'application/json' } });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  const text = await resp.text();
  if (text.length > MAX_METADATA_BYTES) return null;
  try {
    const doc = JSON.parse(text) as unknown;
    return typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** An https URL, or null. The one rule every endpoint in here has to pass. */
function httpsUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    // http is refused even on a loopback host: nothing in this flow runs on the
    // user's machine, so a plaintext endpoint here is a token on the wire.
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Ask the endpoint who authorizes it.
 *
 * The `WWW-Authenticate` header is the documented path. The probe fallbacks
 * below it are the spec's own, in its own order, for a server that answers 401
 * without the header — which several do.
 */
export async function discoverResourceMetadata(
  endpoint: string,
  signal: AbortSignal
): Promise<ResourceMetadata> {
  let challenge = '';
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    if (resp.status !== 401) {
      // Not a 401 means the server did not ask for authorization on an
      // unauthenticated call, which is a different situation from a failed
      // discovery: this server takes a pasted key, or none at all.
      throw new McpDiscoveryError(
        'this server did not ask to be signed in to — paste its key instead'
      );
    }
    challenge = resp.headers.get('www-authenticate') ?? '';
  } catch (err) {
    if (err instanceof McpDiscoveryError) throw err;
    throw new McpDiscoveryError(
      `could not reach the server: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const named = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  const scope = /scope="([^"]+)"/.exec(challenge)?.[1];

  const base = new URL(endpoint);
  const candidates = named
    ? [named]
    : [
        // The spec's order for a challenge with no document named: path-ful
        // first, then the bare one.
        `${base.origin}/.well-known/oauth-protected-resource${base.pathname}`,
        `${base.origin}/.well-known/oauth-protected-resource`,
      ];

  for (const url of candidates) {
    const doc = await getJson(url, signal);
    if (!doc) continue;
    const servers = Array.isArray(doc.authorization_servers)
      ? doc.authorization_servers.map(httpsUrl).filter((s): s is string => s !== null)
      : [];
    if (servers.length === 0) continue;
    return {
      authorizationServers: servers,
      ...(scope ? { scope } : {}),
      ...(typeof doc.resource === 'string' ? { resource: doc.resource } : {}),
    };
  }
  throw new McpDiscoveryError(
    'this server asked to be signed in to but did not say where, so there is nothing to sign in to'
  );
}

/**
 * Resolve an issuer to its authorization-server metadata.
 *
 * Three spellings, in the spec's order, because an issuer with a path is
 * ambiguous between RFC 8414 and OIDC Discovery and a client MUST support both.
 */
export async function discoverAuthServer(
  issuer: string,
  signal: AbortSignal
): Promise<AuthServerMetadata> {
  const u = new URL(issuer);
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  const candidates = [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
  ];

  for (const url of candidates) {
    const doc = await getJson(url, signal);
    if (!doc) continue;
    const authorizationEndpoint = httpsUrl(doc.authorization_endpoint);
    const tokenEndpoint = httpsUrl(doc.token_endpoint);
    if (!authorizationEndpoint || !tokenEndpoint) continue;

    // PKCE S256 is a MUST, and a client MUST refuse to proceed when the server
    // does not advertise it. Refused here rather than at the token exchange,
    // where the user has already been to a consent screen for nothing.
    const methods = Array.isArray(doc.code_challenge_methods_supported)
      ? doc.code_challenge_methods_supported
      : [];
    if (!methods.includes('S256')) {
      throw new McpDiscoveryError(
        'this server’s sign-in does not support PKCE, which Talyn requires and the MCP ' +
          'specification mandates'
      );
    }

    return {
      issuer: typeof doc.issuer === 'string' ? doc.issuer : issuer,
      authorizationEndpoint,
      tokenEndpoint,
      ...(httpsUrl(doc.registration_endpoint)
        ? { registrationEndpoint: httpsUrl(doc.registration_endpoint) as string }
        : {}),
      ...(Array.isArray(doc.scopes_supported)
        ? { scopesSupported: doc.scopes_supported.filter((s): s is string => typeof s === 'string') }
        : {}),
      clientIdMetadataDocumentSupported: doc.client_id_metadata_document_supported === true,
    };
  }
  throw new McpDiscoveryError('could not read this server’s sign-in configuration');
}

/** Run both legs under one deadline. */
export async function discover(
  endpoint: string
): Promise<{ resource: ResourceMetadata; server: AuthServerMetadata }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const resource = await discoverResourceMetadata(endpoint, controller.signal);
    // The first authorization server, which is what a client with no reason to
    // prefer another does. A server naming several is rare and none of them
    // documents how to choose.
    const issuer = resource.authorizationServers[0];
    if (!issuer) throw new McpDiscoveryError('this server named no authorization server');
    const server = await discoverAuthServer(issuer, controller.signal);
    return { resource, server };
  } finally {
    clearTimeout(timer);
  }
}

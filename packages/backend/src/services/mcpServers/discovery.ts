import { mcpFetch, publicHttpsUrl as httpsUrl, readMcpBody } from './http.js';

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
  userInfoEndpoint?: string;
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
    resp = await mcpFetch(url, { signal, headers: { accept: 'application/json' } });
  } catch {
    return null;
  }
  if (!resp.ok) {
    await resp.body?.cancel();
    return null;
  }
  try {
    const text = await readMcpBody(resp, MAX_METADATA_BYTES);
    const doc = JSON.parse(text) as unknown;
    return typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface EndpointChallenge {
  challenge: string;
  status: number;
  anonymous: boolean;
}

function initializeResult(text: string): boolean {
  const frames = text.trimStart().startsWith('{')
    ? [text]
    : text
        .split(/\r?\n/)
        .filter((s) => s.startsWith('data:'))
        .map((s) => s.slice(5));
  return frames.some((frame) => {
    try {
      const doc = JSON.parse(frame);
      return (
        doc.id === 1 &&
        doc.result &&
        typeof doc.result.protocolVersion === 'string' &&
        typeof doc.result.serverInfo?.name === 'string'
      );
    } catch {
      return false;
    }
  });
}

export async function inspectMcpEndpoint(
  endpoint: string,
  signal: AbortSignal
): Promise<EndpointChallenge> {
  const resp = await mcpFetch(endpoint, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'talyn', version: '1' },
      },
    }),
  });
  const challenge = resp.headers.get('www-authenticate') ?? '';
  let anonymous = false;
  if (resp.ok)
    anonymous = initializeResult(await readMcpBody(resp, MAX_METADATA_BYTES, initializeResult));
  else await resp.body?.cancel();
  return { challenge, status: resp.status, anonymous };
}

export function challengeParameter(challenge: string, name: string): string | undefined {
  const bearer = /(?:^|,)\s*Bearer\s+(.+?)(?=,\s*[a-z][\w-]*\s+(?![=])|$)/i.exec(challenge)?.[1];
  if (!bearer) return undefined;
  const match = new RegExp(
    `(?:^|[,\\s])${name}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^,\\s]+))`,
    'i'
  ).exec(bearer);
  return match ? (match[1] ?? match[2]).replace(/\\(.)/g, '$1') : undefined;
}

export async function resourceMetadataFromChallenge(
  endpoint: string,
  challenge: string,
  signal: AbortSignal
): Promise<ResourceMetadata> {
  const named = challengeParameter(challenge, 'resource_metadata');
  const scope = challengeParameter(challenge, 'scope');
  const base = new URL(endpoint);
  const candidates = named
    ? [named]
    : [
        `${base.origin}/.well-known/oauth-protected-resource${base.pathname === '/' ? '' : base.pathname}`,
        `${base.origin}/.well-known/oauth-protected-resource`,
      ];
  for (const url of new Set(candidates)) {
    const doc = await getJson(url, signal);
    if (!doc) continue;
    const resourceUrl = httpsUrl(doc.resource);
    if (!resourceUrl) continue;
    const resource = new URL(resourceUrl);
    // Some servers publish an origin-wide audience at their root metadata URL.
    const originResource =
      resource.origin === base.origin &&
      resource.pathname === '/' && !resource.search && !resource.hash &&
      url === `${base.origin}/.well-known/oauth-protected-resource`;
    if (resource.toString() !== base.toString() && !originResource) continue;
    const servers = Array.isArray(doc.authorization_servers)
      ? doc.authorization_servers.filter(
          (s): s is string => typeof s === 'string' && httpsUrl(s) !== null
        )
      : [];
    if (!servers.length) continue;
    const supported = Array.isArray(doc.scopes_supported)
      ? doc.scopes_supported.filter((s): s is string => typeof s === 'string').join(' ')
      : undefined;
    return { authorizationServers: servers, resource: doc.resource as string, scope: scope ?? supported };
  }
  throw new McpDiscoveryError('The server did not provide usable OAuth resource metadata.');
}

export async function discoverResourceMetadata(
  endpoint: string,
  signal: AbortSignal
): Promise<ResourceMetadata> {
  const { challenge } = await inspectMcpEndpoint(endpoint, signal);
  return resourceMetadataFromChallenge(endpoint, challenge, signal);
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
    if (doc.issuer !== issuer) {
      throw new McpDiscoveryError('The OAuth issuer does not match its metadata.');
    }

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
      ...(httpsUrl(doc.userinfo_endpoint) && new URL(doc.userinfo_endpoint as string).origin === new URL(issuer).origin
        ? { userInfoEndpoint: doc.userinfo_endpoint as string }
        : {}),
      ...(httpsUrl(doc.registration_endpoint)
        ? { registrationEndpoint: httpsUrl(doc.registration_endpoint) as string }
        : {}),
      ...(Array.isArray(doc.scopes_supported)
        ? {
            scopesSupported: doc.scopes_supported.filter((s): s is string => typeof s === 'string'),
          }
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

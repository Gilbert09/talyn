import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  completeMcpOAuth,
  grantStatus,
  serverIdFromState,
  startMcpOAuth,
  type StoredMcpOAuth,
} from '../services/mcpServers/oauth.js';
import { discoverAuthServer, McpDiscoveryError } from '../services/mcpServers/discovery.js';
import { encryptString } from '../services/tokenCrypto.js';

/**
 * Brokering a sign-in to somebody else's MCP server.
 *
 * Every response in this flow is a third party's, so the tests are mostly about
 * what is REFUSED: an authorization server with no PKCE, a callback whose state
 * does not match, a replayed one. The spec makes most of these MUSTs, and the
 * cost of getting one wrong is a token issued to the wrong party.
 */

const KEY = Buffer.alloc(32, 9).toString('base64');

beforeEach(() => {
  process.env.TALYN_TOKEN_KEY = KEY;
  process.env.WEB_APP_URL = 'https://app.talyn.dev';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Answer a fixed map of URL → JSON, and 404 everything else. */
function stubFetch(routes: Record<string, unknown>, extra?: (url: string, init?: RequestInit) => Response | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const override = extra?.(url, init);
      if (override) return override;
      if (url in routes) {
        return new Response(JSON.stringify(routes[url]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    })
  );
}

describe('authorization-server discovery', () => {
  const AS = {
    issuer: 'https://auth.example.com',
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    code_challenge_methods_supported: ['S256'],
  };

  it('reads RFC 8414 metadata', async () => {
    stubFetch({ 'https://auth.example.com/.well-known/oauth-authorization-server': AS });
    const meta = await discoverAuthServer('https://auth.example.com', new AbortController().signal);
    expect(meta.tokenEndpoint).toBe('https://auth.example.com/token');
    expect(meta.clientIdMetadataDocumentSupported).toBe(false);
  });

  // A path-ful issuer is ambiguous between RFC 8414 and OIDC Discovery, and a
  // client MUST support both spellings.
  it('falls back to the OIDC spellings for a path-ful issuer', async () => {
    stubFetch({ 'https://auth.example.com/tenant/.well-known/openid-configuration': AS });
    const meta = await discoverAuthServer(
      'https://auth.example.com/tenant',
      new AbortController().signal
    );
    expect(meta.issuer).toBe('https://auth.example.com');
  });

  // PKCE S256 is a MUST and a client MUST refuse without it. Refused HERE
  // rather than at the exchange, where somebody has already been to a consent
  // screen for nothing.
  it('refuses a server that does not advertise PKCE S256', async () => {
    stubFetch({
      'https://auth.example.com/.well-known/oauth-authorization-server': {
        ...AS,
        code_challenge_methods_supported: ['plain'],
      },
    });
    await expect(
      discoverAuthServer('https://auth.example.com', new AbortController().signal)
    ).rejects.toThrow(McpDiscoveryError);
  });

  // An http endpoint in a discovery document is a token on the wire, and an
  // attacker-controlled one is an open redirect. Dropped, which fails the
  // document rather than using it.
  it('refuses a non-https endpoint', async () => {
    stubFetch({
      'https://auth.example.com/.well-known/oauth-authorization-server': {
        ...AS,
        authorization_endpoint: 'http://auth.example.com/authorize',
      },
    });
    await expect(
      discoverAuthServer('https://auth.example.com', new AbortController().signal)
    ).rejects.toThrow(/could not read/);
  });
});

describe('starting a sign-in', () => {
  const stored: StoredMcpOAuth = {
    status: 'pending',
    authorizationEndpoint: 'https://auth.example.com/authorize',
    tokenEndpoint: 'https://auth.example.com/token',
    clientId: 'https://app.talyn.dev/.well-known/oauth-client/talyn.json',
    clientSource: 'cimd',
    resource: 'https://mcp.example.com/mcp',
    scopes: ['read'],
  };

  it('builds an authorize URL with PKCE, state and the RFC 8707 resource', async () => {
    const started = await startMcpOAuth(
      { id: 'srv-1', url: 'https://mcp.example.com/mcp' },
      stored,
      new Date('2026-09-16T12:00:00Z')
    );
    const url = new URL(started.authorizeUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.talyn.dev/mcp/callback');
    // Binds the token to THIS endpoint, so a server that leaks one cannot have
    // it spent somewhere else. Sent whether or not the AS advertises support.
    expect(url.searchParams.get('resource')).toBe('https://mcp.example.com/mcp');
    // The verifier is kept, and the state only as a hash.
    expect(started.stored.flow?.verifier).toBeTruthy();
    expect(started.stored.flow?.stateHash).toBeTruthy();
    expect(JSON.stringify(started.stored.flow)).not.toContain(
      url.searchParams.get('state') as string
    );
  });

  // The state has to name the server, because the callback page is handed
  // nothing else — and the id half must survive the round trip.
  it('names the server in the state', async () => {
    const started = await startMcpOAuth(
      { id: 'srv-1', url: 'https://mcp.example.com/mcp' },
      stored,
      new Date()
    );
    const state = new URL(started.authorizeUrl).searchParams.get('state') as string;
    expect(serverIdFromState(state)).toBe('srv-1');
  });

  // A token in hand still works. An abandoned consent tab must not report a
  // healthy server as disconnected.
  it('leaves a connected server connected while a reconnect is in flight', async () => {
    const started = await startMcpOAuth(
      { id: 'srv-1', url: 'https://mcp.example.com/mcp' },
      { ...stored, status: 'connected' },
      new Date()
    );
    expect(started.stored.status).toBe('connected');
  });

  // Re-connecting a known server skips discovery and registration: the
  // endpoints do not move, and registering again would leave an orphan client
  // at the vendor on every press.
  it('reuses a known client rather than registering again', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await startMcpOAuth({ id: 'srv-1', url: 'https://mcp.example.com/mcp' }, stored, new Date());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('finishing a sign-in', () => {
  async function started() {
    return startMcpOAuth(
      { id: 'srv-1', url: 'https://mcp.example.com/mcp' },
      {
        status: 'pending',
        authorizationEndpoint: 'https://auth.example.com/authorize',
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'client-1',
        clientSource: 'dcr',
        resource: 'https://mcp.example.com/mcp',
      },
      new Date()
    );
  }

  it('exchanges the code and stores the pair encrypted', async () => {
    const s = await started();
    const state = new URL(s.authorizeUrl).searchParams.get('state') as string;
    stubFetch({
      'https://auth.example.com/token': {
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 3600,
      },
    });
    const next = await completeMcpOAuth(s.stored, state, 'code-1', new Date());
    expect(next.status).toBe('connected');
    // Encrypted, and the flow cleared so a replay finds nothing.
    expect(JSON.stringify(next)).not.toContain('at-1');
    expect(JSON.stringify(next)).not.toContain('rt-1');
    expect(next.flow).toBeUndefined();
  });

  it('refuses a state that does not match', async () => {
    const s = await started();
    await expect(completeMcpOAuth(s.stored, 'srv-1.forged', 'code-1', new Date())).rejects.toThrow(
      /did not come from here/
    );
  });

  it('refuses an expired flow', async () => {
    const s = await started();
    const state = new URL(s.authorizeUrl).searchParams.get('state') as string;
    const later = new Date(Date.now() + 11 * 60 * 1000);
    await expect(completeMcpOAuth(s.stored, state, 'code-1', later)).rejects.toThrow(/took too long/);
  });

  // Rotation is a MUST for a public client, so a response whose new refresh
  // token we dropped would invalidate the grant on the very next refresh.
  it('stores the rotated refresh token rather than keeping the old one', async () => {
    const s = await started();
    const state = new URL(s.authorizeUrl).searchParams.get('state') as string;
    const before: StoredMcpOAuth = { ...s.stored, refreshTokenEnc: encryptString('rt-old') };
    stubFetch({
      'https://auth.example.com/token': { access_token: 'at-2', refresh_token: 'rt-new' },
    });
    const next = await completeMcpOAuth(before, state, 'code-1', new Date());
    expect(next.refreshTokenEnc).not.toEqual(before.refreshTokenEnc);
  });
});

describe('grantStatus', () => {
  // The one function a client's answer goes through, so it is the one place a
  // token could leak into a response.
  it('carries the status and never a credential', () => {
    const out = grantStatus({
      status: 'connected',
      clientId: 'client-1',
      accessTokenEnc: encryptString('at-secret'),
      refreshTokenEnc: encryptString('rt-secret'),
      clientSecretEnc: encryptString('cs-secret'),
      flow: { id: 'f', stateHash: 'h', verifier: 'v-secret', expiresAt: 'x' },
    });
    const json = JSON.stringify(out);
    expect(out?.status).toBe('connected');
    expect(out?.clientId).toBe('client-1');
    for (const secret of ['at-secret', 'rt-secret', 'cs-secret', 'v-secret', 'accessToken', 'verifier']) {
      expect(json).not.toContain(secret);
    }
  });
});

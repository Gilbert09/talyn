import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  exchangeCode,
  resolveClaudeAccessToken,
  splitPastedCode,
  ClaudeOAuthError,
  ClaudeReauthRequiredError,
  CLAUDE_CLIENT_ID,
  CLAUDE_REDIRECT_URI,
  _resetClaudeOauthInflight,
  type ClaudeOAuthCredential,
} from '../services/selfHosted/claudeOauth.js';
import { encryptString, decryptString } from '../services/tokenCrypto.js';

/**
 * The Claude-subscription credential, which replaced `claude setup-token` and a
 * paste.
 *
 * The behaviour worth pinning is the part that is invisible until it breaks at
 * 03:00: a loop fires against a token minted yesterday, the guest never sees the
 * credential, and the refresh has to have happened before the dispatch.
 */

function credential(over: Partial<ClaudeOAuthCredential> = {}): ClaudeOAuthCredential {
  return {
    accessTokenEnc: encryptString('sk-ant-oat01-current'),
    refreshTokenEnc: encryptString('refresh-1'),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ...over,
  };
}

/** A store that records what was written, standing in for the integrations row. */
function makeStore(initial?: ClaudeOAuthCredential) {
  let held = initial;
  return {
    read: vi.fn(async () => held),
    patch: vi.fn(async (_id: string, next: ClaudeOAuthCredential) => {
      held = next;
    }),
    get current() {
      return held;
    },
  };
}

function okResponse(body: unknown) {
  return { status: 200, statusText: 'OK', ok: true, headers: new Headers(), bodyText: JSON.stringify(body) };
}
function errResponse(status: number, body: unknown) {
  return { status, statusText: 'Bad', ok: false, headers: new Headers(), bodyText: JSON.stringify(body) };
}

const fetchWithTimeout = vi.hoisted(() => vi.fn());
vi.mock('../services/httpTimeout.js', () => ({ fetchWithTimeout }));
vi.mock('../services/debugBus.js', () => ({ debugBus: { recordHttp: vi.fn() } }));

describe('claude oauth', () => {
  beforeEach(() => {
    process.env.TALYN_TOKEN_KEY = Buffer.from('k'.repeat(32)).toString('base64');
    fetchWithTimeout.mockReset();
    _resetClaudeOauthInflight();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('the authorize leg', () => {
    it('sends the browser to Anthropic, not to a loopback', () => {
      // The whole reason this works on the web where Codex cannot: nothing
      // listens on a port, so the desktop and the browser run the same flow.
      const url = buildAuthorizeUrl({ codeChallenge: 'chal', state: 'st' });
      expect(url.startsWith('https://platform.claude.com/oauth/authorize?')).toBe(true);
      const q = new URL(url).searchParams;
      expect(q.get('client_id')).toBe(CLAUDE_CLIENT_ID);
      expect(q.get('redirect_uri')).toBe(CLAUDE_REDIRECT_URI);
      expect(q.get('redirect_uri')).not.toContain('localhost');
      expect(q.get('code_challenge_method')).toBe('S256');
      expect(q.get('code_challenge')).toBe('chal');
    });

    it('does NOT ask to generate API keys', () => {
      // Claude Code asks for `org:create_api_key` so `setup-token` can mint a
      // long-lived key. Talyn holds the subscription token and calls inference
      // with it, so asking would put "Generate API keys on your behalf" on the
      // consent screen for a power we never use.
      const scope = new URL(buildAuthorizeUrl({ codeChallenge: 'c', state: 's' })).searchParams.get(
        'scope',
      )!;
      expect(scope).not.toContain('org:create_api_key');
      expect(scope).toContain('user:inference');
    });
  });

  describe('the pasted code', () => {
    it('splits `code#state`, which is what the callback page shows', () => {
      // Asking a user to trim it is an instruction that will be got wrong.
      expect(splitPastedCode('  abc123#state-xyz  ')).toEqual({ code: 'abc123', state: 'state-xyz' });
    });

    it('accepts a bare code unchanged', () => {
      expect(splitPastedCode('abc123')).toEqual({ code: 'abc123' });
    });
  });

  describe('exchange', () => {
    it('stores an encrypted pair', async () => {
      fetchWithTimeout.mockResolvedValue(
        okResponse({ access_token: 'sk-ant-oat01-new', refresh_token: 'r-new', expires_in: 3600 }),
      );
      const cred = await exchangeCode({ code: 'c', codeVerifier: 'v' });
      expect(decryptString(cred.accessTokenEnc)).toBe('sk-ant-oat01-new');
      expect(decryptString(cred.refreshTokenEnc)).toBe('r-new');
      expect(Date.parse(cred.expiresAt)).toBeGreaterThan(Date.now());
      // PKCE: the verifier travels, and no client secret exists to send.
      const body = JSON.parse(fetchWithTimeout.mock.calls[0][1].body as string);
      expect(body.code_verifier).toBe('v');
      expect(body).not.toHaveProperty('client_secret');
    });

    it('refuses a grant with no refresh token', async () => {
      // Storing one would put us back where the paste flow was: a credential
      // that stops working within hours and nothing to renew it with.
      fetchWithTimeout.mockResolvedValue(okResponse({ access_token: 'a', expires_in: 3600 }));
      await expect(exchangeCode({ code: 'c', codeVerifier: 'v' })).rejects.toThrow(ClaudeOAuthError);
    });
  });

  describe('resolving a token for a dispatch', () => {
    it('uses the stored token while it is still fresh', async () => {
      const store = makeStore();
      const token = await resolveClaudeAccessToken('ws1', credential(), store);
      expect(token).toBe('sk-ant-oat01-current');
      expect(fetchWithTimeout).not.toHaveBeenCalled();
    });

    it('refreshes before expiry, not at it', async () => {
      // The margin is the point: a loop firing at 03:00 must not race the clock.
      const nearly = credential({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
      const store = makeStore(nearly);
      fetchWithTimeout.mockResolvedValue(
        okResponse({ access_token: 'sk-ant-oat01-fresh', refresh_token: 'r-2', expires_in: 3600 }),
      );

      expect(await resolveClaudeAccessToken('ws1', nearly, store)).toBe('sk-ant-oat01-fresh');
      expect(store.patch).toHaveBeenCalledTimes(1);
      expect(decryptString(store.current!.refreshTokenEnc)).toBe('r-2');
    });

    it('keeps the old refresh token when the response omits one', async () => {
      // Anthropic rotates, but an absent new token means "keep yours" — not a
      // failure. Dropping it strands the workspace on a token it cannot renew.
      const nearly = credential({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
      const store = makeStore(nearly);
      fetchWithTimeout.mockResolvedValue(okResponse({ access_token: 'a2', expires_in: 3600 }));

      await resolveClaudeAccessToken('ws1', nearly, store);
      expect(decryptString(store.current!.refreshTokenEnc)).toBe('refresh-1');
    });

    it('collapses concurrent refreshes into one token call', async () => {
      // Two dispatches at once must not both spend the refresh token; the
      // second would replay a spent one and earn invalid_grant.
      const nearly = credential({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
      const store = makeStore(nearly);
      fetchWithTimeout.mockResolvedValue(
        okResponse({ access_token: 'a3', refresh_token: 'r-3', expires_in: 3600 }),
      );

      const [a, b] = await Promise.all([
        resolveClaudeAccessToken('ws1', nearly, store),
        resolveClaudeAccessToken('ws1', nearly, store),
      ]);
      expect([a, b]).toEqual(['a3', 'a3']);
      expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    });

    it('rides out a transient failure on a token that is still valid', async () => {
      // We refresh five minutes early, so a brief wobble must not fail a
      // dispatch the token in hand could have served.
      const nearly = credential({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
      fetchWithTimeout.mockRejectedValue(new Error('network'));
      expect(await resolveClaudeAccessToken('ws1', nearly, makeStore(nearly))).toBe(
        'sk-ant-oat01-current',
      );
    });

    it('does NOT ride out a dead grant', async () => {
      // Handing back the old token would move the failure into the guest, where
      // it reads as "the agent could not make a single call".
      const nearly = credential({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
      fetchWithTimeout.mockResolvedValue(errResponse(400, { error: 'invalid_grant' }));
      await expect(
        resolveClaudeAccessToken('ws1', nearly, makeStore(nearly)),
      ).rejects.toThrow(ClaudeReauthRequiredError);
    });

    it('reads a dead grant out of Anthropic\'s OWN error envelope', async () => {
      // Anthropic answers in two shapes, and a live probe of the token endpoint
      // returned the second. Reading only the RFC 6749 one leaves `error` as an
      // object, `=== invalid_grant` quietly false, and a dead grant retried on
      // every dispatch forever — the one failure this module exists to catch.
      const nearly = credential({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
      fetchWithTimeout.mockResolvedValue(
        errResponse(400, { error: { type: 'invalid_grant', message: 'grant is gone' } }),
      );
      await expect(
        resolveClaudeAccessToken('ws1', nearly, makeStore(nearly)),
      ).rejects.toThrow(ClaudeReauthRequiredError);
    });

    it('treats the rate-limit envelope as transient, not as a dead grant', async () => {
      // The exact body the probe got back. Clearing the pair on this would sign
      // the user out because Anthropic was busy.
      const nearly = credential({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
      fetchWithTimeout.mockResolvedValue(
        errResponse(429, {
          error: { type: 'rate_limit_error', message: 'Rate limited. Please try again later.' },
        }),
      );
      // Still inside the margin, so the token in hand is served rather than
      // failing the dispatch.
      expect(await resolveClaudeAccessToken('ws1', nearly, makeStore(nearly))).toBe(
        'sk-ant-oat01-current',
      );
    });

    it('still reads the plain RFC 6749 shape', async () => {
      const nearly = credential({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
      fetchWithTimeout.mockResolvedValue(
        errResponse(400, { error: 'invalid_grant', error_description: 'expired' }),
      );
      await expect(
        resolveClaudeAccessToken('ws1', nearly, makeStore(nearly)),
      ).rejects.toThrow(ClaudeReauthRequiredError);
    });

    it('retries nothing once reauth is required', async () => {
      const dead = credential({ reauthRequiredAt: new Date().toISOString() });
      expect(await resolveClaudeAccessToken('ws1', dead, makeStore(dead))).toBeNull();
      expect(fetchWithTimeout).not.toHaveBeenCalled();
    });
  });
});

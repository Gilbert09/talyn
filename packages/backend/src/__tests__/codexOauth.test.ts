import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { fleetAccounts, workspaces as workspacesTable } from '../db/schema.js';

/**
 * The ChatGPT-subscription token lifecycle.
 *
 * The authorize leg is NOT here and cannot be: OpenAI's Codex client redirects
 * to `http://localhost:1455/auth/callback`, so it runs in the desktop's main
 * process (`main/codexAuth.ts`). What the backend owns is REFRESH, because a
 * subscription access token is short-lived, a fleet run outlives it, and the
 * guest can never refresh for itself — it holds no credential at all.
 *
 * Mirrors `posthogCode/oauth.ts`'s shape deliberately, including the two
 * properties that are easy to get wrong and expensive when you do: a
 * PREEMPTIVE failure must not fail the caller, and `invalid_grant` must be
 * terminal rather than retried on every dispatch and every poll tick.
 */

const fetchMock = vi.fn();
vi.mock('../services/httpTimeout.js', () => ({
  fetchWithTimeout: (...args: unknown[]) => fetchMock(...args),
}));
vi.mock('../services/debugBus.js', () => ({ debugBus: { recordHttp: vi.fn() } }));

const { resetCodexOauthCache, codexCredentialFrom, CodexReauthRequiredError } = await import(
  '../services/selfHosted/codexOauth.js'
);
const { getSelfHostedCredentials, storeSelfHostedCredentials } = await import(
  '../services/selfHosted/credentials.js'
);

/** A real (unsigned) JWT carrying the one claim the Codex backend needs. */
function jwt(accountId = 'acct-1'): string {
  const claims = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
  ).toString('base64url');
  return `h.${claims}.s`;
}

function tokenResponse(body: object, ok = true, status = 200) {
  return { ok, status, bodyText: JSON.stringify(body) };
}

describe('Codex OAuth refresh', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let priorKey: string | undefined;

  beforeAll(() => {
    priorKey = process.env.TALYN_TOKEN_KEY;
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
  });
  afterAll(() => {
    if (priorKey === undefined) delete process.env.TALYN_TOKEN_KEY;
    else process.env.TALYN_TOKEN_KEY = priorKey;
  });

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID });
    await db
      .insert(workspacesTable)
      .values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: {} });
    fetchMock.mockReset();
    resetCodexOauthCache();
  });
  afterEach(async () => cleanup());

  /** Store a credential that expired `agoMs` ago (negative = still valid). */
  async function seedCodex(expiresInMs: number) {
    const cred = codexCredentialFrom({ accessToken: jwt(), refreshToken: 'rt-1', expiresIn: 3600 });
    await storeSelfHostedCredentials('ws1', {
      codex: { ...cred, expiresAt: new Date(Date.now() + expiresInMs).toISOString() },
    });
  }

  /** The Codex account's stored credential, with its reauth column folded in. */
  async function storedCodex(): Promise<Record<string, unknown>> {
    const rows = await db
      .select({
        credential: fleetAccounts.credential,
        reauthRequiredAt: fleetAccounts.reauthRequiredAt,
      })
      .from(fleetAccounts)
      .where(eq(fleetAccounts.workspaceId, 'ws1'))
      .limit(1);
    const row = rows[0];
    if (!row) return {};
    return {
      ...(row.credential as unknown as Record<string, unknown>),
      ...(row.reauthRequiredAt ? { reauthRequiredAt: row.reauthRequiredAt } : {}),
    };
  }

  async function codexAccountId(): Promise<string> {
    const rows = await db
      .select({ id: fleetAccounts.id })
      .from(fleetAccounts)
      .where(eq(fleetAccounts.workspaceId, 'ws1'))
      .limit(1);
    return rows[0]!.id;
  }

  it('does not refresh a token with time left on it', async () => {
    await seedCodex(60 * 60_000);
    const creds = await getSelfHostedCredentials('ws1');
    expect(creds?.openaiKey).toBe(jwt());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes a token inside the skew window and stores the rotated pair', async () => {
    await seedCodex(60_000); // inside the 5-minute skew
    fetchMock.mockResolvedValue(
      tokenResponse({ access_token: jwt('acct-2'), refresh_token: 'rt-2', expires_in: 3600 }),
    );

    const creds = await getSelfHostedCredentials('ws1');
    expect(creds?.openaiKey).toBe(jwt('acct-2'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Rotated on disk, or the next refresh replays a spent token.
    expect(await storedCodex()).toMatchObject({ accountId: 'acct-2' });
  });

  /**
   * OpenAI rotates the refresh token on every use, so two concurrent refreshes
   * mean one of them replays a token that is already spent. The in-process
   * promise map is the cheap half of the single-flight (the advisory lock is
   * the other, and only bites across instances).
   */
  it('single-flights concurrent refreshes into one token request', async () => {
    await seedCodex(60_000);
    fetchMock.mockResolvedValue(
      tokenResponse({ access_token: jwt('acct-3'), refresh_token: 'rt-3', expires_in: 3600 }),
    );

    const [a, b, c] = await Promise.all([
      getSelfHostedCredentials('ws1'),
      getSelfHostedCredentials('ws1'),
      getSelfHostedCredentials('ws1'),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const r of [a, b, c]) expect(r?.openaiKey).toBe(jwt('acct-3'));
  });

  // The single-flight and the lock are per ACCOUNT. Keyed by workspace, a
  // second account's refresh would wait on the first one's and get its token.
  it('refreshes two accounts of one workspace separately', async () => {
    await seedCodex(60_000);
    const { addFleetAccount } = await import('../services/selfHosted/accounts.js');
    const second = codexCredentialFrom({ accessToken: jwt('acct-b'), refreshToken: 'rt-b', expiresIn: 3600 });
    const added = await addFleetAccount('ws1', {
      kind: 'codex_oauth',
      credential: { ...second, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const rt = new URLSearchParams(init.body).get('refresh_token');
      return tokenResponse({
        access_token: jwt(rt === 'rt-b' ? 'acct-b2' : 'acct-a2'),
        refresh_token: `${rt}-next`,
        expires_in: 3600,
      });
    });

    const [first, other] = await Promise.all([
      getSelfHostedCredentials('ws1'),
      getSelfHostedCredentials('ws1', { codexAccountId: added.id }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first?.openaiKey).toBe(jwt('acct-a2'));
    expect(other?.openaiKey).toBe(jwt('acct-b2'));
    expect(other?.codexAccountId).toBe(added.id);
    expect(first?.codexAccountId).not.toBe(added.id);
  });

  /**
   * We refresh five minutes early, so the token in hand is normally still good.
   * Failing the caller here would turn a brief OpenAI wobble into failed
   * dispatches and stalled polls for that whole window.
   */
  it('falls back to the token in hand when a PREEMPTIVE refresh fails', async () => {
    await seedCodex(60_000);
    fetchMock.mockResolvedValue(tokenResponse({ error: 'server_error' }, false, 503));

    const creds = await getSelfHostedCredentials('ws1');
    expect(creds?.openaiKey).toBe(jwt());
  });

  /** No falling back once it is genuinely expired — that just moves the failure
   *  into the guest, where it reads as "the agent made no calls at all". */
  it('does not fall back once the token is actually expired', async () => {
    await seedCodex(-60_000);
    fetchMock.mockResolvedValue(tokenResponse({ error: 'server_error' }, false, 503));
    await expect(getSelfHostedCredentials('ws1')).rejects.toThrow();
  });

  /**
   * `invalid_grant` is RFC 6749 for "this will never work again". Retrying it on
   * every dispatch and every poll tick spends requests to be told the same
   * thing, so it is terminal and the user is asked to reconnect.
   */
  it('treats invalid_grant as terminal', async () => {
    await seedCodex(60_000);
    fetchMock.mockResolvedValue(tokenResponse({ error: 'invalid_grant' }, false, 400));

    await expect(getSelfHostedCredentials('ws1')).rejects.toBeInstanceOf(CodexReauthRequiredError);
  });

  it('stops retrying once reauth is flagged, and reports it', async () => {
    await seedCodex(60_000);
    const { markCodexReauthRequired } = await import('../services/selfHosted/codexOauth.js');
    await markCodexReauthRequired(await codexAccountId());

    // No credential is served and NOTHING is retried.
    expect(await getSelfHostedCredentials('ws1')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    // Still reported as connected, so the card can offer "Reconnect" rather
    // than telling the user they never set it up.
    const { fleetAgentStatus } = await import('../services/selfHosted/credentials.js');
    expect(await fleetAgentStatus('ws1')).toEqual({
      connectedAgents: ['codex'],
      reauthAgents: ['codex'],
    });
  });

  it('clears the reauth flag once a refresh succeeds again', async () => {
    await seedCodex(60_000);
    const { markCodexReauthRequired } = await import('../services/selfHosted/codexOauth.js');
    await markCodexReauthRequired(await codexAccountId());
    // Reconnecting writes a fresh credential with no flag on it.
    await storeSelfHostedCredentials('ws1', {
      codex: codexCredentialFrom({ accessToken: jwt(), refreshToken: 'rt-9', expiresIn: 3600 }),
    });
    expect(await storedCodex()).not.toHaveProperty('reauthRequiredAt');
  });

  // A response that drops the refresh token must not strand the workspace on an
  // access token it can never renew.
  it('keeps the existing refresh token when a rotation omits one', async () => {
    await seedCodex(60_000);
    fetchMock.mockResolvedValue(tokenResponse({ access_token: jwt('acct-4'), expires_in: 3600 }));
    const creds = await getSelfHostedCredentials('ws1');
    expect(creds?.openaiKey).toBe(jwt('acct-4'));
    expect(await storedCodex()).toHaveProperty('refreshTokenEnc');
  });
});

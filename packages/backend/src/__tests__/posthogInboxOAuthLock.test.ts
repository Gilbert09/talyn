import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { PostHogIntegrationConfig, PostHogRowType } from '../services/posthogCode/integrationRow.js';

/**
 * The cross-replica half of the refresh single-flight: on real Postgres every
 * refresh runs inside an advisory lock named for its row. The Inbox row and
 * the PostHog Code row lock apart, and the PostHog Code name stays the one
 * older builds use, so a deploy's two instances still exclude each other.
 */

const rows = new Map<PostHogRowType, PostHogIntegrationConfig>();
const locks: string[] = [];

vi.mock('../db/client.js', () => ({
  getDbClient: () => ({}),
  getPoolDbClient: () => ({ pool: true }),
  isRealPostgres: () => true,
}));
vi.mock('../services/advisoryLock.js', () => ({
  withBlockingAdvisoryLock: vi.fn(async (_db: unknown, key: string, fn: () => Promise<unknown>) => {
    locks.push(key);
    return fn();
  }),
}));
vi.mock('../services/posthogCode/integrationRow.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/posthogCode/integrationRow.js')>()),
  readPostHogRow: vi.fn(async (type: PostHogRowType) => {
    const config = rows.get(type);
    return config ? { id: `int-${type}`, enabled: true, config } : null;
  }),
  upsertPostHogRow: vi.fn(async (type: PostHogRowType, _ws: string, mutate: (c: PostHogIntegrationConfig) => PostHogIntegrationConfig) => {
    rows.set(type, mutate(rows.get(type) ?? {}));
  }),
}));

const { encryptString } = await import('../services/tokenCrypto.js');
const { ensureFreshPostHogToken, resetPostHogOAuthInflightForTests } = await import('../services/posthogOAuth/core.js');
const { resetPostHogOAuthConfigForTests } = await import('../services/posthogCode/oauthConfig.js');

const HOST = 'https://us.posthog.com';

describe('PostHog OAuth refresh lock', () => {
  const prior = { key: process.env.TALYN_TOKEN_KEY, id: process.env.POSTHOG_OAUTH_CLIENT_ID, uri: process.env.POSTHOG_OAUTH_REDIRECT_URI };
  let tokenCalls: number;

  beforeEach(() => {
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    process.env.POSTHOG_OAUTH_CLIENT_ID = 'https://www.talyn.dev/oauth-client';
    process.env.POSTHOG_OAUTH_REDIRECT_URI = 'https://prod.talyn.dev/api/v1/posthog/oauth/callback';
    resetPostHogOAuthConfigForTests();
    resetPostHogOAuthInflightForTests();
    rows.clear();
    locks.length = 0;
    tokenCalls = 0;
    vi.stubGlobal('fetch', async () => {
      tokenCalls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return new Response(JSON.stringify({ access_token: `pha_${tokenCalls}`, refresh_token: `phr_${tokenCalls}`, expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [name, value] of [['TALYN_TOKEN_KEY', prior.key], ['POSTHOG_OAUTH_CLIENT_ID', prior.id], ['POSTHOG_OAUTH_REDIRECT_URI', prior.uri]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetPostHogOAuthConfigForTests();
    resetPostHogOAuthInflightForTests();
  });

  function expired(): PostHogIntegrationConfig {
    return {
      projectId: '1',
      host: HOST,
      authMethod: 'oauth',
      oauth: {
        accessTokenEnc: encryptString('pha_old'),
        refreshTokenEnc: encryptString('phr_old'),
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        clientId: 'c',
      },
    };
  }

  it.each([
    ['posthog', ['posthog-oauth-refresh:ws1']],
    ['posthog_inbox', ['posthog-inbox-oauth-refresh:ws1']],
  ] as const)('refreshes the %s row inside its own lock, once for many callers', async (type, expected) => {
    rows.set(type, expired());
    const tokens = await Promise.all([1, 2, 3].map(() => ensureFreshPostHogToken(type, 'ws1')));
    expect(new Set(tokens)).toEqual(new Set(['pha_1']));
    expect(tokenCalls).toBe(1);
    expect(locks).toEqual(expected);
  });

  it('locks the two rows of one workspace apart', async () => {
    rows.set('posthog', expired());
    rows.set('posthog_inbox', expired());
    await Promise.all([ensureFreshPostHogToken('posthog', 'ws1'), ensureFreshPostHogToken('posthog_inbox', 'ws1')]);
    expect(tokenCalls).toBe(2);
    expect([...locks].sort()).toEqual(['posthog-inbox-oauth-refresh:ws1', 'posthog-oauth-refresh:ws1']);
  });

  it('takes no lock for a token with life left', async () => {
    rows.set('posthog_inbox', { ...expired(), oauth: { ...expired().oauth!, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
    expect(await ensureFreshPostHogToken('posthog_inbox', 'ws1')).toBe('pha_old');
    expect(locks).toEqual([]);
    expect(tokenCalls).toBe(0);
  });

  it('skips the refresh when another replica rotated the token while it waited', async () => {
    rows.set('posthog_inbox', expired());
    const { withBlockingAdvisoryLock } = await import('../services/advisoryLock.js');
    vi.mocked(withBlockingAdvisoryLock).mockImplementationOnce(async (_db, key, fn) => {
      locks.push(key);
      // The other replica held the lock and stored a fresh pair first.
      rows.set('posthog_inbox', { ...expired(), oauth: { ...expired().oauth!, accessTokenEnc: encryptString('pha_other'), expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
      return fn();
    });
    expect(await ensureFreshPostHogToken('posthog_inbox', 'ws1')).toBe('pha_other');
    expect(tokenCalls).toBe(0);
  });
});

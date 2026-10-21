import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import { fleetAccounts, workspaces as workspacesTable } from '../db/schema.js';

/**
 * Choosing which of an agent's accounts a run uses, by usage.
 *
 * The rule: the first account in priority order that is not OVER. Over means a
 * window that applies to the run is at or past the workspace's threshold, a
 * confirmed exhaustion still holding it, or a grant that needs a reconnect.
 * Unknown usage is not over. Every account over is null, and the caller's
 * cross-vendor rules take it from there.
 */

const fetchWithTimeout = vi.hoisted(() => vi.fn());
vi.mock('../services/httpTimeout.js', () => ({ fetchWithTimeout }));

const lock = vi.hoisted(() => ({ realPg: false, acquired: true }));
vi.mock('../db/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/client.js')>();
  return { ...actual, isRealPostgres: () => lock.realPg };
});
vi.mock('../services/advisoryLock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/advisoryLock.js')>();
  return {
    ...actual,
    tryWithAdvisoryLock: vi.fn(async (_db: unknown, _name: string, fn: () => Promise<unknown>) =>
      lock.acquired ? { acquired: true, result: await fn() } : { acquired: false },
    ),
  };
});

const accounts = await import('../services/selfHosted/accounts.js');
const selection = await import('../services/selfHosted/accountSelection.js');
const { getSelfHostedCredentials } = await import('../services/selfHosted/credentials.js');
const { encryptString } = await import('../services/tokenCrypto.js');
const { _resetClaudeOauthInflight } = await import('../services/selfHosted/claudeOauth.js');

type Kind = import('../services/selfHosted/accounts.js').FleetAccountKind;
type Usage = import('../services/selfHosted/accounts.js').FleetAccountUsage;
type Window = import('../services/selfHosted/accounts.js').FleetUsageWindow;

const WS = 'ws1';
const usageFetch = vi.fn<typeof fetch>();

function oauthCredential(token: string, expiresInMs = 3_600_000) {
  return {
    accessTokenEnc: encryptString(token),
    refreshTokenEnc: encryptString(`refresh-${token}`),
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  };
}

function credentialFor(kind: Kind, value: string) {
  if (kind === 'claude_oauth') return oauthCredential(value);
  if (kind === 'codex_oauth') return { ...oauthCredential(value), accountId: 'chatgpt-1' };
  return { keyEnc: encryptString(value) };
}

function win(usedPercent: number, extra: Partial<Window> = {}): Window {
  return { key: 'session', label: '5-hour', usedPercent, resetsAt: null, ...extra };
}

function fresh(windows: Window[]): Usage {
  return { fetchedAt: new Date().toISOString(), windows };
}

function stale(windows: Window[]): Usage {
  return { fetchedAt: new Date(Date.now() - 10 * 60_000).toISOString(), windows };
}

function claudeUsageResponse(percent: number): Response {
  return new Response(
    JSON.stringify({ limits: [{ kind: 'session', group: 'session', percent, resets_at: null, scope: null }] }),
    { status: 200 },
  );
}

describe('choosing a fleet account by usage', () => {
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
    await db.insert(workspacesTable).values({ id: WS, ownerId: TEST_USER_ID, name: 'ws', settings: {} });
    fetchWithTimeout.mockReset();
    usageFetch.mockReset();
    selection.setUsageFetchForTests(usageFetch);
    _resetClaudeOauthInflight();
    lock.realPg = false;
    lock.acquired = true;
  });
  afterEach(async () => {
    selection.setUsageFetchForTests(undefined);
    await cleanup();
  });

  async function setThreshold(value: unknown) {
    await db
      .update(workspacesTable)
      .set({ settings: { fleetSwitchAtPercent: value } as never })
      .where(eq(workspacesTable.id, WS));
  }

  async function add(kind: Kind, label: string, usage?: Usage) {
    const account = await accounts.addFleetAccount(WS, {
      kind,
      credential: credentialFor(kind, `tok-${label}`),
      label,
    });
    if (usage) await accounts.setFleetAccountUsage(account.id, usage);
    return account;
  }

  describe('accountOverVerdict', () => {
    const base = { reauthRequiredAt: null, quotaExhausted: null } as const;

    it.each([
      [99, 100, null],
      [100, 100, 'usage'],
      [101, 100, 'usage'],
      [94, 95, null],
      [95, 95, 'usage'],
      [99.5, 95, 'usage'],
      [0, 50, null],
      [50, 50, 'usage'],
    ] as const)('%s%% used against a %s%% threshold is %s', (used, threshold, expected) => {
      const verdict = selection.accountOverVerdict({ ...base, usage: fresh([win(used)]) }, threshold);
      expect(verdict.reason).toBe(expected);
    });

    it.each([
      ['an Opus run', 'claude-opus-5-5', 'usage'],
      ['a Sonnet run', 'claude-sonnet-5-5', null],
      ['a run with no model named', undefined, 'usage'],
      ['a model matched by its catalogue label', 'claude-opus-4-8', 'usage'],
    ] as const)('an Opus-scoped window at 100%% counts for %s: %s', (_label, model, expected) => {
      const usage = fresh([win(10), win(100, { key: 'weekly_scoped:opus', label: 'Weekly (Opus)', scopeModel: 'Opus' })]);
      expect(selection.accountOverVerdict({ ...base, usage }, 100, model).reason).toBe(expected);
    });

    it('names the fullest window that put it over', () => {
      const usage = fresh([win(96), win(98, { key: 'weekly_all', label: 'Weekly' })]);
      const verdict = selection.accountOverVerdict({ ...base, usage }, 95);
      expect(verdict.window?.label).toBe('Weekly');
    });

    it.each([
      ['an error snapshot', { fetchedAt: new Date().toISOString(), error: 'boom' } as Usage],
      ['no snapshot', null],
      ['an empty window list', fresh([])],
    ])('reads %s as not over', (_label, usage) => {
      expect(selection.accountOverVerdict({ ...base, usage }, 50).reason).toBeNull();
    });

    it('is over when the grant needs a reconnect, whatever the usage says', () => {
      const verdict = selection.accountOverVerdict(
        { ...base, reauthRequiredAt: new Date().toISOString(), usage: fresh([win(1)]) },
        100,
      );
      expect(verdict.reason).toBe('reauth');
    });

    it.each([
      ['a hold seen a minute ago', 60_000, 'held'],
      ['a hold that has lapsed', 60 * 60_000, null],
    ] as const)('%s → %s', (_label, ageMs, expected) => {
      const verdict = selection.accountOverVerdict(
        { ...base, quotaExhausted: { at: new Date(Date.now() - ageMs).toISOString() }, usage: fresh([win(1)]) },
        100,
      );
      expect(verdict.reason).toBe(expected);
    });
  });

  describe('fleetSwitchThreshold', () => {
    it.each([
      [95, 95],
      [50, 50],
      [100, 100],
      [30, 100],
      ['95', 100],
      [95.5, 100],
      [undefined, 100],
    ])('a stored %s reads as %s', async (stored, expected) => {
      if (stored !== undefined) await setThreshold(stored);
      expect(await selection.fleetSwitchThreshold(WS)).toBe(expected);
    });
  });

  describe('chooseFleetAccount', () => {
    it.each([
      [100, 'A'],
      [97, 'A'],
      [96, 'B'],
      [95, 'B'],
    ])('with A at 96%% and a %s%% threshold, picks %s', async (threshold, expected) => {
      await setThreshold(threshold);
      await add('claude_oauth', 'A', fresh([win(96)]));
      await add('claude_oauth', 'B', fresh([win(10)]));
      expect((await selection.chooseFleetAccount(WS, 'claude'))?.label).toBe(expected);
    });

    it('returns null when every account is over', async () => {
      await setThreshold(95);
      await add('claude_oauth', 'A', fresh([win(99)]));
      await add('claude_oauth', 'B', fresh([win(95)]));
      expect(await selection.chooseFleetAccount(WS, 'claude')).toBeNull();
    });

    it('names the least-bad account as the fallback when every one is over only by usage', async () => {
      await setThreshold(95);
      const a = await add('claude_oauth', 'A', fresh([win(99)]));
      await accounts.setFleetAccountReauth(a.id);
      await add('claude_oauth', 'B', fresh([win(97)]));
      const picked = await selection.selectFleetAccount(WS, 'claude');
      expect(picked.account).toBeNull();
      expect(picked.fallback?.label).toBe('B');
    });

    it('never picks an account of the other agent', async () => {
      await add('codex_oauth', 'C', fresh([win(1)]));
      await add('claude_oauth', 'A', fresh([win(100)]));
      expect(await selection.chooseFleetAccount(WS, 'claude')).toBeNull();
      expect((await selection.chooseFleetAccount(WS, 'codex'))?.label).toBe('C');
    });

    it('treats a pasted key as never over by usage', async () => {
      await add('claude_oauth', 'A', fresh([win(100)]));
      await add('anthropic_key', 'Key');
      expect((await selection.chooseFleetAccount(WS, 'claude'))?.label).toBe('Key');
    });

    it('skips an avoided account and honours a preferred one', async () => {
      const a = await add('claude_oauth', 'A', fresh([win(1)]));
      const b = await add('claude_oauth', 'B', fresh([win(1)]));
      await add('claude_oauth', 'C', fresh([win(1)]));
      expect((await selection.chooseFleetAccount(WS, 'claude', { avoidAccountIds: [a.id] }))?.label).toBe('B');
      expect((await selection.chooseFleetAccount(WS, 'claude', { preferAccountId: b.id }))?.label).toBe('B');
      expect(
        (await selection.chooseFleetAccount(WS, 'claude', { avoidAccountIds: [a.id, b.id] }))?.label,
      ).toBe('C');
    });

    it('applies a model-scoped window only to a run of that model', async () => {
      const opusFull = fresh([win(10), win(100, { key: 'weekly_scoped:opus', label: 'Weekly (Opus)', scopeModel: 'Opus' })]);
      await add('claude_oauth', 'A', opusFull);
      await add('claude_oauth', 'B', fresh([win(10)]));
      expect((await selection.chooseFleetAccount(WS, 'claude', { model: 'claude-sonnet-5-5' }))?.label).toBe('A');
      expect((await selection.chooseFleetAccount(WS, 'claude', { model: 'claude-opus-5-5' }))?.label).toBe('B');
    });
  });

  describe('reading usage when the snapshot is stale', () => {
    it('reads the vendor, stores the snapshot and decides on it', async () => {
      await setThreshold(95);
      const a = await add('claude_oauth', 'A', stale([win(10)]));
      await add('claude_oauth', 'B', fresh([win(10)]));
      usageFetch.mockResolvedValue(claudeUsageResponse(97));

      expect((await selection.chooseFleetAccount(WS, 'claude'))?.label).toBe('B');
      expect(usageFetch).toHaveBeenCalledTimes(1);
      const [url, init] = usageFetch.mock.calls[0]!;
      expect(String(url)).toContain('/api/oauth/usage');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok-A');
      const stored = await accounts.getFleetAccount(a.id);
      expect(stored?.usage && 'windows' in stored.usage ? stored.usage.windows[0]?.usedPercent : null).toBe(97);
    });

    it('does not read a fresh snapshot again', async () => {
      await add('claude_oauth', 'A', fresh([win(10)]));
      await selection.chooseFleetAccount(WS, 'claude');
      expect(usageFetch).not.toHaveBeenCalled();
    });

    it('reads only up to the account it chooses', async () => {
      await add('claude_oauth', 'A', stale([win(10)]));
      await add('claude_oauth', 'B', stale([win(10)]));
      usageFetch.mockResolvedValue(claudeUsageResponse(5));
      expect((await selection.chooseFleetAccount(WS, 'claude'))?.label).toBe('A');
      expect(usageFetch).toHaveBeenCalledTimes(1);
    });

    it('uses the stale snapshot when another instance holds the lock', async () => {
      lock.realPg = true;
      lock.acquired = false;
      await setThreshold(95);
      await add('claude_oauth', 'A', stale([win(10)]));
      usageFetch.mockResolvedValue(claudeUsageResponse(99));
      expect((await selection.chooseFleetAccount(WS, 'claude'))?.label).toBe('A');
      expect(usageFetch).not.toHaveBeenCalled();
    });

    it('reads the usage under the lock when it is free', async () => {
      lock.realPg = true;
      await setThreshold(95);
      await add('claude_oauth', 'A', stale([win(10)]));
      await add('claude_oauth', 'B', fresh([win(10)]));
      usageFetch.mockResolvedValue(claudeUsageResponse(99));
      expect((await selection.chooseFleetAccount(WS, 'claude'))?.label).toBe('B');
      expect(usageFetch).toHaveBeenCalledTimes(1);
    });

    it('stores an endpoint failure as unknown, which is not over', async () => {
      const a = await add('claude_oauth', 'A', stale([win(100)]));
      usageFetch.mockResolvedValue(new Response('nope', { status: 500 }));
      expect((await selection.chooseFleetAccount(WS, 'claude'))?.label).toBe('A');
      const stored = await accounts.getFleetAccount(a.id);
      expect(stored?.usage && 'error' in stored.usage).toBe(true);
    });

    it('refreshes the token once after a 401 token_expired, then reads again', async () => {
      await setThreshold(95);
      await add('claude_oauth', 'A', stale([win(10)]));
      await add('claude_oauth', 'B', fresh([win(10)]));
      usageFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { code: 'token_expired' } }), { status: 401 }),
        )
        .mockResolvedValueOnce(claudeUsageResponse(99));
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        status: 200,
        bodyText: JSON.stringify({ access_token: 'tok-A-new', refresh_token: 'r2', expires_in: 3600 }),
      });

      expect((await selection.chooseFleetAccount(WS, 'claude'))?.label).toBe('B');
      expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
      expect(usageFetch).toHaveBeenCalledTimes(2);
      const second = usageFetch.mock.calls[1]![1]?.headers as Record<string, string>;
      expect(second.authorization).toBe('Bearer tok-A-new');
    });

    it('retries a 401 only once', async () => {
      await add('claude_oauth', 'A', stale([win(10)]));
      usageFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 'token_expired' } }), { status: 401 }),
      );
      fetchWithTimeout.mockResolvedValue({
        ok: true,
        status: 200,
        bodyText: JSON.stringify({ access_token: 'tok-A-new', expires_in: 3600 }),
      });
      expect((await selection.chooseFleetAccount(WS, 'claude'))?.label).toBe('A');
      expect(usageFetch).toHaveBeenCalledTimes(2);
    });

    it('reads a Codex account with its ChatGPT account id', async () => {
      await setThreshold(95);
      await add('codex_oauth', 'C', stale([win(10)]));
      await add('codex_oauth', 'D', fresh([win(10)]));
      usageFetch.mockResolvedValue(
        new Response(
          JSON.stringify({
            rate_limit: { limit_reached: false, primary_window: { used_percent: 96, limit_window_seconds: 18000 } },
          }),
          { status: 200 },
        ),
      );
      expect((await selection.chooseFleetAccount(WS, 'codex'))?.label).toBe('D');
      const headers = usageFetch.mock.calls[0]![1]?.headers as Record<string, string>;
      expect(headers['chatgpt-account-id']).toBe('chatgpt-1');
    });
  });

  describe('the credential seam', () => {
    it('resolves the chosen account and names it', async () => {
      await setThreshold(95);
      await add('claude_oauth', 'A', fresh([win(96)]));
      const b = await add('claude_oauth', 'B', fresh([win(10)]));
      const picked = await selection.selectFleetAccount(WS, 'claude');
      const creds = await getSelfHostedCredentials(
        WS,
        selection.credentialOptionsFor('claude', picked.account!.id, { threshold: picked.threshold }),
      );
      expect(creds).toMatchObject({ claudeToken: 'tok-B', claudeAccountId: b.id });
    });

    it('falls through only to accounts that are not over', async () => {
      await setThreshold(95);
      const a = await add('claude_oauth', 'A', fresh([win(10)]));
      await accounts.setFleetAccountReauth(a.id);
      await add('claude_oauth', 'B', fresh([win(99)]));
      const c = await add('claude_oauth', 'C', fresh([win(10)]));
      // A is preferred but cannot give a token; B is over; C is next.
      const creds = await getSelfHostedCredentials(
        WS,
        selection.credentialOptionsFor('claude', a.id, { threshold: 95 }),
      );
      expect(creds?.claudeAccountId).toBe(c.id);
    });
  });

  describe('resolveRunCredential', () => {
    it('serves the recorded account, even over the threshold', async () => {
      await setThreshold(95);
      const a = await add('claude_oauth', 'A', fresh([win(99)]));
      await add('claude_oauth', 'B', fresh([win(10)]));
      expect(await selection.resolveRunCredential(WS, 'claude', { recordedAccountId: a.id })).toEqual({
        token: 'tok-A',
        accountId: a.id,
      });
    });

    it.each([
      ['was deleted', 'delete'],
      ['needs a reconnect', 'reauth'],
    ] as const)('chooses again when the recorded account %s', async (_label, what) => {
      const a = await add('claude_oauth', 'A', fresh([win(10)]));
      const b = await add('claude_oauth', 'B', fresh([win(10)]));
      if (what === 'delete') await db.delete(fleetAccounts).where(eq(fleetAccounts.id, a.id));
      else await accounts.setFleetAccountReauth(a.id);
      expect(await selection.resolveRunCredential(WS, 'claude', { recordedAccountId: a.id })).toEqual({
        token: 'tok-B',
        accountId: b.id,
      });
    });

    it('moves off an over account at a turn start when another is free', async () => {
      await setThreshold(95);
      const a = await add('claude_oauth', 'A', fresh([win(99)]));
      const b = await add('claude_oauth', 'B', fresh([win(10)]));
      expect(
        await selection.resolveRunCredential(WS, 'claude', { recordedAccountId: a.id, switchWhenOver: true }),
      ).toEqual({ token: 'tok-B', accountId: b.id });
    });

    it('stays on an over account at a turn start when every other one is over too', async () => {
      await setThreshold(95);
      await add('claude_oauth', 'A', fresh([win(98)]));
      const b = await add('claude_oauth', 'B', fresh([win(99)]));
      expect(
        await selection.resolveRunCredential(WS, 'claude', { recordedAccountId: b.id, switchWhenOver: true }),
      ).toEqual({ token: 'tok-B', accountId: b.id });
    });

    it('chooses by usage when nothing is recorded', async () => {
      await setThreshold(95);
      await add('claude_oauth', 'A', fresh([win(99)]));
      const b = await add('claude_oauth', 'B', fresh([win(10)]));
      expect(await selection.resolveRunCredential(WS, 'claude')).toEqual({ token: 'tok-B', accountId: b.id });
    });

    it('never serves the other vendor', async () => {
      await add('codex_oauth', 'C', fresh([win(1)]));
      expect(await selection.resolveRunCredential(WS, 'claude')).toBeNull();
    });
  });

  describe('notes and hops', () => {
    it.each([
      [{ reason: 'usage', window: win(96.4) }, 'Switched to B because A reached 96% of its 5-hour limit.'],
      [
        { reason: 'usage', window: win(100, { label: 'Weekly (Opus)' }) },
        'Switched to B because A reached 100% of its weekly (Opus) limit.',
      ],
      [{ reason: 'held' }, 'Switched to B because A is out of usage.'],
      [{ reason: 'reauth' }, 'Switched to B because A needs to be signed in again.'],
    ] as const)('says why: %j', (verdict, expected) => {
      expect(
        selection.accountSwitchNote({ label: 'A' }, { label: 'B' }, verdict as never),
      ).toBe(expected);
    });

    it.each([
      [['fleet:claude:abc', 'fleet:codex:def', 'fleet:claude', 'posthog_code'], ['abc', 'def']],
      [[], []],
    ])('reads account ids out of %j', (hops, ids) => {
      expect(selection.accountIdsFromHops(hops)).toEqual(ids);
    });

    it('writes an account hop', () => {
      expect(selection.fleetAccountHop('codex', 'x1')).toBe('fleet:codex:x1');
    });
  });
});

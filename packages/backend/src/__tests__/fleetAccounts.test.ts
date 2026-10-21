import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  fleetAccounts,
  integrations as integrationsTable,
  workspaces as workspacesTable,
} from '../db/schema.js';

/**
 * The fleet account store, and the credential resolver on top of it.
 *
 * A workspace may hold several Claude and Codex accounts in a priority order.
 * The store keeps that order honest (append at the end, reorder only as a full
 * list), keeps the credential out of every status read, and keeps holds and
 * reauth per account. The resolver walks the order and says which account it
 * used.
 */

const fetchWithTimeout = vi.hoisted(() => vi.fn());
vi.mock('../services/httpTimeout.js', () => ({ fetchWithTimeout }));

const accounts = await import('../services/selfHosted/accounts.js');
const { getSelfHostedCredentials, fleetAgentStatus, removeSelfHostedCredentials } = await import(
  '../services/selfHosted/credentials.js'
);
const { heldBackAgents, heldBackAccounts, noteExhaustedAccount, clearExhaustedAccount, clearExhaustedAgent } =
  await import('../services/selfHosted/exhaustedQuota.js');
const { encryptString } = await import('../services/tokenCrypto.js');
const { _resetClaudeOauthInflight } = await import('../services/selfHosted/claudeOauth.js');

type Kind = import('../services/selfHosted/accounts.js').FleetAccountKind;

const WS = 'ws1';

function keyCredential(value: string) {
  return { keyEnc: encryptString(value) };
}

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
  return keyCredential(value);
}

describe('fleet accounts', () => {
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
    await db.insert(workspacesTable).values([
      { id: WS, ownerId: TEST_USER_ID, name: 'ws', settings: {} },
      { id: 'ws2', ownerId: TEST_USER_ID, name: 'other', settings: {} },
    ]);
    fetchWithTimeout.mockReset();
    _resetClaudeOauthInflight();
  });
  afterEach(async () => cleanup());

  async function add(kind: Kind, value: string, label?: string, workspaceId = WS) {
    return accounts.addFleetAccount(workspaceId, {
      kind,
      credential: credentialFor(kind, value),
      ...(label ? { label } : {}),
    });
  }

  describe('the store', () => {
    it.each([
      ['claude_oauth', 'claude', 'Claude subscription'],
      ['anthropic_key', 'claude', 'Anthropic API key'],
      ['codex_oauth', 'codex', 'ChatGPT subscription'],
      ['openai_key', 'codex', 'OpenAI API key'],
    ] as const)('adds a %s account to the %s agent with a default label', async (kind, agent, label) => {
      const account = await add(kind, 'v');
      expect(account).toMatchObject({ agent, kind, label, priority: 1, reauthRequiredAt: null });
      expect(account).not.toHaveProperty('credential');
    });

    it('appends each new account at the end of its own agent', async () => {
      await add('claude_oauth', 'a');
      await add('openai_key', 'b');
      await add('anthropic_key', 'c', '  Team key  ');
      await add('claude_oauth', 'd');
      const list = await accounts.listFleetAccounts(WS);
      expect(list.map((a) => [a.agent, a.priority, a.label])).toEqual([
        ['claude', 1, 'Claude subscription'],
        ['claude', 2, 'Team key'],
        ['claude', 3, 'Claude subscription'],
        ['codex', 1, 'OpenAI API key'],
      ]);
      expect((await accounts.listFleetAccounts(WS, 'codex')).map((a) => a.kind)).toEqual(['openai_key']);
    });

    it('never returns a credential from a status read', async () => {
      await add('anthropic_key', 'sk-ant-api-secret');
      const [listed] = await accounts.listFleetAccounts(WS);
      expect(listed).not.toHaveProperty('credential');
      expect(JSON.stringify(listed)).not.toContain('keyEnc');
      expect(await accounts.getFleetAccount(listed!.id)).not.toHaveProperty('credential');
      const full = await accounts.getFleetAccountWithCredential(listed!.id);
      expect(full?.credential).toHaveProperty('keyEnc');
    });

    it('renames, trimming, and refuses an empty name', async () => {
      const a = await add('claude_oauth', 'a');
      expect(await accounts.updateFleetAccountLabel(WS, a.id, ' Work ')).toBe(true);
      expect((await accounts.getFleetAccount(a.id))?.label).toBe('Work');
      await expect(accounts.updateFleetAccountLabel(WS, a.id, '   ')).rejects.toThrow(
        accounts.FleetAccountError,
      );
      // Another workspace's account is not this workspace's to rename.
      expect(await accounts.updateFleetAccountLabel('ws2', a.id, 'Theirs')).toBe(false);
    });

    it('reorders when given every account of the agent', async () => {
      const a = await add('claude_oauth', 'a');
      const b = await add('anthropic_key', 'b');
      const c = await add('claude_oauth', 'c');
      const codex = await add('openai_key', 'x');
      const after = await accounts.reorderFleetAccounts(WS, 'claude', [c.id, a.id, b.id]);
      expect(after.map((x) => [x.id, x.priority])).toEqual([
        [c.id, 1],
        [a.id, 2],
        [b.id, 3],
      ]);
      // The other agent is untouched.
      expect((await accounts.getFleetAccount(codex.id))?.priority).toBe(1);
    });

    it.each([
      ['a partial list', (ids: string[]) => ids.slice(0, 1)],
      ['a duplicate', (ids: string[]) => [ids[0]!, ids[0]!]],
      ['an unknown id', (ids: string[]) => [ids[0]!, 'nope']],
      ['an id of the other agent', (ids: string[], other: string) => [ids[0]!, other]],
      ['an empty list', () => []],
    ])('refuses a reorder with %s', async (_name, build) => {
      const a = await add('claude_oauth', 'a');
      const b = await add('anthropic_key', 'b');
      const codex = await add('openai_key', 'x');
      await expect(
        accounts.reorderFleetAccounts(WS, 'claude', build([a.id, b.id], codex.id)),
      ).rejects.toThrow(accounts.FleetAccountError);
      expect((await accounts.listFleetAccounts(WS, 'claude')).map((x) => x.id)).toEqual([a.id, b.id]);
    });

    it("refuses a reorder naming another workspace's account", async () => {
      const a = await add('claude_oauth', 'a');
      const theirs = await add('claude_oauth', 'z', undefined, 'ws2');
      await expect(accounts.reorderFleetAccounts(WS, 'claude', [theirs.id])).rejects.toThrow(
        accounts.FleetAccountError,
      );
      expect((await accounts.getFleetAccount(a.id))?.priority).toBe(1);
    });

    it('removes one account, only within its workspace', async () => {
      const a = await add('claude_oauth', 'a');
      const b = await add('anthropic_key', 'b');
      expect(await accounts.removeFleetAccount('ws2', a.id)).toBe(false);
      expect(await accounts.removeFleetAccount(WS, a.id)).toBe(true);
      expect((await accounts.listFleetAccounts(WS)).map((x) => x.id)).toEqual([b.id]);
      expect(await accounts.removeFleetAccount(WS, a.id)).toBe(false);
    });

    it('does not adopt a removed account back from its legacy config key', async () => {
      await db.insert(integrationsTable).values({
        id: 'int1',
        workspaceId: WS,
        type: 'selfhosted',
        enabled: true,
        config: { anthropicKeyEnc: encryptString('sk-ant-api-legacy') },
      });
      const [adopted] = await accounts.listFleetAccounts(WS);
      expect(adopted?.kind).toBe('anthropic_key');
      await accounts.removeFleetAccount(WS, adopted!.id);
      expect(await accounts.listFleetAccounts(WS)).toEqual([]);
    });

    it('stores a usage snapshot and leaves the credential alone', async () => {
      const a = await add('claude_oauth', 'tok');
      const usage = {
        fetchedAt: '2026-10-21T10:00:00.000Z',
        windows: [
          { key: 'session', label: 'Session', usedPercent: 9, resetsAt: null },
          { key: 'weekly_scoped', label: 'Weekly', usedPercent: 3, resetsAt: null, scopeModel: 'Opus' },
        ],
      };
      await accounts.setFleetAccountUsage(a.id, usage);
      expect((await accounts.getFleetAccount(a.id))?.usage).toEqual(usage);
      await accounts.setFleetAccountUsage(a.id, { fetchedAt: usage.fetchedAt, error: 'HTTP 500' });
      expect((await accounts.getFleetAccount(a.id))?.usage).toEqual({
        fetchedAt: usage.fetchedAt,
        error: 'HTTP 500',
      });
      const full = await accounts.getFleetAccountWithCredential(a.id);
      expect(full?.credential).toHaveProperty('accessTokenEnc');
    });

    it('sets and clears reauth per account, and a new credential clears it', async () => {
      const a = await add('claude_oauth', 'a');
      const b = await add('claude_oauth', 'b');
      await accounts.setFleetAccountReauth(a.id);
      expect((await accounts.getFleetAccount(a.id))?.reauthRequiredAt).not.toBeNull();
      expect((await accounts.getFleetAccount(b.id))?.reauthRequiredAt).toBeNull();
      await accounts.clearFleetAccountReauth(a.id);
      expect((await accounts.getFleetAccount(a.id))?.reauthRequiredAt).toBeNull();

      await accounts.setFleetAccountReauth(a.id);
      await accounts.updateFleetAccountCredential(a.id, oauthCredential('again'));
      expect((await accounts.getFleetAccount(a.id))?.reauthRequiredAt).toBeNull();
    });

    // The compat save works by KIND: a key pasted beside a sign-in must not
    // cost the workspace the sign-in, and a sign-in still wins over a key.
    it.each([
      ['Claude sign-in, then key', 'claude', ['claude_oauth', 'anthropic_key'], ['claude_oauth', 'anthropic_key']],
      ['Claude key, then sign-in', 'claude', ['anthropic_key', 'claude_oauth'], ['claude_oauth', 'anthropic_key']],
      ['Codex sign-in, then key', 'codex', ['codex_oauth', 'openai_key'], ['codex_oauth', 'openai_key']],
      ['Codex key, then sign-in', 'codex', ['openai_key', 'codex_oauth'], ['codex_oauth', 'openai_key']],
    ] as const)('%s keeps both, sign-in first', async (_name, agent, saves, expected) => {
      for (const kind of saves) {
        await accounts.upsertPrimaryFleetAccount(WS, kind, credentialFor(kind, kind));
      }
      const list = await accounts.listFleetAccounts(WS, agent);
      expect(list.map((a) => [a.kind, a.priority])).toEqual(expected.map((k, i) => [k, i + 1]));
    });

    it('a sign-in with no account of its kind goes ahead of added accounts', async () => {
      const keyA = await add('anthropic_key', 'a', 'Key A');
      const keyB = await add('anthropic_key', 'b', 'Key B');
      const oauth = await accounts.upsertPrimaryFleetAccount(WS, 'claude_oauth', oauthCredential('o'));
      expect((await accounts.listFleetAccounts(WS)).map((a) => [a.id, a.priority])).toEqual([
        [oauth.id, 1],
        [keyA.id, 2],
        [keyB.id, 3],
      ]);
    });

    it.each(['claude_oauth', 'anthropic_key', 'codex_oauth', 'openai_key'] as const)(
      'saving %s again replaces the first account of that kind in place',
      async (kind) => {
        const first = await add(kind, 'old', 'Mine');
        const second = await add(kind, 'second');
        await accounts.setFleetAccountReauth(first.id);
        const written = await accounts.upsertPrimaryFleetAccount(WS, kind, credentialFor(kind, 'new'));
        expect(written).toMatchObject({ id: first.id, label: 'Mine', priority: 1, reauthRequiredAt: null });
        const full = await accounts.getFleetAccountWithCredential(first.id);
        const { decryptString } = await import('../services/tokenCrypto.js');
        const env = 'keyEnc' in full!.credential ? full!.credential.keyEnc : full!.credential.accessTokenEnc;
        expect(decryptString(env)).toBe('new');
        expect((await accounts.getFleetAccount(second.id))?.priority).toBe(2);
        expect(await accounts.listFleetAccounts(WS)).toHaveLength(2);
      },
    );

    it('picks the first account the filter accepts, preferring a named one', () => {
      const mk = (id: string, priority: number) =>
        ({ id, priority, createdAt: '2026-10-21T00:00:00.000Z' }) as never;
      const list = [mk('c', 3), mk('a', 1), mk('b', 2)];
      expect(accounts.pickAccount(list)?.id).toBe('a');
      expect(accounts.pickAccount(list, (x) => x.id !== 'a')?.id).toBe('b');
      expect(accounts.pickAccount(list, () => false)).toBeNull();
      expect(accounts.orderFleetAccounts(list, { preferId: 'c' }).map((x) => x.id)).toEqual(['c', 'a', 'b']);
      // A preferred account the filter refuses is not tried at all.
      expect(
        accounts.orderFleetAccounts(list, { preferId: 'c', usable: (x) => x.id !== 'c' }).map((x) => x.id),
      ).toEqual(['a', 'b']);
    });
  });

  describe('resolving credentials', () => {
    it('uses each agent’s first account and says which', async () => {
      const claude = await add('anthropic_key', 'sk-ant-api-one');
      await add('anthropic_key', 'sk-ant-api-two');
      const codex = await add('openai_key', 'sk-openai-one');
      expect(await getSelfHostedCredentials(WS)).toEqual({
        claudeToken: 'sk-ant-api-one',
        claudeAccountId: claude.id,
        openaiKey: 'sk-openai-one',
        codexAccountId: codex.id,
      });
    });

    it('tries a named account first', async () => {
      await add('anthropic_key', 'sk-ant-api-one');
      const second = await add('anthropic_key', 'sk-ant-api-two');
      const creds = await getSelfHostedCredentials(WS, { claudeAccountId: second.id });
      expect(creds).toMatchObject({ claudeToken: 'sk-ant-api-two', claudeAccountId: second.id });
    });

    it('falls back to the order when the named account is gone', async () => {
      const first = await add('anthropic_key', 'sk-ant-api-one');
      const creds = await getSelfHostedCredentials(WS, { claudeAccountId: 'removed' });
      expect(creds?.claudeAccountId).toBe(first.id);
    });

    it('falls through an account that needs reauth to the next one', async () => {
      const dead = await add('claude_oauth', 'sk-ant-oat01-dead');
      const key = await add('anthropic_key', 'sk-ant-api-backup');
      await accounts.setFleetAccountReauth(dead.id);
      const creds = await getSelfHostedCredentials(WS);
      expect(creds).toMatchObject({ claudeToken: 'sk-ant-api-backup', claudeAccountId: key.id });
      expect(fetchWithTimeout).not.toHaveBeenCalled();
    });

    it('applies the account filter, and an all-refused agent has no token', async () => {
      const a = await add('anthropic_key', 'sk-ant-api-one');
      const b = await add('anthropic_key', 'sk-ant-api-two');
      await add('openai_key', 'sk-openai');
      const skipFirst = await getSelfHostedCredentials(WS, { accountFilter: (x) => x.id !== a.id });
      expect(skipFirst?.claudeAccountId).toBe(b.id);
      const noClaude = await getSelfHostedCredentials(WS, { accountFilter: (x) => x.agent === 'codex' });
      expect(noClaude).not.toHaveProperty('claudeToken');
      expect(noClaude?.openaiKey).toBe('sk-openai');
    });

    it('marks only the account whose grant was rejected, and moves on', async () => {
      const expiring = await accounts.addFleetAccount(WS, {
        kind: 'claude_oauth',
        credential: oauthCredential('sk-ant-oat01-old', -60_000),
      });
      const key = await add('anthropic_key', 'sk-ant-api-backup');
      fetchWithTimeout.mockResolvedValue({
        ok: false,
        status: 400,
        bodyText: JSON.stringify({ error: 'invalid_grant' }),
      });
      const creds = await getSelfHostedCredentials(WS);
      expect(creds?.claudeAccountId).toBe(key.id);
      expect((await accounts.getFleetAccount(expiring.id))?.reauthRequiredAt).not.toBeNull();
      expect((await accounts.getFleetAccount(key.id))?.reauthRequiredAt).toBeNull();
    });

    it('throws when no account gives a token and one of them failed', async () => {
      await accounts.addFleetAccount(WS, {
        kind: 'claude_oauth',
        credential: oauthCredential('sk-ant-oat01-old', -60_000),
      });
      fetchWithTimeout.mockResolvedValue({ ok: false, status: 503, bodyText: 'down' });
      await expect(getSelfHostedCredentials(WS)).rejects.toThrow();
    });

    it('is null when the integration row is switched off', async () => {
      await add('anthropic_key', 'sk-ant-api-one');
      await db.insert(integrationsTable).values({
        id: 'int1',
        workspaceId: WS,
        type: 'selfhosted',
        enabled: false,
        config: {},
      });
      expect(await getSelfHostedCredentials(WS)).toBeNull();
      expect(await fleetAgentStatus(WS)).toEqual({ connectedAgents: [], reauthAgents: [] });
    });

    it('removing the fleet removes every account and the row', async () => {
      await add('anthropic_key', 'sk-ant-api-one');
      await add('openai_key', 'sk-openai');
      await add('openai_key', 'keep', undefined, 'ws2');
      await removeSelfHostedCredentials(WS);
      expect(await accounts.listFleetAccounts(WS)).toEqual([]);
      expect(await accounts.listFleetAccounts('ws2')).toHaveLength(1);
    });
  });

  describe('agent status', () => {
    it.each([
      ['no accounts', [], { connectedAgents: [], reauthAgents: [] }],
      ['one live account', [['claude_oauth', false]], { connectedAgents: ['claude'], reauthAgents: [] }],
      ['one dead account', [['claude_oauth', true]], { connectedAgents: ['claude'], reauthAgents: ['claude'] }],
      [
        'one dead of two',
        [['claude_oauth', true], ['claude_oauth', false]],
        { connectedAgents: ['claude'], reauthAgents: [] },
      ],
      [
        'every Codex account dead',
        [['codex_oauth', true], ['codex_oauth', true], ['anthropic_key', false]],
        { connectedAgents: ['claude', 'codex'], reauthAgents: ['codex'] },
      ],
    ] as const)('%s', async (_name, setup, expected) => {
      for (const [kind, dead] of setup) {
        const a = await add(kind, 'v');
        if (dead) await accounts.setFleetAccountReauth(a.id);
      }
      expect(await fleetAgentStatus(WS)).toEqual(expected);
    });
  });

  describe('quota holds', () => {
    it('holds one account without holding the agent', async () => {
      const a = await add('claude_oauth', 'a');
      const b = await add('anthropic_key', 'b');
      await noteExhaustedAccount(a.id, "You're out of extra usage.");
      expect(Object.keys(await heldBackAccounts(WS))).toEqual([a.id]);
      expect(await heldBackAgents(WS)).toEqual({});

      await noteExhaustedAccount(b.id, 'credit balance is too low');
      const held = await heldBackAgents(WS);
      expect(Object.keys(held)).toEqual(['claude']);

      await clearExhaustedAccount(a.id);
      expect(await heldBackAgents(WS)).toEqual({});
      expect(Object.keys(await heldBackAccounts(WS))).toEqual([b.id]);
    });

    it('reports the hold that lapses first as the agent’s', async () => {
      const a = await add('openai_key', 'a');
      const b = await add('openai_key', 'b');
      const now = Date.now();
      await accounts.setFleetAccountExhausted({ accountId: a.id }, { at: new Date(now - 60_000).toISOString() });
      await accounts.setFleetAccountExhausted({ accountId: b.id }, { at: new Date(now - 10_000).toISOString() });
      const held = await heldBackAgents(WS);
      expect(held.codex?.at).toBe(new Date(now - 60_000).toISOString());
    });

    it('a lapsed hold does not hold its account', async () => {
      const a = await add('claude_oauth', 'a');
      await accounts.setFleetAccountExhausted(
        { accountId: a.id },
        { at: new Date(Date.now() - 6 * 60_000).toISOString() },
      );
      expect(await heldBackAccounts(WS)).toEqual({});
      expect(await heldBackAgents(WS)).toEqual({});
    });

    it('the agent-wide clear clears every account of that agent only', async () => {
      const a = await add('claude_oauth', 'a');
      const b = await add('anthropic_key', 'b');
      const c = await add('openai_key', 'c');
      for (const id of [a.id, b.id, c.id]) await noteExhaustedAccount(id, null);
      await clearExhaustedAgent(WS, 'claude');
      expect(Object.keys(await heldBackAccounts(WS))).toEqual([c.id]);
      const rows = await db
        .select({ id: fleetAccounts.id, hold: fleetAccounts.quotaExhausted })
        .from(fleetAccounts)
        .where(eq(fleetAccounts.workspaceId, WS));
      expect(rows.filter((r) => r.hold).map((r) => r.id)).toEqual([c.id]);
    });
  });
});

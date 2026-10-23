import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { and, eq, sql } from 'drizzle-orm';
import type { Environment, Task } from '@talyn/shared';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  environments as environmentsTable,
  integrations as integrationsTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
  workspaces as workspacesTable,
} from '../db/schema.js';

/**
 * A desktop, web or CLI build from before fleet accounts, against this backend.
 *
 * Old clients send the single-credential bodies (`claudeToken`, a Codex
 * sign-in, `openaiKey`, `clearClaude`, `clearCodex`) and read the old
 * `CloudProviderInfo`. A workspace that never opens the new accounts screen
 * must dispatch exactly as before, on the credential migration 0079 copied
 * into `fleet_accounts`. And because the legacy config keys are mirrored from
 * the accounts, a backend from before 0079 still finds working credentials
 * after a rollback.
 */

const fleet = vi.hoisted(() => ({
  createSandbox: vi.fn(),
  getSandbox: vi.fn(),
  getEvents: vi.fn(),
  setSandboxCredentials: vi.fn(),
  listGatewaySandboxes: vi.fn(),
  ping: vi.fn(),
}));

vi.mock('../services/selfHosted/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/selfHosted/client.js')>();
  return {
    ...actual,
    FleetClient: class {
      createSandbox = fleet.createSandbox;
      getSandbox = fleet.getSandbox;
      getEvents = fleet.getEvents;
      setSandboxCredentials = fleet.setSandboxCredentials;
      listGatewaySandboxes = fleet.listGatewaySandboxes;
      ping = fleet.ping;
    },
  };
});
vi.mock('../services/cloudProviders/fleetAccess.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  workspaceMayUseFleet: async () => true,
  fleetRefusalReason: () => 'fleet off',
}));
const exchangeCode = vi.hoisted(() => vi.fn());
vi.mock('../services/selfHosted/claudeOauth.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  exchangeCode,
}));
vi.mock('../services/github.js', () => ({
  githubService: { getVerifiedAccessToken: vi.fn(async () => 'gho_token') },
}));
vi.mock('../services/repoDefaultBranch.js', () => ({
  reconcileDefaultBranch: vi.fn(async () => 'main'),
}));
vi.mock('../services/mcpServers/dispatch.js', () => ({
  mcpIntegrationSecrets: vi.fn(async () => ({})),
  mcpServerIdsFromMetadata: vi.fn(() => null),
}));
vi.mock('../services/httpTimeout.js', () => ({ fetchWithTimeout: vi.fn() }));

const { cloudProviderRoutes } = await import('../routes/cloudProviders.js');
const { developerRoutes } = await import('../routes/developer.js');
const { apiErrorHandler } = await import('../routes/index.js');
const { wrapAsyncRoutes } = await import('../middleware/asyncHandler.js');
const { requireAuth, internalProxyHeaders } = await import('../middleware/auth.js');
const { registerCloudProvider } = await import('../services/cloudProviders/registry.js');
const { selfHostedProvider } = await import('../services/cloudProviders/selfhosted/provider.js');
const accounts = await import('../services/selfHosted/accounts.js');
const { dispatchTaskToFleet } = await import('../services/selfHosted/executor.js');
const { selfHostedPoller } = await import('../services/selfHosted/poller.js');
const { resolveRunCredentials } = await import('../services/selfHosted/runCredentials.js');
const { setUsageFetchForTests } = await import('../services/selfHosted/accountSelection.js');
const { resetHotSwapChecksForTests } = await import('../services/selfHosted/hotSwap.js');
const { drainTaskMetadata } = await import('../services/taskMetadataMutex.js');
const { decryptString, encryptString } = await import('../services/tokenCrypto.js');

type Kind = import('../services/selfHosted/accounts.js').FleetAccountKind;
type Envelope = ReturnType<typeof encryptString>;
type CloudTaskRow = import('../services/cloudProviders/types.js').CloudTaskRow;

const WS = 'ws-legacy';
const ENV = { id: 'fleet1', type: 'selfhosted', config: {} } as unknown as Environment;
const MIGRATION_0079 = fileURLToPath(new URL('../db/migrations/0079_fleet_accounts.sql', import.meta.url));

/** A Codex access token with the ChatGPT account claim `codexCredentialFrom` reads. */
function codexJwt(value: string): string {
  const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: 'chatgpt-1' }, value };
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

function oauthCredential(access: string, refresh = `r-${access}`) {
  return {
    accessTokenEnc: encryptString(access),
    refreshTokenEnc: encryptString(refresh),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
}

/** Each legacy config key, the token it holds, and the agent and model that run it. */
const LEGACY: Record<Kind, { configKey: string; agent: 'claude' | 'codex'; model: string; token: string; bodyKey: 'anthropicKey' | 'openaiKey'; value: () => unknown }> = {
  claude_oauth: {
    configKey: 'claudeOAuth', agent: 'claude', model: 'claude-sonnet-5', token: 'sk-ant-oat01-legacy', bodyKey: 'anthropicKey',
    value: () => oauthCredential('sk-ant-oat01-legacy'),
  },
  anthropic_key: {
    configKey: 'anthropicKeyEnc', agent: 'claude', model: 'claude-sonnet-5', token: 'sk-ant-api03-legacy', bodyKey: 'anthropicKey',
    value: () => encryptString('sk-ant-api03-legacy'),
  },
  codex_oauth: {
    configKey: 'codexOAuth', agent: 'codex', model: 'gpt-5.6-sol', token: codexJwt('legacy'), bodyKey: 'openaiKey',
    value: () => ({ ...oauthCredential(codexJwt('legacy')), accountId: 'chatgpt-1' }),
  },
  openai_key: {
    configKey: 'openaiKeyEnc', agent: 'codex', model: 'gpt-5.6-sol', token: 'sk-proj-legacy', bodyKey: 'openaiKey',
    value: () => encryptString('sk-proj-legacy'),
  },
};

describe('fleet accounts: old clients, old data and rollback', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let server: Server;
  let base: string;
  const saved: Record<string, string | undefined> = {};
  const envKeys = ['TALYN_TOKEN_KEY', 'FLEET_API_TOKEN', 'FLEET_GATEWAY_TOKEN', 'FLEET_PINNED_ENDPOINT', 'FLEET_MULTI_ACCOUNT_ENABLED'];

  beforeAll(() => {
    for (const k of envKeys) saved[k] = process.env[k];
    process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
    process.env.FLEET_API_TOKEN = 'fleet-token';
    process.env.FLEET_GATEWAY_TOKEN = 'gateway-token';
    process.env.FLEET_PINNED_ENDPOINT = 'https://fleet.test';
    registerCloudProvider(selfHostedProvider);
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({ id: WS, ownerId: TEST_USER_ID, name: 'ws', settings: {} });
    await db.insert(environmentsTable).values({
      id: 'fleet1', ownerId: TEST_USER_ID, name: 'Talyn Fleet', type: 'selfhosted', status: 'connected',
      config: { type: 'selfhosted' },
    });
    await db.insert(repositoriesTable).values({
      id: 'repo1', workspaceId: WS, name: 'acme/widgets', url: 'https://github.com/acme/widgets', defaultBranch: 'main',
    });
    for (const f of Object.values(fleet)) f.mockReset();
    fleet.listGatewaySandboxes.mockResolvedValue([]);
    fleet.ping.mockResolvedValue(undefined);
    fleet.createSandbox.mockImplementation(async (input: { id: string }) => ({
      sandbox: { id: input.id, status: 'starting', workspaceId: WS },
      host: 'host-1',
    }));
    fleet.getEvents.mockResolvedValue({ events: [] });
    fleet.setSandboxCredentials.mockResolvedValue(undefined);
    exchangeCode.mockReset();
    // A vendor that answers nothing useful: usage reads fail open.
    setUsageFetchForTests(vi.fn(async () => new Response('unavailable', { status: 500 })));
    resetHotSwapChecksForTests();

    const app = express();
    app.use(express.json());
    app.use('/cloud-providers', requireAuth, wrapAsyncRoutes(cloudProviderRoutes()));
    app.use('/developer', requireAuth, wrapAsyncRoutes(developerRoutes()));
    app.use(apiErrorHandler);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    delete process.env.FLEET_MULTI_ACCOUNT_ENABLED;
    setUsageFetchForTests(undefined);
    await drainTaskMetadata();
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await cleanup();
  });

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...internalProxyHeaders(TEST_USER_ID), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  const putConfig = (body: Record<string, unknown>) =>
    call('PUT', '/cloud-providers/selfhosted/config', { workspaceId: WS, ...body });

  async function integrationConfig(): Promise<Record<string, unknown> | undefined> {
    const [row] = await db
      .select({ config: integrationsTable.config })
      .from(integrationsTable)
      .where(and(eq(integrationsTable.workspaceId, WS), eq(integrationsTable.type, 'selfhosted')));
    return row ? ((row.config ?? {}) as Record<string, unknown>) : undefined;
  }

  /** What a backend from before migration 0079 reads off the row: token values only. */
  async function legacyView() {
    const config = (await integrationConfig()) ?? {};
    const oauth = (key: string) => {
      const c = config[key] as { accessTokenEnc: Envelope; refreshTokenEnc: Envelope; reauthRequiredAt?: string } | undefined;
      return c ? { access: decryptString(c.accessTokenEnc), refresh: decryptString(c.refreshTokenEnc), reauth: c.reauthRequiredAt ?? null } : null;
    };
    const key = (k: string) => (config[k] ? decryptString(config[k] as Envelope) : null);
    return {
      claudeOAuth: oauth('claudeOAuth'),
      anthropicKey: key('anthropicKeyEnc'),
      codexOAuth: oauth('codexOAuth'),
      openaiKey: key('openaiKeyEnc'),
      quotaExhausted: (config.quotaExhausted ?? null) as Record<string, unknown> | null,
    };
  }

  async function kinds(agent: 'claude' | 'codex') {
    return (await accounts.listFleetAccounts(WS, agent)).map((a) => `${a.kind}@${a.priority}`);
  }

  async function seedLegacyConfig(config: Record<string, unknown>) {
    const now = new Date();
    await db.insert(integrationsTable).values({
      id: 'int-legacy', workspaceId: WS, type: 'selfhosted', enabled: true, config, createdAt: now, updatedAt: now,
    });
  }

  /** Migration 0079's backfill, run again over rows seeded after the test DB migrated. */
  async function runBackfill() {
    const statements = readFileSync(MIGRATION_0079, 'utf8').split('--> statement-breakpoint');
    const backfill = statements.find((s) => s.includes('INSERT INTO "fleet_accounts"'));
    expect(backfill).toBeDefined();
    await db.execute(sql.raw(backfill!));
  }

  describe.each(['true', 'false'])('GET and PUT with FLEET_MULTI_ACCOUNT_ENABLED=%s', (flag) => {
    beforeEach(() => {
      process.env.FLEET_MULTI_ACCOUNT_ENABLED = flag;
    });

    it('answers GET /cloud-providers with exactly the old CloudProviderInfo keys', async () => {
      const before = await call('GET', `/cloud-providers?workspaceId=${WS}`);
      expect(before.status).toBe(200);
      const [fresh] = before.json.data as Record<string, unknown>[];
      expect(Object.keys(fresh).sort()).toEqual(
        ['capabilities', 'connected', 'connectedAgents', 'displayName', 'reauthAgents', 'type'],
      );
      expect(fresh).toMatchObject({ type: 'selfhosted', connected: false, connectedAgents: [], reauthAgents: [] });

      expect((await putConfig({ claudeToken: 'sk-ant-api03-one' })).json).toEqual({ success: true, data: { connected: true } });
      const after = await call('GET', `/cloud-providers?workspaceId=${WS}`);
      const [connected] = after.json.data as Record<string, unknown>[];
      expect(Object.keys(connected).sort()).toEqual(Object.keys(fresh).sort());
      expect(connected).toMatchObject({ connected: true, connectedAgents: ['claude'], reauthAgents: [] });
    });

    it.each([
      {
        name: 'a pasted Claude key on an empty workspace',
        before: [] as Kind[],
        body: { claudeToken: 'sk-ant-api03-new' },
        claude: ['anthropic_key@1'],
        codex: [],
        legacy: { anthropicKey: 'sk-ant-api03-new', claudeOAuth: 'none' },
      },
      {
        name: 'a pasted Claude key beside a Claude sign-in',
        before: ['claude_oauth'] as Kind[],
        body: { claudeToken: 'sk-ant-api03-new' },
        claude: ['claude_oauth@1', 'anthropic_key@2'],
        codex: [],
        legacy: { anthropicKey: 'sk-ant-api03-new', claudeOAuth: 'tok-claude_oauth' },
      },
      {
        name: 'a pasted Claude key that replaces the old one',
        before: ['anthropic_key'] as Kind[],
        body: { claudeToken: 'sk-ant-api03-new' },
        claude: ['anthropic_key@1'],
        codex: [],
        legacy: { anthropicKey: 'sk-ant-api03-new', claudeOAuth: 'none' },
      },
      {
        name: 'a Codex sign-in that replaces an OpenAI key',
        before: ['openai_key'] as Kind[],
        body: { codexAccessToken: codexJwt('new'), codexRefreshToken: 'r-new' },
        claude: [],
        codex: ['codex_oauth@1'],
        legacy: { codexOAuth: codexJwt('new'), openaiKey: 'none' },
      },
      {
        name: 'an OpenAI key that replaces a Codex sign-in',
        before: ['codex_oauth'] as Kind[],
        body: { openaiKey: 'sk-proj-new' },
        claude: [],
        codex: ['openai_key@1'],
        legacy: { codexOAuth: 'none', openaiKey: 'sk-proj-new' },
      },
      {
        name: 'clearClaude, which keeps Codex',
        before: ['claude_oauth', 'anthropic_key', 'codex_oauth'] as Kind[],
        body: { clearClaude: true },
        claude: [],
        codex: ['codex_oauth@1'],
        legacy: { claudeOAuth: 'none', anthropicKey: 'none', codexOAuth: 'tok-codex_oauth' },
      },
      {
        name: 'clearCodex, which keeps Claude',
        before: ['anthropic_key', 'codex_oauth', 'openai_key'] as Kind[],
        body: { clearCodex: true },
        claude: ['anthropic_key@1'],
        codex: [],
        legacy: { anthropicKey: 'tok-anthropic_key', codexOAuth: 'none', openaiKey: 'none' },
      },
    ])('PUT /selfhosted/config: $name', async ({ before, body, claude, codex, legacy }) => {
      for (const kind of before) {
        await accounts.upsertPrimaryFleetAccount(
          WS,
          kind,
          kind === 'claude_oauth' || kind === 'codex_oauth'
            ? { ...oauthCredential(`tok-${kind}`), ...(kind === 'codex_oauth' ? { accountId: 'chatgpt-1' } : {}) }
            : { keyEnc: encryptString(`tok-${kind}`) },
        );
      }
      const res = await putConfig(body);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ success: true, data: { connected: true } });
      expect(await kinds('claude')).toEqual(claude);
      expect(await kinds('codex')).toEqual(codex);

      const view = await legacyView();
      const expectToken = (actual: string | null | undefined, wanted: string | undefined) => {
        if (wanted === undefined) return;
        if (wanted === 'none') expect(actual ?? null).toBeNull();
        else expect(actual).toBe(wanted);
      };
      expectToken(view.claudeOAuth?.access, legacy.claudeOAuth);
      expectToken(view.anthropicKey, legacy.anthropicKey);
      expectToken(view.codexOAuth?.access, legacy.codexOAuth);
      expectToken(view.openaiKey, legacy.openaiKey);
    });

    it.each([
      [{}, 'Connect a Claude or Codex subscription, or disconnect one.'],
      [{ claudeToken: 'ghp_not_claude' }, 'That does not look like a Claude credential.'],
      [{ openaiKey: 'nope' }, 'That does not look like an OpenAI platform key. Expected sk-….'],
      [{ codexAccessToken: codexJwt('x') }, 'That sign-in carried no refresh token'],
    ])('PUT /selfhosted/config refuses %j as before', async (body, message) => {
      const res = await putConfig(body);
      expect(res.status).toBe(400);
      expect(res.json.success).toBe(false);
      expect(String(res.json.error)).toContain(message);
      expect(await accounts.listFleetAccounts(WS)).toEqual([]);
    });

    it.each([
      ['an empty workspace', [] as Kind[], ['claude_oauth@1']],
      ['a workspace with a pasted key', ['anthropic_key'] as Kind[], ['claude_oauth@1', 'anthropic_key@2']],
      ['a workspace with a sign-in to replace', ['claude_oauth'] as Kind[], ['claude_oauth@1']],
    ])('the old Claude sign-in (authorize, then complete) on %s', async (_name, before, expected) => {
      for (const kind of before) {
        await accounts.upsertPrimaryFleetAccount(
          WS, kind, kind === 'claude_oauth' ? oauthCredential('tok-old') : { keyEnc: encryptString('sk-ant-api03-old') },
        );
      }
      const started = await call('POST', '/cloud-providers/selfhosted/claude/authorize', { workspaceId: WS });
      expect(started.status).toBe(200);
      expect(Object.keys(started.json.data as object)).toEqual(['url']);

      exchangeCode.mockResolvedValue(oauthCredential('sk-ant-oat01-signed-in'));
      const state = new URL((started.json.data as { url: string }).url).searchParams.get('state');
      const done = await call('POST', '/cloud-providers/selfhosted/claude/complete', {
        workspaceId: WS, code: `the-code#${state}`,
      });
      expect(done.status).toBe(200);
      expect(done.json).toEqual({ success: true, data: { connected: true } });
      expect(await kinds('claude')).toEqual(expected);
      expect((await legacyView()).claudeOAuth?.access).toBe('sk-ant-oat01-signed-in');
      expect((await integrationConfig())?.claudePendingAuth).toBeUndefined();
    });

    it('DELETE /selfhosted/config removes every account, the row and the legacy keys', async () => {
      await putConfig({ claudeToken: 'sk-ant-api03-one' });
      await putConfig({ openaiKey: 'sk-proj-one' });
      const res = await call('DELETE', `/cloud-providers/selfhosted/config?workspaceId=${WS}`);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ success: true });
      expect(await accounts.listFleetAccounts(WS)).toEqual([]);
      expect(await integrationConfig()).toBeUndefined();
      const [info] = (await call('GET', `/cloud-providers?workspaceId=${WS}`)).json.data as Record<string, unknown>[];
      expect(info).toMatchObject({ connected: false, connectedAgents: [], reauthAgents: [] });
    });
  });

  describe('a rejected or held agent reads as it did', () => {
    it('reports reauthAgents and the developer agent state from a rejected sign-in', async () => {
      const account = await accounts.upsertPrimaryFleetAccount(WS, 'claude_oauth', oauthCredential('tok'));
      await accounts.setFleetAccountReauth(account.id, new Date('2026-10-01T10:00:00.000Z'));

      const [info] = (await call('GET', `/cloud-providers?workspaceId=${WS}`)).json.data as Record<string, unknown>[];
      expect(info).toMatchObject({ connected: true, connectedAgents: ['claude'], reauthAgents: ['claude'] });
      const agents = await call('GET', `/developer/agents?workspaceId=${WS}`);
      expect(agents.json).toEqual({ success: true, data: { agents: [{ agent: 'claude', state: 'reauth' }] } });
      // The old backend reads the mark off the credential, as an ISO string.
      expect((await legacyView()).claudeOAuth?.reauth).toBe('2026-10-01T10:00:00.000Z');
    });

    it('reports a legacy quota hold that migration 0079 copied', async () => {
      const at = new Date().toISOString();
      await seedLegacyConfig({
        claudeOAuth: LEGACY.claude_oauth.value(),
        quotaExhausted: { claude: { at, detail: 'weekly limit' } },
      });
      await runBackfill();
      const agents = await call('GET', `/developer/agents?workspaceId=${WS}`);
      expect(agents.json).toMatchObject({
        success: true,
        data: { agents: [{ agent: 'claude', state: 'held', hold: { heldSince: at, detail: 'weekly limit' } }] },
      });
    });
  });

  describe('rollback: the legacy keys follow the accounts', () => {
    it('mirrors a refreshed sign-in, so an old backend does not hold a spent refresh token', async () => {
      const account = await accounts.upsertPrimaryFleetAccount(WS, 'claude_oauth', oauthCredential('a1', 'r1'));
      expect((await legacyView()).claudeOAuth).toMatchObject({ access: 'a1', refresh: 'r1' });
      await accounts.updateFleetAccountCredential(account.id, oauthCredential('a2', 'r2'));
      expect((await legacyView()).claudeOAuth).toEqual({ access: 'a2', refresh: 'r2', reauth: null });
    });

    it('mirrors the first account of each kind after a reorder', async () => {
      const a = await accounts.addFleetAccount(WS, { kind: 'claude_oauth', credential: oauthCredential('first'), label: 'A' });
      const b = await accounts.addFleetAccount(WS, { kind: 'claude_oauth', credential: oauthCredential('second'), label: 'B' });
      expect((await legacyView()).claudeOAuth?.access).toBe('first');
      await accounts.reorderFleetAccounts(WS, 'claude', [b.id, a.id]);
      expect((await legacyView()).claudeOAuth?.access).toBe('second');
      await accounts.removeFleetAccount(WS, b.id);
      expect((await legacyView()).claudeOAuth?.access).toBe('first');
    });

    it.each([
      ['one account held', ['held', 'free'], false],
      ['every account held', ['held', 'held'], true],
    ])('mirrors the agent hold only when %s', async (_name, states, mirrored) => {
      const ids: string[] = [];
      for (const [i] of states.entries()) {
        ids.push((await accounts.addFleetAccount(WS, { kind: 'anthropic_key', credential: { keyEnc: encryptString(`k${i}`) } })).id);
      }
      const record = { at: new Date().toISOString(), detail: 'spent' };
      for (const [i, state] of states.entries()) {
        if (state === 'held') await accounts.setFleetAccountExhausted({ accountId: ids[i]! }, record);
      }
      const view = await legacyView();
      if (mirrored) expect(view.quotaExhausted).toEqual({ claude: record });
      else expect(view.quotaExhausted).toBeNull();

      await accounts.clearFleetAccountExhausted({ workspaceId: WS, agent: 'claude' });
      expect((await legacyView()).quotaExhausted).toBeNull();
    });

    it('keeps the other agent and unrelated keys when it mirrors one agent', async () => {
      await seedLegacyConfig({
        claudePendingAuth: { state: 's', codeVerifierEnc: encryptString('v'), expiresAt: new Date(Date.now() + 60_000).toISOString() },
        quotaExhausted: { codex: { at: '2026-10-01T00:00:00.000Z' } },
        openaiKeyEnc: encryptString('sk-proj-kept'),
      });
      await accounts.addFleetAccount(WS, { kind: 'anthropic_key', credential: { keyEnc: encryptString('sk-ant-api03-x') } });
      const config = await integrationConfig();
      expect(config?.claudePendingAuth).toBeDefined();
      expect(config?.quotaExhausted).toEqual({ codex: { at: '2026-10-01T00:00:00.000Z' } });
      expect((await legacyView()).openaiKey).toBe('sk-proj-kept');
      expect((await legacyView()).anthropicKey).toBe('sk-ant-api03-x');
    });

    it('drops the keys when the last account goes, and does not adopt it back', async () => {
      const account = await accounts.upsertPrimaryFleetAccount(WS, 'anthropic_key', { keyEnc: encryptString('k') });
      expect((await legacyView()).anthropicKey).toBe('k');
      await accounts.removeFleetAccount(WS, account.id);
      expect((await legacyView()).anthropicKey).toBeNull();
      expect(await accounts.listFleetAccounts(WS)).toEqual([]);
    });
  });

  describe.each(['migration 0079', 'adoption at read time'])('dispatch on a legacy credential (%s)', (source) => {
    async function seedLegacy(kind: Kind) {
      await seedLegacyConfig({ [LEGACY[kind].configKey]: LEGACY[kind].value() });
      if (source === 'migration 0079') await runBackfill();
    }

    async function seedTask(metadata: Record<string, unknown>) {
      await db.insert(tasksTable).values({
        id: 't1', workspaceId: WS, type: 'code_writing', status: 'in_progress', priority: 'medium',
        title: 'work', description: 'd', prompt: 'do it', repositoryId: 'repo1', metadata,
      });
    }

    async function cloudExtra(): Promise<Record<string, unknown>> {
      await drainTaskMetadata();
      const [row] = await db.select({ metadata: tasksTable.metadata }).from(tasksTable).where(eq(tasksTable.id, 't1'));
      const meta = (row?.metadata ?? {}) as { cloudTask?: { extra?: Record<string, unknown> } };
      return meta.cloudTask?.extra ?? {};
    }

    it.each(Object.keys(LEGACY) as Kind[])('dispatches a new task on the %s it held', async (kind) => {
      const { model, token, bodyKey } = LEGACY[kind];
      await seedLegacy(kind);
      await seedTask({ model });
      const task = {
        id: 't1', workspaceId: WS, type: 'code_writing', status: 'queued', priority: 'medium', title: 'work',
        description: 'd', prompt: 'do it', repositoryId: 'repo1', metadata: { model },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      } as unknown as Task;

      expect(await dispatchTaskToFleet(task, ENV)).toEqual({ ok: true });
      const body = fleet.createSandbox.mock.calls[0]![0] as Record<string, unknown>;
      expect(body[bodyKey]).toBe(token);
      expect(body[bodyKey === 'anthropicKey' ? 'openaiKey' : 'anthropicKey']).toBeUndefined();
      expect((await cloudExtra()).accountId).toBe(accounts.legacyAccountId(WS, kind));
    });

    it.each(Object.keys(LEGACY) as Kind[])(
      'serves a run an OLD backend dispatched (no account recorded) on the %s',
      async (kind) => {
        const { agent, token, bodyKey } = LEGACY[kind];
        await seedLegacy(kind);
        const extra = { host: 'host-1', repo: 'acme/widgets', llm: agent === 'claude' ? 'anthropic' : 'openai' };
        await seedTask({ cloudTask: { provider: 'selfhosted', status: 'running', remoteTaskId: 'talyn-t1', extra } });

        const pulled = await resolveRunCredentials('host-1', 'talyn-t1');
        expect(pulled).toMatchObject({ ok: true, credentials: { [bodyKey]: token } });

        fleet.getSandbox.mockResolvedValue({
          sandbox: { id: 'talyn-t1', status: 'busy', workspaceId: WS, adopted: true, adoptedAt: new Date().toISOString() },
        });
        const row = {
          id: 't1', workspaceId: WS, title: 'work', repositoryId: null,
          metadata: { cloudTask: { provider: 'selfhosted', status: 'running', remoteTaskId: 'talyn-t1', extra } },
          transcriptFinal: false, watched: false, status: 'in_progress', completedAt: null, updatedAt: new Date(),
        } as CloudTaskRow;
        await selfHostedPoller.reconcileTask(row);
        selfHostedPoller.stopStreaming('t1');
        expect(fleet.setSandboxCredentials).toHaveBeenCalledTimes(1);
        expect(fleet.setSandboxCredentials.mock.calls[0]![1]).toMatchObject({ [bodyKey]: token });
      },
    );
  });
});

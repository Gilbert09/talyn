import { randomBytes } from 'node:crypto';
import type { Request, Response, Router } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetAccountsResponse } from '@talyn/shared';
import { createTestDb, seedUser, TEST_USER_ID } from '../helpers/testDb.js';
import type { Database } from '../../db/client.js';
import { workspaces } from '../../db/schema.js';
import { cloudProviderRoutes } from '../../routes/cloudProviders.js';
import { addFleetAccount, getFleetAccountWithCredential, listFleetAccounts, setFleetAccountUsage } from '../../services/selfHosted/accounts.js';
import { readSelfHostedConfig } from '../../services/selfHosted/credentials.js';
import { FleetClient } from '../../services/selfHosted/client.js';
import { registerCloudProvider } from '../../services/cloudProviders/registry.js';
import { selfHostedProvider } from '../../services/cloudProviders/selfhosted/provider.js';
import { decryptString, encryptString } from '../../services/tokenCrypto.js';

const WS = 'fleet-api-mine';
const OTHER = 'fleet-api-other';

describe('fleet accounts API', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let router: Router;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID });
    await seedUser(db, { id: 'fleet-other-user' });
    await db.insert(workspaces).values([
      { id: WS, ownerId: TEST_USER_ID, name: 'mine', settings: { fleetSwitchAtPercent: 95 } },
      { id: OTHER, ownerId: 'fleet-other-user', name: 'other', settings: {} },
    ]);
    vi.stubEnv('FLEET_ALLOWED', 'true');
    vi.stubEnv('FLEET_MULTI_ACCOUNT_ENABLED', 'true');
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    registerCloudProvider(selfHostedProvider);
    router = cloudProviderRoutes();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await cleanup();
  });

  async function api(path: string, method = 'GET', body?: unknown) {
    const url = new URL(path, 'http://local');
    const idMatch = url.pathname === '/selfhosted/accounts/order'
      ? null
      : url.pathname.match(/^\/selfhosted\/accounts\/([^/]+)(\/usage\/refresh)?$/);
    const config = url.pathname === '/selfhosted/config';
    const routePath = config ? '/:type/config' : idMatch
      ? `/selfhosted/accounts/:id${idMatch[2] ?? ''}`
      : url.pathname;
    const stack = router as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (req: Request, res: Response) => Promise<unknown> }> } }>;
    };
    const route = stack.stack.find((layer) => layer.route?.path === routePath && layer.route.methods[method.toLowerCase()])?.route;
    if (!route) throw new Error(`Route missing: ${method} ${routePath}`);
    const request = {
      params: config ? { type: 'selfhosted' } : idMatch ? { id: idMatch[1] } : {},
      query: Object.fromEntries(url.searchParams),
      body: body ?? {},
      user: { id: TEST_USER_ID, email: 'test@example.com', isAdmin: false },
    } as unknown as Request;
    let status = 200;
    let payload: unknown;
    const response = {
      status(code: number) { status = code; return this; },
      json(value: unknown) { payload = value; return this; },
    } as unknown as Response;
    await route.stack[0].handle(request, response);
    return { status, json: async () => payload };
  }

  async function add(kind: 'claude_oauth' | 'anthropic_key' | 'openai_key', workspaceId = WS) {
    return addFleetAccount(workspaceId, {
      kind,
      credential: kind === 'claude_oauth'
        ? { accessTokenEnc: encryptString('fake-oauth-token'), refreshTokenEnc: encryptString('fake-refresh-token'), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
        : { keyEnc: encryptString('fake-key') },
    });
  }

  it.each([94, 95, 100])('uses the threshold boundary at %i and excludes credentials', async (usedPercent) => {
    const first = await add('claude_oauth');
    const second = await add('anthropic_key');
    await setFleetAccountUsage(first.id, {
      fetchedAt: new Date().toISOString(),
      windows: [{ key: 'weekly', label: 'Weekly', usedPercent, resetsAt: null, scopeModel: 'Opus' }],
    });
    const res = await api(`/selfhosted/accounts?workspaceId=${WS}`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { data: FleetAccountsResponse };
    expect(payload.data.switchAtPercent).toBe(95);
    expect(payload.data.active.claude).toBe(usedPercent < 95 ? first.id : second.id);
    expect(payload.data.accounts[0].over).toBe(usedPercent >= 95);
    expect(JSON.stringify(payload)).not.toMatch(/credential|keyEnc|accessTokenEnc|scopeModel|fake-oauth-token/);
  });

  it('refreshes stale OAuth usage and keeps a fresh snapshot', async () => {
    const account = await add('claude_oauth');
    const vendor = vi.fn().mockResolvedValue(new Response(JSON.stringify({ limits: [{ kind: 'session', group: 'session', percent: 12 }] }), { status: 200 }));
    vi.stubGlobal('fetch', vendor);
    await setFleetAccountUsage(account.id, { fetchedAt: new Date().toISOString(), windows: [] });
    await api(`/selfhosted/accounts?workspaceId=${WS}`);
    expect(vendor).not.toHaveBeenCalled();
    await setFleetAccountUsage(account.id, { fetchedAt: new Date(Date.now() - 61_000).toISOString(), windows: [] });
    await api(`/selfhosted/accounts?workspaceId=${WS}`);
    expect(vendor).toHaveBeenCalledTimes(1);
  });

  it('allows the first key when the multi-account flag is off, then refuses the second', async () => {
    vi.stubEnv('FLEET_MULTI_ACCOUNT_ENABLED', 'false');
    const body = { workspaceId: WS, agent: 'claude', kind: 'anthropic_key', key: 'sk-ant-api-fake' };
    expect((await api('/selfhosted/accounts', 'POST', body)).status).toBe(201);
    const second = await api('/selfhosted/accounts', 'POST', body);
    expect(second.status).toBe(403);
    expect((await second.json()) as object).toMatchObject({ code: 'multi_account_disabled' });
    expect(await listFleetAccounts(WS, 'claude')).toHaveLength(1);
  });

  it('refuses duplicate and incomplete reorder lists', async () => {
    const first = await add('anthropic_key');
    await add('anthropic_key');
    for (const ids of [[first.id], [first.id, first.id]]) {
      expect((await api('/selfhosted/accounts/order', 'PUT', { workspaceId: WS, agent: 'claude', ids })).status).toBe(400);
    }
  });

  it.each(['PATCH', 'DELETE', 'POST'])('hides another workspace account on %s', async (method) => {
    const account = await add('anthropic_key', OTHER);
    const suffix = method === 'POST' ? '/usage/refresh' : '';
    const res = await api(`/selfhosted/accounts/${account.id}${suffix}`, method, method === 'PATCH' ? { label: 'changed' } : undefined);
    expect(res.status).toBe(404);
  });

  it('parks a new label and a reconnect id on separate Claude sign-ins', async () => {
    const account = await add('claude_oauth');
    for (const option of [{ label: 'Second Claude' }, { accountId: account.id }]) {
      const res = await api('/selfhosted/claude/authorize', 'POST', { workspaceId: WS, ...option });
      expect(res.status).toBe(200);
      expect((await readSelfHostedConfig(WS))?.claudePendingAuth).toMatchObject(option);
    }
  });

  it.each(['label', 'accountId'] as const)('completes Claude sign-in for %s', async (target) => {
    const first = await add('claude_oauth');
    const option = target === 'label' ? { label: 'Another Claude' } : { accountId: first.id };
    const started = await api('/selfhosted/claude/authorize', 'POST', { workspaceId: WS, ...option });
    expect(started.status).toBe(200);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'fresh-fake-token', refresh_token: 'fresh-fake-refresh', expires_in: 3600,
      scope: 'user:inference',
    }), { status: 200 })));
    const completed = await api('/selfhosted/claude/complete', 'POST', { workspaceId: WS, code: 'fake-code', ...option });
    expect(completed.status).toBe(200);
    const all = await listFleetAccounts(WS, 'claude');
    expect(all).toHaveLength(target === 'label' ? 2 : 1);
    const changed = all.find((account) => target === 'label' ? account.label === 'Another Claude' : account.id === first.id)!;
    const stored = await getFleetAccountWithCredential(changed.id);
    expect(decryptString((stored!.credential as { accessTokenEnc: ReturnType<typeof encryptString> }).accessTokenEnc)).toBe('fresh-fake-token');
  });

  it('limits forced usage refresh to one request per 30 seconds', async () => {
    const account = await add('anthropic_key');
    const path = `/selfhosted/accounts/${account.id}/usage/refresh`;
    expect((await api(path, 'POST')).status).toBe(200);
    expect((await api(path, 'POST')).status).toBe(429);
  });

  it('lists connected agents without contacting a vendor', async () => {
    await add('claude_oauth');
    const vendor = vi.fn();
    vi.stubGlobal('fetch', vendor);
    const res = await api(`/?workspaceId=${WS}`);
    expect(res.status).toBe(200);
    expect(vendor).not.toHaveBeenCalled();
  });

  it('keeps the old PUT config body working', async () => {
    vi.stubEnv('FLEET_PINNED_ENDPOINT', 'https://fleet.example');
    vi.stubEnv('FLEET_GATEWAY_TOKEN', 'fake-gateway-key');
    vi.spyOn(FleetClient.prototype, 'listGatewaySandboxes').mockResolvedValue([]);
    const res = await api('/selfhosted/config', 'PUT', { workspaceId: WS, claudeToken: 'sk-ant-api-fake' });
    expect(res.status).toBe(200);
    expect((await listFleetAccounts(WS, 'claude')).map((account) => account.kind)).toEqual(['anthropic_key']);
  });

  it('adds and reconnects a named Codex account through PUT config', async () => {
    vi.stubEnv('FLEET_PINNED_ENDPOINT', 'https://fleet.example');
    vi.stubEnv('FLEET_GATEWAY_TOKEN', 'fake-gateway-key');
    vi.spyOn(FleetClient.prototype, 'listGatewaySandboxes').mockResolvedValue([]);
    const jwt = (value: string) => `header.${Buffer.from(JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'chatgpt-1' }, value,
    })).toString('base64url')}.signature`;
    const first = await api('/selfhosted/config', 'PUT', {
      workspaceId: WS, codexAccessToken: jwt('first'), codexRefreshToken: 'fake-refresh', codexLabel: 'Codex work',
    });
    expect(first.status).toBe(200);
    const [account] = await listFleetAccounts(WS, 'codex');
    expect(account.label).toBe('Codex work');
    const next = await api('/selfhosted/config', 'PUT', {
      workspaceId: WS, codexAccessToken: jwt('second'), codexRefreshToken: 'fake-refresh', codexAccountId: account.id,
    });
    expect(next.status).toBe(200);
    expect(await listFleetAccounts(WS, 'codex')).toHaveLength(1);
    const stored = await getFleetAccountWithCredential(account.id);
    expect(decryptString((stored!.credential as { accessTokenEnc: ReturnType<typeof encryptString> }).accessTokenEnc)).toBe(jwt('second'));
  });
});

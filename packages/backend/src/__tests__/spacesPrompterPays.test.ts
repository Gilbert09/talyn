import { randomBytes } from 'node:crypto';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { and, eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAN_LIMITS, USAGE_EXHAUSTED_ERROR_CODE } from '@talyn/shared';
import type { UsageBudget } from '../services/billing/usage/charge.js';

const { getBudget } = vi.hoisted(() => ({ getBudget: vi.fn() }));
vi.mock('../services/billing/usage/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/billing/usage/index.js')>()),
  getBudget,
}));

import '../services/billing/entitlements.js';
import { createTestDb } from './helpers/testDb.js';
import { claudeTurnLines, FakeFleet, isAgentTurn } from './helpers/fakeFleet.js';
import {
  pullRequests, repositories, spaces, teamMembers, teams, usageIntervals, users, workbenchChats, workbenches, workspaces,
} from '../db/schema.js';

/**
 * Teams and Spaces, phase 3: the prompter pays. A teammate's turn runs on the
 * teammate's agent account, GitHub token, MCP secrets, git identity and
 * box-hours; the owner's are never on the box during it. One payer holds a
 * box at a time.
 */

vi.mock('../services/websocket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/websocket.js')>()),
  broadcastToWorkspace: () => undefined,
}));
vi.mock('../services/githubIdentity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/githubIdentity.js')>()),
  ensureGithubUserId: async () => null,
}));
vi.mock('../services/mcpServers/dispatch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/mcpServers/dispatch.js')>()),
  mcpIntegrationSecrets: vi.fn(async ({ workspaceId }: { workspaceId: string }) =>
    ({ linear: workspaceId === 'ws-a' ? 'owner-linear' : 'ben-linear' })),
}));

const { workbenchRoutes } = await import('../routes/workbenches.js');
const { apiErrorHandler } = await import('../routes/index.js');
const { wrapAsyncRoutes } = await import('../middleware/asyncHandler.js');
const { githubService } = await import('../services/github.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { resetRepoReadCacheForTests } = await import('../services/teams/access.js');
const { addFleetAccount, setFleetAccountUsage } = await import('../services/selfHosted/accounts.js');
const { encryptString } = await import('../services/tokenCrypto.js');
const { removeSelfHostedCredentials } = await import('../services/selfHosted/credentials.js');
const { ensureSessionMcpToken } = await import('../services/sessionMcpToken.js');
const { setWorkbenchFleetClientForTests, withOwnerCredentials } = await import('../services/workbenches/sandboxRuntime.js');
const { prMonitorService } = await import('../services/prMonitor.js');
const { resolveWorkbenchRunCredentials } = await import('../services/workbenches/runCredentials.js');
const { settleAgentBackupsForTests } = await import('../services/workbenches/agentBackups.js');
const { resetBoxDeferralsForTests } = await import('../services/billing/boxDeferral.js');
const { resetUsageHookCacheForTests } = await import('../services/billing/usageHooks.js');
const { currentBoxPayer, getChat, getWorkbench, listEvents } = await import('../services/workbenches/store.js');
const { setTurnRetryDelaysForTests } = await import('../services/workbenches/turns.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const ANA = 'u-ana';
const BEN = 'u-ben';
const CY = 'u-cy';
const BOX = 'talyn-wb-shared';
const HOST = 'host-1';

function budget(exhausted: boolean): UsageBudget {
  return {
    tier: 'free',
    period: { start: new Date('2026-11-01T00:00:00.000Z'), end: new Date('2026-12-01T00:00:00.000Z') },
    includedWsec: PLAN_LIMITS.free.includedBoxHours * 3600,
    usedWsec: 0,
    includedLeftWsec: exhausted ? 0 : 3600,
    creditMicros: 0,
    autoTopupPossible: false,
    exhausted,
  };
}

describe('the prompter pays', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let server: Server;
  let base: string;
  let fleet: FakeFleet;
  let ownerMcpToken: string;
  let benAccountId: string;
  let ownerAccountId: string;
  /** A held agent run: the test releases it. */
  let hold: Promise<void> | null;
  /** The GitHub token on the box when each `git push` ran. */
  let pushTokens: unknown[];
  const exhaustedUsers = new Set<string>();

  async function call(method: string, path: string, user: string, body?: unknown): Promise<{ status: number; body: Loose }> {
    const resp = await fetch(`${base}${path}`, {
      method,
      headers: { 'x-user': user, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: resp.status, body: await resp.json() };
  }

  const send = (user: string, chatId = 'chat-1', text = 'Fix the bug') =>
    call('POST', `/workbenches/chats/${chatId}/messages`, user, { text });
  const settled = (chatId = 'chat-1') =>
    vi.waitFor(async () => expect((await getChat(chatId))?.status).toBe('idle'), { timeout: 5000 });
  const agentExecs = () => fleet.execs.filter((e) => isAgentTurn(e.script));
  const lastPush = () => fleet.credentialPushes.at(-1)!.creds;

  async function openOwnerInterval(): Promise<void> {
    await testDb.db.insert(usageIntervals).values({
      id: 'iv-owner', ownerId: ANA, workspaceId: 'ws-a', subjectKind: 'workbench', subjectId: 'wb',
      sandboxId: BOX, size: 'standard', weight: '1.00',
      startedAt: new Date(Date.now() - 60_000), billedThrough: new Date(Date.now() - 60_000),
    });
  }

  const openIntervals = () => testDb.db
    .select({ ownerId: usageIntervals.ownerId, payerUserId: usageIntervals.payerUserId })
    .from(usageIntervals)
    .where(and(eq(usageIntervals.subjectId, 'wb'), isNull(usageIntervals.endedAt)));

  beforeEach(async () => {
    process.env.POLAR_ACCESS_TOKEN = 'polar-test-token';
    exhaustedUsers.clear();
    getBudget.mockReset();
    getBudget.mockImplementation(async (ownerId: string) => budget(exhaustedUsers.has(ownerId)));
    resetBoxDeferralsForTests();
    resetUsageHookCacheForTests();
    setTurnRetryDelaysForTests([0]);
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('TALYN_PUBLIC_API_URL', 'https://api.talyn.dev');
    vi.stubEnv('SPACES_ENABLED', 'true');
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    vi.stubEnv('FLEET_API_TOKEN', 'fleet-token');
    vi.stubEnv('FLEET_PINNED_ENDPOINT', '');
    vi.stubEnv('FLEET_GATEWAY_TOKEN', '');
    vi.stubEnv('FLEET_ALLOWED', 'true');
    resetFeatureFlagsForTests();
    resetRepoReadCacheForTests();
    testDb = await createTestDb();
    await testDb.db.insert(users).values([
      { id: ANA, email: 'ana@x.test', githubUserId: 100, githubUsername: 'ana' },
      { id: BEN, email: 'ben@x.test', githubUserId: 200, githubUsername: 'ben' },
      { id: CY, email: 'cy@x.test', githubUserId: 300, githubUsername: 'cy' },
    ]);
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: ANA, name: 'A' },
      { id: 'ws-b', ownerId: BEN, name: 'B' },
      { id: 'ws-c', ownerId: CY, name: 'C' },
    ]);
    await testDb.db.insert(repositories).values({
      id: 'repo-a', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app', defaultBranch: 'main',
    });
    await testDb.db.insert(teams).values([{ id: 'team-1', name: 'Acme' }, { id: 'team-2', name: 'Other' }]);
    await testDb.db.insert(teamMembers).values([
      { id: 'm-ana', teamId: 'team-1', githubUserId: 100, userId: ANA, githubLogin: 'ana', role: 'owner' },
      { id: 'm-ben', teamId: 'team-1', githubUserId: 200, userId: BEN, githubLogin: 'ben', homeWorkspaceId: 'ws-b' },
      { id: 'm-cy', teamId: 'team-2', githubUserId: 300, userId: CY, githubLogin: 'cy', role: 'owner' },
    ]);
    await testDb.db.insert(spaces).values({ id: 'space-1', teamId: 'team-1', name: 'Web' });
    const usage = { fetchedAt: new Date().toISOString(), windows: [{ key: 'session', label: '5-hour', usedPercent: 1, resetsAt: null }] };
    const owner = await addFleetAccount('ws-a', { kind: 'anthropic_key', label: 'Ana', credential: { keyEnc: encryptString('owner-claude') } });
    const ben = await addFleetAccount('ws-b', { kind: 'anthropic_key', label: 'Ben', credential: { keyEnc: encryptString('ben-claude') } });
    await setFleetAccountUsage(owner.id, usage);
    await setFleetAccountUsage(ben.id, usage);
    ownerAccountId = owner.id;
    benAccountId = ben.id;
    await testDb.db.insert(workbenches).values({
      id: 'wb', workspaceId: 'ws-a', repositoryId: 'repo-a', repoFullName: 'acme/app', name: 'wb', branch: 'ana/fix',
      baseBranch: 'main', runtime: 'sandbox', agent: 'claude', sandboxId: BOX, sandboxState: 'running', status: 'ready',
      fleetHost: HOST, spaceId: 'space-1', settings: { autoCreatePr: false, fleetAccountId: owner.id, boxSize: 'standard' },
    });
    await testDb.db.insert(workbenchChats).values([
      { id: 'chat-1', workbenchId: 'wb', workspaceId: 'ws-a', title: 'One', agent: 'claude' },
      { id: 'chat-2', workbenchId: 'wb', workspaceId: 'ws-a', title: 'Two', agent: 'claude' },
    ]);
    ownerMcpToken = (await ensureSessionMcpToken({ id: 'wb', workspaceId: 'ws-a' }))!;

    vi.spyOn(githubService, 'canAccessRepository').mockResolvedValue(true);
    vi.spyOn(githubService, 'getRepository').mockResolvedValue({ permissions: { push: true } } as Loose);
    vi.spyOn(githubService, 'getVerifiedAccessToken').mockImplementation(async (ws: string) => (ws === 'ws-a' ? 'gh-owner' : 'gh-ben'));
    hold = null;
    pushTokens = [];
    fleet = new FakeFleet();
    fleet.handler = async (script) => {
      if (isAgentTurn(script)) {
        if (hold) await hold;
        return { stdout: claudeTurnLines('sess-1', 'done') };
      }
      if (script.includes('rev-list --count')) return { stdout: '1\n' };
      if (script.includes('git push -u origin HEAD')) {
        pushTokens.push(fleet.credentialPushes.at(-1)?.creds.githubToken);
        return { exitCode: 0 };
      }
      if (script.includes('git commit-tree')) return { stdout: `${'c'.repeat(40)}\n` };
      return { exitCode: 0, stdout: '' };
    };
    setWorkbenchFleetClientForTests(async () => fleet.asClient());

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const id = req.headers['x-user'] as string;
      req.user = { id, email: `${id}@example.test`, isAdmin: false };
      next();
    });
    app.use('/workbenches', wrapAsyncRoutes(workbenchRoutes()));
    app.use(apiErrorHandler);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await settleAgentBackupsForTests();
    setWorkbenchFleetClientForTests(null);
    setTurnRetryDelaysForTests(null);
    await new Promise((r) => server.close(r));
    await testDb.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetFeatureFlagsForTests();
    delete process.env.POLAR_ACCESS_TOKEN;
  });

  it("runs a teammate's turn on the teammate's credentials only", async () => {
    const res = await send(BEN);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ queued: false });
    await settled();

    const creds = lastPush();
    expect(creds).toMatchObject({ githubToken: 'gh-ben', anthropicKey: 'ben-claude', repo: 'acme/app' });
    expect((creds.integrations as Record<string, string>).linear).toBe('ben-linear');
    expect((creds.integrations as Record<string, string>).talyn).toMatch(/^unclaimed-/);
    // None of the owner's secrets is on the box for this turn.
    const pushed = JSON.stringify(fleet.credentialPushes.map((p) => p.creds));
    for (const secret of ['gh-owner', 'owner-claude', 'owner-linear', ownerMcpToken]) expect(pushed).not.toContain(secret);

    // The owner's recorded account stays; the teammate's is kept apart.
    const wb = (await getWorkbench('wb'))!;
    expect(wb.settings).toMatchObject({ fleetAccountId: ownerAccountId, payerFleetAccounts: { [BEN]: { claude: benAccountId } } });
    expect(await getChat('chat-1')).toMatchObject({ payerUserId: BEN, payerWorkspaceId: 'ws-b' });
    expect(await currentBoxPayer('wb')).toEqual({ userId: BEN, workspaceId: 'ws-b' });
  });

  it("commits a teammate's turn as the teammate", async () => {
    await send(BEN);
    await settled();
    expect(agentExecs()).toHaveLength(1);
    expect(agentExecs()[0].req.env).toMatchObject({
      GIT_AUTHOR_NAME: 'ben',
      GIT_AUTHOR_EMAIL: '200+ben@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'ben',
      GIT_COMMITTER_EMAIL: '200+ben@users.noreply.github.com',
    });
  });

  it('shows who prompted in the transcript, without their workspace', async () => {
    await send(BEN);
    await settled();
    const events = (await listEvents('chat-1', 0, 100)).events.map((e) => e.event as Loose);
    const user = events.find((e) => e.talyn?.kind === 'user_message');
    expect(user.talyn.payer).toEqual({ userId: BEN, githubLogin: 'ben', avatarUrl: expect.stringContaining('200') });
    expect(JSON.stringify(user)).not.toContain('ws-b');
  });

  it("keeps the owner's turn as it was, and a null payer means the owner", async () => {
    await send(ANA);
    await settled();
    expect(lastPush()).toMatchObject({ githubToken: 'gh-owner', anthropicKey: 'owner-claude', integrations: { linear: 'owner-linear', talyn: ownerMcpToken } });
    expect(agentExecs()[0].req.env?.GIT_AUTHOR_NAME).toBeUndefined();
    expect(await getChat('chat-1')).toMatchObject({ payerUserId: null, payerWorkspaceId: null });
    expect(await currentBoxPayer('wb')).toBeNull();
    const events = (await listEvents('chat-1', 0, 100)).events.map((e) => e.event as Loose);
    expect(events.find((e) => e.talyn?.kind === 'user_message').talyn.payer).toBeUndefined();
  });

  it('answers a host pull between turns with the latest payer set, and the next turn replaces it', async () => {
    await send(BEN);
    await settled();
    const between = await resolveWorkbenchRunCredentials(HOST, BOX);
    expect(between).toMatchObject({ ok: true, credentials: { githubToken: 'gh-ben', anthropicKey: 'ben-claude' } });

    await send(ANA);
    await settled();
    expect(lastPush()).toMatchObject({ githubToken: 'gh-owner', anthropicKey: 'owner-claude' });
    expect(await resolveWorkbenchRunCredentials(HOST, BOX)).toMatchObject({
      ok: true, credentials: { githubToken: 'gh-owner', anthropicKey: 'owner-claude' },
    });
  });

  it('bills the box to the payer of the latest turn: a payer change closes and opens an interval', async () => {
    await openOwnerInterval();
    await send(BEN);
    await settled();
    expect(await openIntervals()).toEqual([{ ownerId: BEN, payerUserId: BEN }]);
    const [closed] = await testDb.db.select({ endReason: usageIntervals.endReason, ownerId: usageIntervals.ownerId })
      .from(usageIntervals).where(eq(usageIntervals.id, 'iv-owner'));
    expect(closed).toEqual({ endReason: 'payer_change', ownerId: ANA });

    // Ben's next turn keeps his interval.
    await send(BEN);
    await settled();
    expect(await openIntervals()).toEqual([{ ownerId: BEN, payerUserId: BEN }]);

    await send(ANA);
    await settled();
    expect(await openIntervals()).toEqual([{ ownerId: ANA, payerUserId: null }]);
  });

  it('refuses a teammate whose usage is spent with a 402, and charges the owner nothing', async () => {
    exhaustedUsers.add(BEN);
    await openOwnerInterval();
    const res = await send(BEN);
    expect(res.status).toBe(402);
    expect(res.body.code).toBe(USAGE_EXHAUSTED_ERROR_CODE);
    expect(res.body.notice).toMatchObject({ workspaceId: 'ws-b' });
    expect(getBudget).not.toHaveBeenCalledWith(ANA);
    expect(fleet.credentialPushes).toEqual([]);
    expect(agentExecs()).toEqual([]);
    expect(await openIntervals()).toEqual([{ ownerId: ANA, payerUserId: null }]);
    expect(await getChat('chat-1')).toMatchObject({ status: 'idle', queuedMessages: [] });
  });

  it("does not ask the owner's budget for a teammate's turn", async () => {
    exhaustedUsers.add(ANA);
    expect((await send(BEN)).status).toBe(200);
    await settled();
    expect(getBudget).not.toHaveBeenCalledWith(ANA);
  });

  it("waits while another payer's turn holds the box, then starts", async () => {
    let release!: () => void;
    hold = new Promise((resolve) => { release = resolve; });
    expect((await send(BEN, 'chat-1')).status).toBe(200);
    await vi.waitFor(() => expect(agentExecs()).toHaveLength(1), { timeout: 5000 });

    const res = await send(ANA, 'chat-2', 'Something else');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ queued: true, waitingFor: 'ben' });
    const waiting = (await getChat('chat-2'))!;
    expect(waiting.status).toBe('idle');
    expect(waiting.queuedMessages).toHaveLength(1);

    // The same payer may run a second chat at once.
    hold = null;
    release();
    await settled('chat-1');
    await settled('chat-2');
    expect(agentExecs()).toHaveLength(2);
    expect(lastPush()).toMatchObject({ githubToken: 'gh-owner', anthropicKey: 'owner-claude' });
    expect(agentExecs()[1].req.env?.GIT_AUTHOR_NAME).toBeUndefined();
  });

  it('lets one payer run two chats of the box at once', async () => {
    let release!: () => void;
    hold = new Promise((resolve) => { release = resolve; });
    await send(BEN, 'chat-1');
    await vi.waitFor(() => expect(agentExecs()).toHaveLength(1), { timeout: 5000 });
    const res = await send(BEN, 'chat-2');
    expect(res.body.data).toEqual({ queued: false });
    await vi.waitFor(() => expect(agentExecs()).toHaveLength(2), { timeout: 5000 });
    release();
    await settled('chat-1');
    await settled('chat-2');
  });

  it.each([
    ['no push access', async () => {
      vi.spyOn(githubService, 'getRepository').mockResolvedValue({ permissions: { push: false, pull: true } } as Loose);
    }, BEN, 403, 'no_push_access'],
    ['no agent account', async () => {
      await removeSelfHostedCredentials('ws-b');
    }, BEN, 409, 'no_agent_account'],
    ['not a member', async () => undefined, CY, 404, undefined],
    ['the spaces flag off', async () => {
      vi.stubEnv('SPACES_ENABLED', 'false');
      resetFeatureFlagsForTests();
    }, BEN, 404, undefined],
  ] as const)('refuses a teammate with %s', async (_name, arrange, user, status, code) => {
    await arrange();
    const res = await send(user);
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(agentExecs()).toEqual([]);
    expect((await getChat('chat-1'))!.queuedMessages).toEqual([]);
  });

  it("opens the owner's PR after a teammate's turn on the owner's credentials only", async () => {
    await send(BEN);
    await settled();
    const createPr = vi.spyOn(githubService, 'createPullRequest')
      .mockResolvedValue({ number: 7, html_url: 'https://github.com/acme/app/pull/7' } as Loose);
    vi.spyOn(githubService, 'findOpenPullRequestForHead').mockResolvedValue(null as Loose);
    vi.spyOn(prMonitorService, 'watchPullRequest').mockImplementation(async ({ number }: Loose) => {
      await testDb.db.insert(pullRequests).values({
        id: `pr-${number}`, workspaceId: 'ws-a', repositoryId: 'repo-a', owner: 'acme', repo: 'app', number, state: 'open',
        lastSummary: { createdAt: new Date().toISOString(), headBranch: 'ana/fix', mergeable: 'MERGEABLE', ciStatus: 'passing' } as Loose,
      });
      return { ok: true, rowId: `pr-${number}`, alreadyTracked: false, summary: {} } as Loose;
    });
    const before = fleet.credentialPushes.length;

    const res = await call('POST', '/workbenches/wb/pull-request', ANA, { title: 'Fix the bug' });
    expect(res.status).toBe(200);
    const pushes = fleet.credentialPushes.slice(before).map((p) => p.creds);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ githubToken: 'gh-owner', anthropicKey: 'owner-claude' });
    expect(JSON.stringify(pushes)).not.toContain('gh-ben');
    // The push and the PR API call are one identity: the owner.
    expect(pushTokens).toEqual(['gh-owner']);
    expect(createPr).toHaveBeenCalledWith('ws-a', 'acme', 'app', expect.anything());
    const gitPush = fleet.execs.find((e) => e.script.includes('git push -u origin HEAD'))!;
    expect(gitPush.req.env?.GIT_AUTHOR_NAME).toBeUndefined();
  });

  it("gives a running teammate turn its own set back after an owner action", async () => {
    await testDb.db.update(workbenchChats)
      .set({ status: 'running', payerUserId: BEN, payerWorkspaceId: 'ws-b', turnStartedAt: new Date() })
      .where(eq(workbenchChats.id, 'chat-1'));
    const seen: unknown[] = [];
    await withOwnerCredentials((await getWorkbench('wb'))!, async () => {
      seen.push(lastPush().githubToken);
    });
    expect(seen).toEqual(['gh-owner']);
    expect(fleet.credentialPushes.map((p) => p.creds.githubToken)).toEqual(['gh-owner', 'gh-ben']);
  });

  it('lets a teammate stop only a turn they started', async () => {
    let release!: () => void;
    hold = new Promise((resolve) => { release = resolve; });
    await send(ANA, 'chat-1');
    await vi.waitFor(() => expect(agentExecs()).toHaveLength(1), { timeout: 5000 });
    expect(await call('POST', '/workbenches/chats/chat-1/cancel', BEN, {})).toMatchObject({
      status: 403, body: { code: 'not_your_turn' },
    });
    release();
    await settled('chat-1');

    hold = new Promise((resolve) => { release = resolve; });
    await send(BEN, 'chat-1');
    await vi.waitFor(() => expect(agentExecs()).toHaveLength(2), { timeout: 5000 });
    // Stopping your own turn needs only view access, not the rights to prompt.
    vi.spyOn(githubService, 'getRepository').mockResolvedValue({ permissions: { push: false, pull: true } } as Loose);
    resetRepoReadCacheForTests();
    expect((await call('POST', '/workbenches/chats/chat-1/cancel', BEN, {})).status).toBe(200);
    release();
    await settled('chat-1');
  });
});

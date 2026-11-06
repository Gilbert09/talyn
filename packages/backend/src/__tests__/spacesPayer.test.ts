import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createTestDb } from './helpers/testDb.js';
import {
  usageIntervals, usagePeriods, users, workbenchChats, workbenches, workspaces,
} from '../db/schema.js';
import type { FleetClient, FleetSandbox } from '../services/selfHosted/client.js';

vi.mock('../services/githubIdentity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/githubIdentity.js')>()),
  ensureGithubUserId: async () => null,
}));

const { canPrompt } = await import('../services/teams/access.js');
const { turnGitIdentityEnv } = await import('../services/teams/payer.js');
const { meterWorkbenchAwake } = await import('../services/workbenches/usageMeter.js');
const { chargeOwnerAt } = await import('../services/billing/usage/charge.js');
const { UsageSweep } = await import('../services/billing/usage/sweep.js');
const { resetUsageHookCacheForTests } = await import('../services/billing/usageHooks.js');
const { getWorkbench } = await import('../services/workbenches/store.js');
type PromptDeps = import('../services/teams/access.js').PromptDeps;
type PromptableItem = import('../services/teams/access.js').PromptableItem;

/**
 * Teams and Spaces, phase 3: who may prompt a teammate's session, the git
 * identity of a teammate's turn, and the meter that bills the box to the
 * payer of its latest turn.
 */

const SPACE_TEAMS: Record<string, string> = { 'space-1': 'team-1', 'space-2': 'team-2' };

/** Ana owns ws-ana. Ben is in team-1 with home ws-ben and a Claude account. Cy is in team-2. */
function promptDeps(overrides: Partial<PromptDeps> = {}): PromptDeps {
  return {
    ownedWorkspaceIds: async (userId) => new Set({ ana: ['ws-ana'], ben: ['ws-ben'], cy: ['ws-cy'], dee: [] }[userId] ?? []),
    memberTeamIds: async (userId) => ({ ana: ['team-1'], ben: ['team-1'], cy: ['team-2'], dee: ['team-1'] }[userId] ?? []),
    spaceTeams: async (ids) => new Map(ids.filter((id) => id in SPACE_TEAMS).map((id) => [id, SPACE_TEAMS[id]!])),
    canReadRepo: async (userId, _teamId, repo) => !(userId === 'ben' && repo === 'acme/secret'),
    homeWorkspace: async (_teamId, userId) => ({ ben: 'ws-ben', cy: 'ws-cy' }[userId] ?? null),
    agentStatus: async (workspaceId) =>
      workspaceId === 'ws-ben' ? { connectedAgents: ['claude'], reauthAgents: [] } : { connectedAgents: [], reauthAgents: [] },
    canPushRepo: async (_userId, _workspaceId, repo) => repo !== 'acme/readonly',
    ...overrides,
  };
}

const item = (overrides: Partial<PromptableItem> = {}): PromptableItem => ({
  workspaceId: 'ws-ana',
  spaceId: 'space-1',
  repoFullName: 'acme/app',
  agent: 'claude',
  ...overrides,
});

describe('canPrompt', () => {
  it.each<[string, string, PromptableItem, Partial<PromptDeps>, { ok: true; payer: unknown } | { ok: false; reason: string; status: number }]>([
    ['the owner, who pays as before', 'ana', item(), {}, { ok: true, payer: null }],
    ['the owner, in Personal', 'ana', item({ spaceId: null }), {}, { ok: true, payer: null }],
    ['a teammate with an account and push access', 'ben', item(), {}, { ok: true, payer: { userId: 'ben', workspaceId: 'ws-ben' } }],
    ['a teammate without push access', 'ben', item({ repoFullName: 'acme/readonly' }), {}, { ok: false, reason: 'no_push_access', status: 403 }],
    ['a teammate who cannot read the repo', 'ben', item({ repoFullName: 'acme/secret' }), {}, { ok: false, reason: 'not_found', status: 404 }],
    ['a teammate with no account for the agent', 'ben', item({ agent: 'codex' }), {}, { ok: false, reason: 'no_agent_account', status: 409 }],
    ['a teammate whose account needs a new sign-in', 'ben', item(), {
      agentStatus: async () => ({ connectedAgents: ['claude'], reauthAgents: ['claude'] }),
    }, { ok: false, reason: 'agent_reauth', status: 409 }],
    ['a teammate with no GitHub connection', 'ben', item(), { canPushRepo: async () => 'no_github' }, { ok: false, reason: 'no_github', status: 409 }],
    ['a teammate with no workspace of their own', 'dee', item(), {}, { ok: false, reason: 'no_home_workspace', status: 409 }],
    ['a teammate whose home is not their own', 'ben', item(), { homeWorkspace: async () => 'ws-cy' }, { ok: false, reason: 'no_home_workspace', status: 409 }],
    ['a member of another team', 'cy', item(), {}, { ok: false, reason: 'not_found', status: 404 }],
    ['a teammate, on a session in Personal', 'ben', item({ spaceId: null }), {}, { ok: false, reason: 'not_found', status: 404 }],
    ['a stranger', 'eve', item(), {}, { ok: false, reason: 'not_found', status: 404 }],
  ])('%s', async (_name, userId, target, overrides, expected) => {
    expect(await canPrompt(userId, target, promptDeps(overrides))).toMatchObject(expected);
  });

  it('asks for push access only after the cheaper checks pass', async () => {
    const canPushRepo = vi.fn(async () => true);
    await canPrompt('ben', item({ agent: 'codex' }), promptDeps({ canPushRepo }));
    await canPrompt('cy', item(), promptDeps({ canPushRepo }));
    expect(canPushRepo).not.toHaveBeenCalled();
    await canPrompt('ben', item(), promptDeps({ canPushRepo }));
    expect(canPushRepo).toHaveBeenCalledWith('ben', 'ws-ben', 'acme/app');
  });
});

describe('the payer in the database', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  const START = new Date('2026-11-10T12:00:00.000Z');
  const minutes = (n: number) => new Date(START.getTime() + n * 60_000);

  beforeEach(async () => {
    resetUsageHookCacheForTests();
    testDb = await createTestDb();
    await testDb.db.insert(users).values([
      { id: 'u-ana', email: 'ana@x.test', githubUserId: 100, githubUsername: 'ana' },
      { id: 'u-ben', email: 'ben@x.test', githubUserId: 200, githubUsername: 'ben' },
      { id: 'u-nogit', email: 'n@x.test' },
    ]);
    await testDb.db.insert(workspaces).values([
      { id: 'ws-a', ownerId: 'u-ana', name: 'A' },
      { id: 'ws-b', ownerId: 'u-ben', name: 'B' },
    ]);
    await testDb.db.insert(workbenches).values({
      id: 'wb', workspaceId: 'ws-a', repoFullName: 'acme/app', name: 'wb', branch: 'b', baseBranch: 'main',
      runtime: 'sandbox', agent: 'claude', sandboxId: 'talyn-wb-shared', sandboxState: 'running', status: 'ready',
      settings: { boxSize: 'standard' },
    });
    await testDb.db.insert(workbenchChats).values({ id: 'chat', workbenchId: 'wb', workspaceId: 'ws-a', title: 'T', agent: 'claude' });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await testDb.cleanup();
  });

  const open = () => testDb.db.select({ ownerId: usageIntervals.ownerId, payerUserId: usageIntervals.payerUserId })
    .from(usageIntervals).where(and(eq(usageIntervals.subjectId, 'wb'), isNull(usageIntervals.endedAt)));
  const used = async (ownerId: string) => (await testDb.db.select({ usedWsec: usagePeriods.usedWsec })
    .from(usagePeriods).where(eq(usagePeriods.ownerId, ownerId)))[0]?.usedWsec ?? 0;

  it.each([
    ['ben', 'u-ben', { GIT_AUTHOR_NAME: 'ben', GIT_AUTHOR_EMAIL: '200+ben@users.noreply.github.com' }],
  ])('gives %s turn its own git identity', async (_name, userId, expected) => {
    expect(await turnGitIdentityEnv(userId)).toMatchObject({
      ...expected, GIT_COMMITTER_NAME: expected.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: expected.GIT_AUTHOR_EMAIL,
    });
  });

  it("refuses a payer with no GitHub identity, so a commit never carries the owner's name", async () => {
    await expect(turnGitIdentityEnv('u-nogit')).rejects.toMatchObject({ status: 409, code: 'payer_identity_unavailable' });
  });

  it('closes the interval on a payer change and lands the usage on each payer period', async () => {
    vi.useFakeTimers({ now: START, toFake: ['Date'] });
    const row = (await getWorkbench('wb'))!;
    await meterWorkbenchAwake(row, { payer: null });
    expect(await open()).toEqual([{ ownerId: 'u-ana', payerUserId: null }]);

    vi.setSystemTime(minutes(10));
    await meterWorkbenchAwake(row, { payer: { userId: 'u-ben', workspaceId: 'ws-b' } });
    expect(await open()).toEqual([{ ownerId: 'u-ben', payerUserId: 'u-ben' }]);
    const closed = await testDb.db.select({ ownerId: usageIntervals.ownerId, endReason: usageIntervals.endReason })
      .from(usageIntervals).where(eq(usageIntervals.endReason, 'payer_change'));
    expect(closed).toEqual([{ ownerId: 'u-ana', endReason: 'payer_change' }]);

    // Idle time keeps billing Ben until the next turn.
    await chargeOwnerAt('u-ben', minutes(15));
    await chargeOwnerAt('u-ana', minutes(15));
    expect(await used('u-ana')).toBe(600);
    expect(await used('u-ben')).toBe(300);

    // The same payer again changes nothing.
    await meterWorkbenchAwake(row, { payer: { userId: 'u-ben', workspaceId: 'ws-b' } });
    expect(await testDb.db.select({ id: usageIntervals.id }).from(usageIntervals)).toHaveLength(2);
  });

  it('reads the payer from the latest turn when none is given', async () => {
    await testDb.db.update(workbenchChats).set({ payerUserId: 'u-ben', payerWorkspaceId: 'ws-b', turnStartedAt: new Date() })
      .where(eq(workbenchChats.id, 'chat'));
    await meterWorkbenchAwake((await getWorkbench('wb'))!);
    expect(await open()).toEqual([{ ownerId: 'u-ben', payerUserId: 'u-ben' }]);
  });

  it.each([
    ['the latest turn payer', 'u-ben', 'ws-b', { ownerId: 'u-ben', payerUserId: 'u-ben' }],
    ['the workspace owner when no teammate paid', null, null, { ownerId: 'u-ana', payerUserId: null }],
  ])('opens a missed interval in the sweep for %s', async (_name, payerUserId, payerWorkspaceId, expected) => {
    await testDb.db.update(workbenchChats).set({ payerUserId, payerWorkspaceId, turnStartedAt: new Date() })
      .where(eq(workbenchChats.id, 'chat'));
    const box = { id: 'talyn-wb-shared', status: 'idle' } as FleetSandbox;
    const client = {
      listSandboxes: async () => ({ sandboxes: [box] }),
      getSandbox: async () => ({ sandbox: box, terminal: false }),
    } as unknown as FleetClient;
    const result = await new UsageSweep(async () => [{ client, gateway: false }]).run(START);
    expect(result.opened).toBe(1);
    expect(await open()).toEqual([expected]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { claudeTurnLines, FakeFleet, isAgentTurn } from './helpers/fakeFleet.js';
import { callPublic, mintToken, startPublicApi, type Loose } from './helpers/publicApi.js';
import { apiWebhookDeliveries, repositories, workspaces } from '../db/schema.js';

/**
 * The real emitters reach the dispatcher: a session started and driven
 * through `/v1` against a fake fleet produces `session.created`,
 * `session.updated`, `chat.turn_started` and `chat.turn_completed` rows, and
 * the pull request and merge queue emitters in websocket.ts send their signals.
 */

vi.mock('../services/selfHosted/credentials.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/selfHosted/credentials.js')>()),
  getSelfHostedCredentials: async () => ({ claudeToken: 'sk-ant-oat-claude' }),
  fleetAgentStatus: async () => ({ connectedAgents: ['claude'], reauthAgents: [] }),
}));

vi.mock('../services/cloudProviders/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/cloudProviders/registry.js')>()),
  getCloudProvider: () => ({ type: 'selfhosted' }),
}));

vi.mock('../services/repoDefaultBranch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/repoDefaultBranch.js')>()),
  reconcileDefaultBranch: async (input: { stored: string }) => input.stored || 'main',
}));

const { settleArchivesForTests } = await import('../services/workbenches/lifecycle.js');
const { setWorkbenchFleetClientForTests } = await import('../services/workbenches/sandboxRuntime.js');
const { getChat, getWorkbench } = await import('../services/workbenches/store.js');
const { githubService } = await import('../services/github.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');
const { dispatchWebhookSignal, resetWebhookDispatchForTests, settleWebhookDispatchForTests } = await import(
  '../services/apiWebhooks/dispatch.js'
);
const { setWebhookSignalHandler } = await import('../services/apiWebhooks/signals.js');
const { followSessionEmits } = await import('../services/apiWebhooks/register.js');
const { insertEndpoint } = await import('../services/apiWebhooks/store.js');
const { emitMergeQueueBlocked, emitPullRequestUpdated } = await import('../services/websocket.js');

describe('webhook emitters', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let api: Awaited<ReturnType<typeof startPublicApi>>;
  let token: string;
  let stopFollowing: () => void;
  const signals: Loose[] = [];

  beforeEach(async () => {
    vi.stubEnv('PUBLIC_API_ENABLED', 'true');
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    vi.stubEnv('FLEET_API_TOKEN', 'fleet-token');
    vi.stubEnv('FLEET_PINNED_ENDPOINT', '');
    vi.stubEnv('FLEET_GATEWAY_TOKEN', '');
    vi.stubEnv('FLEET_ALLOWED', 'true');
    vi.stubEnv('TALYN_TOKEN_KEY', Buffer.from('k'.repeat(32)).toString('base64'));
    resetFeatureFlagsForTests();
    resetWebhookDispatchForTests();
    signals.length = 0;
    setWebhookSignalHandler((s) => {
      signals.push(s);
      dispatchWebhookSignal(s);
    });
    stopFollowing = followSessionEmits();
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await testDb.db.insert(workspaces).values({ id: 'ws-a', ownerId: 'owner-a', name: 'A' });
    await testDb.db.insert(repositories).values({
      id: 'repo-a', workspaceId: 'ws-a', name: 'acme/app', url: 'https://github.com/acme/app', defaultBranch: 'main',
    });
    await insertEndpoint({ ownerId: 'owner-a', workspaceId: null, url: 'https://hooks.example.com/x', description: null, eventTypes: [], enabled: true });
    vi.spyOn(githubService, 'branchExists').mockResolvedValue(false);
    vi.spyOn(githubService, 'getVerifiedAccessToken').mockResolvedValue('gh-token');
    vi.spyOn(githubService, 'getRefSha').mockRejectedValue(new Error('offline'));
    const fleet = new FakeFleet();
    fleet.handler = async (script) => {
      if (isAgentTurn(script)) return { stdout: claudeTurnLines('sess-1', 'done') };
      if (script.includes('git commit-tree')) return { stdout: `${'c'.repeat(40)}\n` };
      return { exitCode: 0, stdout: '' };
    };
    setWorkbenchFleetClientForTests(async () => fleet.asClient());
    token = await mintToken('owner-a', { scopes: ['sessions:write'] });
    api = await startPublicApi();
  });

  afterEach(async () => {
    await settleArchivesForTests();
    await settleWebhookDispatchForTests();
    stopFollowing();
    setWebhookSignalHandler(null);
    resetWebhookDispatchForTests();
    setWorkbenchFleetClientForTests(null);
    await api.close();
    await testDb.cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetFeatureFlagsForTests();
  });

  it('turns a session started with a prompt into created, updated and turn events', async () => {
    const res = await callPublic(api.base, 'POST', '/sessions', {
      token,
      body: { workspace_id: 'ws-a', repository_id: 'repo-a', agent: 'claude', prompt: 'add a readme' },
    });
    expect(res.status).toBe(201);
    const chatId = res.body.chats[0].id;
    await vi.waitFor(async () => expect((await getWorkbench(res.body.id))?.status).toBe('ready'), { timeout: 5000 });
    await vi.waitFor(
      async () => {
        expect((await getChat(chatId))?.status).toBe('idle');
        expect(signals.some((s) => s.kind === 'turn_completed')).toBe(true);
      },
      { timeout: 5000 },
    );
    await settleWebhookDispatchForTests();

    expect(signals).toContainEqual({ kind: 'session_created', workspaceId: 'ws-a', sessionId: res.body.id });
    expect(signals).toContainEqual({ kind: 'turn_started', workspaceId: 'ws-a', chatId, turn: 1 });
    expect(signals).toContainEqual({ kind: 'turn_completed', workspaceId: 'ws-a', chatId, turn: 1, finalStatus: 'idle' });

    const rows = await testDb.db.select().from(apiWebhookDeliveries);
    const types = rows.map((r) => r.eventType);
    expect(types.filter((t) => t === 'session.created')).toHaveLength(1);
    expect(types.filter((t) => t === 'chat.turn_started')).toHaveLength(1);
    expect(types.filter((t) => t === 'chat.turn_completed')).toHaveLength(1);
    const updated = rows.filter((r) => r.eventType === 'session.updated');
    expect(updated.map((r) => (r.payload as Loose).data.previous_attributes)).toContainEqual({ status: 'provisioning' });
  });

  it('sends signals from the pull request and merge queue emitters', () => {
    emitPullRequestUpdated('ws-a', {
      id: 'pr-1', taskId: null, repositoryId: 'repo-a', owner: 'acme', repo: 'app', number: 7, state: 'open',
      lastSummary: { title: 'T' }, codeReview: null,
    });
    emitMergeQueueBlocked('ws-a', { pullRequestId: 'pr-1', owner: 'acme', repo: 'app', number: 7, title: 'T', url: 'u', reason: 'conflicts', attempts: 2 });
    expect(signals).toEqual([
      { kind: 'pull_request', workspaceId: 'ws-a', pullRequest: { id: 'pr-1', state: 'open', lastSummary: { title: 'T' }, codeReview: null } },
      { kind: 'merge_queue_blocked', workspaceId: 'ws-a', pullRequestId: 'pr-1', reason: 'conflicts', attempts: 2 },
    ]);
  });
});

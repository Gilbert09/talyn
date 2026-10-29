import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TALYN_TOOLS_NOTE, workbenchTurnPrompt, type WorkbenchAgent } from '@talyn/shared';
import { repositories, workspaces } from '../db/schema.js';
import { workspaceMayUseMcpServers } from '../services/mcpServersAccess.js';
import * as sandboxRun from '../services/selfHosted/sandboxRun.js';
import { readSessionMcpToken } from '../services/sessionMcpToken.js';
import { createWorkbenchSandbox } from '../services/workbenches/lifecycle.js';
import * as runtime from '../services/workbenches/sandboxRuntime.js';
import { getWorkbench, insertWorkbench } from '../services/workbenches/store.js';
import { sessionHasTalynMcp, talynMcpPublicUrl } from '../services/workbenches/talynMcp.js';
import { FakeFleet } from './helpers/fakeFleet.js';
import { createTestDb, seedUser } from './helpers/testDb.js';

vi.mock('../services/mcpServersAccess.js', () => ({ workspaceMayUseMcpServers: vi.fn(async () => true) }));
vi.mock('../services/mcpServers/store.js', async (original) => ({
  ...(await original<typeof import('../services/mcpServers/store.js')>()),
  mcpServersForDispatch: vi.fn(async () => [
    { id: 'm1', name: 'linear', url: 'https://mcp.linear.app/mcp', description: null, authKind: 'bearer', inject: null, tools: null, secret: 'linear-key' },
    { id: 'm2', name: 'talyn', url: 'https://example.com/mcp', description: null, authKind: 'bearer', inject: null, tools: null, secret: 'theirs' },
  ]),
}));

const URL_ENVS = ['TALYN_PUBLIC_API_URL', 'POSTHOG_OAUTH_REDIRECT_URI', 'SLACK_OAUTH_REDIRECT_URI'] as const;

describe('talynMcpPublicUrl', () => {
  beforeEach(() => { for (const name of URL_ENVS) vi.stubEnv(name, ''); });
  afterEach(() => vi.unstubAllEnvs());

  it.each<[string, Partial<Record<(typeof URL_ENVS)[number], string>>, string | null]>([
    ['nothing configured', {}, null],
    ['an explicit origin', { TALYN_PUBLIC_API_URL: 'https://prod.talyn.dev' }, 'https://prod.talyn.dev/api/v1/mcp'],
    ['an explicit origin with a path', { TALYN_PUBLIC_API_URL: 'https://prod.talyn.dev/ignored/' }, 'https://prod.talyn.dev/api/v1/mcp'],
    ['an explicit http origin', { TALYN_PUBLIC_API_URL: 'http://prod.talyn.dev' }, null],
    ['an explicit private host', { TALYN_PUBLIC_API_URL: 'https://localhost:4747' }, null],
    ['an explicit private address', { TALYN_PUBLIC_API_URL: 'https://10.0.0.4' }, null],
    ['an explicit value that is not a URL', { TALYN_PUBLIC_API_URL: 'prod.talyn.dev' }, null],
    ['the PostHog callback', { POSTHOG_OAUTH_REDIRECT_URI: 'https://prod.talyn.dev/api/v1/posthog/oauth/callback' }, 'https://prod.talyn.dev/api/v1/mcp'],
    ['the Slack callback', { SLACK_OAUTH_REDIRECT_URI: 'https://prod.talyn.dev/api/v1/slack/oauth/callback' }, 'https://prod.talyn.dev/api/v1/mcp'],
    ['a callback outside the API', { POSTHOG_OAUTH_REDIRECT_URI: 'https://app.talyn.dev/posthog/callback' }, null],
    ['a local callback', { SLACK_OAUTH_REDIRECT_URI: 'http://localhost:4747/api/v1/slack/oauth/callback' }, null],
    ['an explicit value over a callback', {
      TALYN_PUBLIC_API_URL: 'https://api.talyn.test', POSTHOG_OAUTH_REDIRECT_URI: 'https://prod.talyn.dev/api/v1/posthog/oauth/callback',
    }, 'https://api.talyn.test/api/v1/mcp'],
  ])('%s', (_name, env, expected) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    expect(talynMcpPublicUrl()).toBe(expected);
  });
});

describe("the session box's create body", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: FakeFleet;

  beforeEach(async () => {
    for (const name of URL_ENVS) vi.stubEnv(name, '');
    vi.stubEnv('TALYN_PUBLIC_API_URL', 'https://api.talyn.test');
    vi.stubEnv('TALYN_TOKEN_KEY', randomBytes(32).toString('base64'));
    testDb = await createTestDb();
    await seedUser(testDb.db);
    await testDb.db.insert(workspaces).values({ id: 'ws', ownerId: 'user-test', name: 'Test' });
    await testDb.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'a/b', url: 'https://github.com/a/b' });
    await insertWorkbench({ id: 'wb', workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'a/b', name: 'paris',
      branch: 'paris', baseBranch: 'main', runtime: 'sandbox', agent: 'claude', status: 'provisioning' });
    fleet = new FakeFleet();
    vi.spyOn(sandboxRun, 'resolveSandboxCredentials').mockResolvedValue({ ok: true, creds: { claudeToken: 'agent-token' }, githubToken: 'github-token' });
    vi.spyOn(sandboxRun, 'resolveRepository').mockResolvedValue({ slug: 'a/b', defaultBranch: 'main' });
    vi.spyOn(runtime, 'fleetCreateTarget').mockResolvedValue({ client: fleet.asClient() });
    vi.spyOn(runtime, 'gitAuthorFor').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await testDb.cleanup();
  });

  const create = async () => {
    const made = await createWorkbenchSandbox((await getWorkbench('wb'))!, 'talyn-wb-paris');
    expect(made.ok).toBe(true);
    return fleet.created[0];
  };

  it('adds the talyn server with the session token, replacing a workspace server of that name', async () => {
    const body = await create();
    const token = await readSessionMcpToken('wb');
    expect(token).toMatch(/^talyn_mcs_/);
    expect(body.mcpServers?.map((s) => s.name)).toEqual(['linear', 'talyn']);
    expect(body.mcpServers?.find((s) => s.name === 'talyn')).toMatchObject({
      url: 'https://api.talyn.test/api/v1/mcp', transport: 'http', secret: token, inject: { kind: 'bearer' },
    });
    expect(await sessionHasTalynMcp({ id: 'wb', workspaceId: 'ws' })).toBe(true);
  });

  it('keeps the same token when the box is created again (restore, move)', async () => {
    await create();
    const first = await readSessionMcpToken('wb');
    await createWorkbenchSandbox((await getWorkbench('wb'))!, 'talyn-wb-paris-r1');
    expect(fleet.created[1].mcpServers?.find((s) => s.name === 'talyn')?.secret).toBe(first);
  });

  it('adds Talyn even when the workspace may not use MCP servers', async () => {
    vi.mocked(workspaceMayUseMcpServers).mockResolvedValueOnce(false);
    expect((await create()).mcpServers?.map((s) => s.name)).toEqual(['talyn']);
  });

  it('leaves the body as it was when the deployment has no public MCP URL', async () => {
    vi.stubEnv('TALYN_PUBLIC_API_URL', '');
    const body = await create();
    expect(body.mcpServers?.map((s) => s.name)).toEqual(['linear', 'talyn']);
    expect(body.mcpServers?.find((s) => s.name === 'talyn')?.secret).toBe('theirs');
    expect(await readSessionMcpToken('wb')).toBeNull();
    expect(await sessionHasTalynMcp({ id: 'wb', workspaceId: 'ws' })).toBe(false);
  });

  it('still creates the box when the token cannot be minted', async () => {
    vi.stubEnv('TALYN_TOKEN_KEY', '');
    const body = await create();
    expect(body.mcpServers?.find((s) => s.name === 'talyn')?.secret).toBe('theirs');
  });
});

describe('the turn prompt', () => {
  it.each<[WorkbenchAgent, boolean]>([['claude', true], ['claude', false], ['codex', true], ['codex', false]])(
    '%s with talyn tools %s',
    (agent, talynTools) => {
      const out = workbenchTurnPrompt({
        agent, text: 'hello', planMode: false, autoCreatePr: false,
        createPr: { branch: 'b', baseBranch: 'main' }, talynTools,
      });
      const hidden = agent === 'claude' ? out.appendSystemPrompt ?? '' : out.prompt;
      expect(hidden.includes(TALYN_TOOLS_NOTE)).toBe(talynTools);
      expect(TALYN_TOOLS_NOTE).toContain('`talyn` MCP server');
      expect(TALYN_TOOLS_NOTE).toContain('after your reply ends');
    }
  );
});

import type { Request, RequestHandler, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repositories, workspaces } from '../db/schema.js';
import { fleetPublicRoutes } from '../routes/fleet.js';
import { githubService } from '../services/github.js';
import { mcpIntegrationSecrets } from '../services/mcpServers/dispatch.js';
import { resolveRunCredential } from '../services/selfHosted/accountSelection.js';
import { resolveRunCredentials } from '../services/selfHosted/runCredentials.js';
import { processArchive, restoreWorkbench, sweepPendingArchives } from '../services/workbenches/lifecycle.js';
import * as sandboxRun from '../services/selfHosted/sandboxRun.js';
import { ensureSessionMcpToken, validateSessionMcpToken } from '../services/sessionMcpToken.js';
import { refreshSandboxCredentials, setWorkbenchFleetClientForTests } from '../services/workbenches/sandboxRuntime.js';
import {
  backfillCredentialArchives, claimMove, getWorkbench, insertWorkbench, markArchive,
  setMoveTargetHost, updateWorkbench,
} from '../services/workbenches/store.js';
import { FakeFleet, isWorkSaveScript } from './helpers/fakeFleet.js';
import { createTestDb, seedUser } from './helpers/testDb.js';

vi.mock('../services/github.js', () => ({ githubService: { getVerifiedAccessToken: vi.fn(async () => 'github-token') } }));
vi.mock('../services/selfHosted/accountSelection.js', () => ({ resolveRunCredential: vi.fn(async () => ({ token: 'agent-token' })) }));
vi.mock('../services/mcpServers/dispatch.js', () => ({ mcpIntegrationSecrets: vi.fn(async () => ({ linear: 'tool-token' })) }));
vi.mock('../services/websocket.js', async (original) => ({
  ...(await original<typeof import('../services/websocket.js')>()), broadcastToWorkspace: () => undefined,
}));

const ID = 'credentials-test';
const BOX = 'talyn-wb-credentials';
const TARGET = `${BOX}-r1`;
const HOST = 'source-host';
const TARGET_HOST = 'target-host';
const ERROR = "fatal: could not read Username for 'http://127.0.0.1:8080': No such device or address";
const archived = { archivedAt: new Date(), status: 'archived' };
// A fixed lease far ahead: a lease computed when the file loads can expire before a slow CI runner reaches the row.
const LIVE_LEASE = new Date('2999-01-01T00:00:00Z');
type Patch = Parameters<typeof updateWorkbench>[1] & { settings?: Record<string, unknown> };

// Call the real route handler without opening a socket.
const route = fleetPublicRoutes().stack.find((layer) => layer.route?.path === '/run-credentials')!.route;
const handler = route.stack[0].handle as RequestHandler;
async function credentials(runId = BOX, host = HOST) {
  let status = 200;
  let body: unknown;
  const res = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; return this; },
  };
  await handler({ body: { host, runId }, headers: { authorization: 'Bearer fleet-test' } } as Request,
    res as Response, vi.fn());
  return { status, body };
}

describe('session credentials during lifecycle operations', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: FakeFleet;
  const row = async () => (await getWorkbench(ID))!;

  beforeEach(async () => {
    vi.stubEnv('FLEET_REPORT_TOKEN', 'fleet-test');
    testDb = await createTestDb();
    await seedUser(testDb.db);
    await testDb.db.insert(workspaces).values({ id: 'ws', ownerId: 'user-test', name: 'Test' });
    await testDb.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'a/b', url: 'https://github.com/a/b' });
    await insertWorkbench({ id: ID, workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'a/b',
      name: 'paris', branch: 'paris', baseBranch: 'main', runtime: 'sandbox', agent: 'claude',
      status: 'ready', sandboxState: 'running', sandboxId: BOX, fleetHost: HOST });
    fleet = new FakeFleet();
    setWorkbenchFleetClientForTests(async () => fleet.asClient());
  });

  afterEach(async () => {
    setWorkbenchFleetClientForTests(null);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await testDb.cleanup();
  });

  it.each<[string, Patch, string, string]>([
    ['current session', {}, BOX, HOST],
    ['pending archive', { ...archived, archivePendingAt: new Date() }, BOX, HOST],
    ['claimed archive', { ...archived, archivePendingAt: new Date(), archiveLeaseUntil: LIVE_LEASE }, BOX, HOST],
    ['retrying archive', { ...archived, archivePendingAt: new Date(), archiveRetryAt: new Date(), archiveFailures: 9 }, BOX, HOST],
    ['move source after archive request', { ...archived, status: 'moving', settings: { moveSandboxId: TARGET, moveTargetHost: TARGET_HOST } }, BOX, HOST],
    ['move target', { status: 'moving', settings: { moveSandboxId: TARGET, moveTargetHost: TARGET_HOST } }, TARGET, TARGET_HOST],
    ['restore from current box', { ...archived, restoreRequestedAt: new Date() }, BOX, HOST],
    ['recorded fleet ID', { settings: { fleetSandboxId: `${BOX}--abcdef` } }, `${BOX}--abcdef`, HOST],
    ['recorded target fleet ID', { status: 'moving', settings: { moveSandboxId: TARGET, moveTargetHost: TARGET_HOST, moveFleetSandboxId: `${TARGET}--abcdef` } }, `${TARGET}--abcdef`, TARGET_HOST],
  ])('serves credentials for %s', async (_name, patch, box, host) => {
    await updateWorkbench(ID, patch);
    expect(await credentials(box, host)).toEqual({ status: 200, body: {
      githubToken: 'github-token', anthropicKey: 'agent-token', repo: 'a/b', integrations: { linear: 'tool-token' },
    } });
    expect(githubService.getVerifiedAccessToken).toHaveBeenCalledWith('ws');
    expect(resolveRunCredential).toHaveBeenCalledWith('ws', 'claude', expect.any(Object));
    expect(mcpIntegrationSecrets).toHaveBeenCalledWith({ workspaceId: 'ws', metadata: undefined });
  });

  it.each<[string, Patch, string, string]>([
    ['completed archive', archived, BOX, HOST],
    ['unrelated box', {}, 'talyn-wb-unrelated', HOST],
    ['old generation', { sandboxId: TARGET }, BOX, HOST],
    ['stale move target', { settings: { moveSandboxId: TARGET, moveTargetHost: TARGET_HOST } }, TARGET, TARGET_HOST],
    ['stale fleet alias', { sandboxId: TARGET, settings: { fleetSandboxId: `${BOX}--abcdef` } }, `${BOX}--abcdef`, HOST],
    ['unrecorded fleet alias', {}, `${BOX}--abcdef`, HOST],
    ['wrong source host', {}, BOX, TARGET_HOST],
    ['source host requesting target', { status: 'moving', settings: { moveSandboxId: TARGET, moveTargetHost: TARGET_HOST } }, TARGET, HOST],
    ['target with no recorded host', { status: 'moving', settings: { moveSandboxId: TARGET } }, TARGET, HOST],
    ['deleted box during restore', { ...archived, sandboxState: 'deleted', restoreRequestedAt: new Date() }, BOX, HOST],
    ['unrelated box during restore', { ...archived, restoreRequestedAt: new Date() }, TARGET, HOST],
  ])('returns 403 for %s', async (_name, patch, box, host) => {
    await updateWorkbench(ID, patch);
    expect(await credentials(box, host)).toEqual({ status: 403, body: { success: false, error: 'forbidden' } });
    expect(githubService.getVerifiedAccessToken).not.toHaveBeenCalled();
    expect(resolveRunCredential).not.toHaveBeenCalled();
    expect(mcpIntegrationSecrets).not.toHaveBeenCalled();
  });

  it('records the target host and exact fleet ID after the move claim', async () => {
    await claimMove(ID, BOX, TARGET, 'Saving work');
    expect((await credentials()).status).toBe(200);
    expect((await credentials(TARGET, TARGET_HOST)).status).toBe(403);
    await setMoveTargetHost(ID, BOX, TARGET, TARGET_HOST, `${TARGET}--abcdef`);
    expect((await credentials(TARGET, TARGET_HOST)).status).toBe(200);
    expect((await credentials(`${TARGET}--abcdef`, TARGET_HOST)).status).toBe(200);
  });

  it('serves credentials while restore checks the live box', async () => {
    await updateWorkbench(ID, archived);
    const getSandbox = fleet.getSandbox.bind(fleet);
    vi.spyOn(fleet, 'getSandbox').mockImplementation(async (...args) => {
      expect((await row()).restoreRequestedAt).not.toBeNull();
      expect((await credentials()).status).toBe(200);
      return getSandbox(...args);
    });
    expect(await restoreWorkbench(ID)).toMatchObject({ archivedAt: null, restoreRequestedAt: null, sandboxId: BOX });
  });

  it('retries a refused save beyond the failure limit and clears the error after success', async () => {
    let refused = true;
    fleet.handler = async (script) => {
      if (!isWorkSaveScript(script, 'archive')) return {};
      const result = refused ? { ok: false } : await resolveRunCredentials(HOST, BOX);
      return result.ok ? { exitCode: 0 } : { exitCode: 1, stderr: ERROR };
    };
    await markArchive(ID);
    await updateWorkbench(ID, { archiveFailures: 7 });
    await processArchive(ID);
    expect(await row()).toMatchObject({ archiveFailures: 8, status: 'archived', archivePendingAt: expect.any(Date), statusMessage: expect.stringContaining(ERROR) });
    expect(fleet.deleted).toEqual([]);
    const count = fleet.scripts.length;
    await sweepPendingArchives();
    expect(fleet.scripts).toHaveLength(count);
    refused = false;
    await updateWorkbench(ID, { archivePendingAt: new Date(0), archiveRetryAt: new Date(0) });
    await sweepPendingArchives();
    expect(await row()).toMatchObject({ archivePendingAt: null, archiveRetryAt: null, archiveFailures: 0, statusMessage: null, sandboxState: 'deleted' });
    expect(fleet.deleted).toEqual([BOX]);
  });

  it.each(['running', 'suspended'] as const)('re-arms a failed archive once with a %s box', async (sandboxState) => {
    await updateWorkbench(ID, { ...archived, sandboxState, status: 'archiveError', statusMessage: ERROR, archiveFailures: 8 });
    expect(await backfillCredentialArchives()).toBe(1);
    const pending = (await row()).archivePendingAt;
    expect(pending).not.toBeNull();
    expect(await backfillCredentialArchives()).toBe(0);
    expect((await row()).archivePendingAt).toEqual(pending);
    await updateWorkbench(ID, { archivePendingAt: null });
    expect(await backfillCredentialArchives()).toBe(0);
    await updateWorkbench(ID, { archivePendingAt: new Date(0) });
    fleet.handler = async (script) => isWorkSaveScript(script, 'archive')
      ? { exitCode: (await resolveRunCredentials(HOST, BOX)).ok ? 0 : 1 } : {};
    await sweepPendingArchives();
    expect(await row()).toMatchObject({ archivePendingAt: null, sandboxState: 'deleted', statusMessage: null });
    expect(await backfillCredentialArchives()).toBe(0);
  });

  it.each<Patch>([
    { sandboxState: 'deleted' }, { sandboxState: 'lost' }, { sandboxId: null }, { runtime: 'local' },
    { statusMessage: 'Protected branch' }, { archivedAt: null, status: 'ready' },
    { archivePendingAt: new Date() }, { restoreRequestedAt: new Date() },
    { archiveLeaseUntil: LIVE_LEASE }, { status: 'moving' },
  ])('does not re-arm an ineligible archive: %j', async (patch) => {
    await updateWorkbench(ID, { ...archived, statusMessage: ERROR, ...patch });
    const before = await row();
    expect(await backfillCredentialArchives()).toBe(0);
    expect(await row()).toEqual(before);
  });
});

describe("Talyn's own MCP server in a session's credentials", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let fleet: FakeFleet;

  beforeEach(async () => {
    vi.stubEnv('FLEET_REPORT_TOKEN', 'fleet-test');
    vi.stubEnv('TALYN_PUBLIC_API_URL', 'https://api.talyn.test');
    vi.stubEnv('TALYN_TOKEN_KEY', Buffer.from('k'.repeat(32)).toString('base64'));
    testDb = await createTestDb();
    await seedUser(testDb.db);
    await testDb.db.insert(workspaces).values({ id: 'ws', ownerId: 'user-test', name: 'Test' });
    await testDb.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'a/b', url: 'https://github.com/a/b' });
    await insertWorkbench({ id: ID, workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'a/b',
      name: 'paris', branch: 'paris', baseBranch: 'main', runtime: 'sandbox', agent: 'claude',
      status: 'ready', sandboxState: 'running', sandboxId: BOX, fleetHost: HOST });
    fleet = new FakeFleet();
    setWorkbenchFleetClientForTests(async () => fleet.asClient());
    vi.spyOn(sandboxRun, 'resolveSandboxCredentials').mockResolvedValue({ ok: true, creds: { claudeToken: 'agent-token' }, githubToken: 'github-token' });
  });

  afterEach(async () => {
    setWorkbenchFleetClientForTests(null);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    await testDb.cleanup();
  });

  it.each([
    ['a host pull after a fleetd restart', async () => ((await credentials()).body as { integrations?: Record<string, string> }).integrations],
    ['the per-turn credential push', async () => {
      await refreshSandboxCredentials((await getWorkbench(ID))!);
      return fleet.credentialPushes.at(-1)!.creds.integrations as Record<string, string> | undefined;
    }],
  ])('%s carries the talyn token beside the workspace servers', async (_name, read) => {
    const token = await ensureSessionMcpToken({ id: ID, workspaceId: 'ws' });
    expect(await read()).toEqual({ linear: 'tool-token', talyn: token });
  });

  it.each([
    ['a host pull', async () => ((await credentials()).body as { integrations?: Record<string, string> }).integrations],
    ['a push', async () => {
      await refreshSandboxCredentials((await getWorkbench(ID))!);
      return fleet.credentialPushes.at(-1)!.creds.integrations as Record<string, string> | undefined;
    }],
  ])('%s for a box made before the session had a token sends none', async (_name, read) => {
    expect(await read()).toEqual({ linear: 'tool-token' });
  });

  it('sends no talyn token when this deployment has no public MCP URL', async () => {
    vi.stubEnv('TALYN_PUBLIC_API_URL', '');
    await ensureSessionMcpToken({ id: ID, workspaceId: 'ws' });
    expect(((await credentials()).body as { integrations?: Record<string, string> }).integrations).toEqual({ linear: 'tool-token' });
  });

  it('stops serving the token once the session is archived', async () => {
    const token = await ensureSessionMcpToken({ id: ID, workspaceId: 'ws' });
    await updateWorkbench(ID, { ...archived, archivePendingAt: new Date() });
    // The box still gets its credentials to save the work; the token itself is refused at /mcp.
    expect(((await credentials()).body as { integrations?: Record<string, string> }).integrations).toEqual({ linear: 'tool-token', talyn: token });
    expect(await validateSessionMcpToken(token)).toBeNull();
  });
});

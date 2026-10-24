import * as runtime from '../services/workbenches/sandboxRuntime.js';
import { invokeRoute } from './helpers/invokeRoute.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { FakeFleet } from './helpers/fakeFleet.js';
import { repositories, workspaces } from '../db/schema.js';
import { insertWorkbench, getWorkbench } from '../services/workbenches/store.js';
import { workbenchRoutes } from '../routes/workbenches.js';
import { resetFeatureFlagsForTests } from '../services/featureFlags.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPreviewPatchCommand, getPreviewPatch, MAX_PREVIEW_PATCH_BYTES } from '../services/preview/workbenchPatch.js';
import { runCapture, setWorkbenchFleetClientForTests } from '../services/workbenches/sandboxRuntime.js';
import type { WorkbenchRow } from '../services/workbenches/store.js';

const originalRunCapture = runtime.runCapture;
vi.spyOn(runtime, 'runCapture');
afterAll(() => vi.restoreAllMocks());

const row = { baseBranch: 'main' } as WorkbenchRow;
const sha = 'a'.repeat(40);
const reply = (stdout: string, exitCode = 0) => ({ stdout, stdoutBytes: Buffer.from(stdout), exitCode, stderr: '' });

describe('preview patch', () => {
  it('uses the diff merge base and leaves the Git index untouched', () => {
    const script = buildPreviewPatchCommand(row);
    expect(script).toContain('git merge-base HEAD');
    expect(script).toContain('git diff --binary');
    expect(script).toContain('git ls-files --others --exclude-standard -z');
    expect(script).toContain('read -r -d');
    expect(script).toContain('--no-index -- /dev/null "./$f"');
    expect(script).toContain('[ "$rc" -le 1 ]');
    expect(script).toContain(`head -c ${MAX_PREVIEW_PATCH_BYTES + 1}`);
    expect(script).not.toMatch(/git (add|reset|update-index|checkout)/);
  });

  it('quotes a base branch that contains shell syntax', () => {
    const script = buildPreviewPatchCommand({ baseBranch: "feat/'; touch /tmp/nope; '" });
    expect(script).toContain("'origin/feat/'\\''; touch /tmp/nope; '\\''' ");
  });

  it('returns the base and exact patch from one exec', async () => {
    const patch = 'diff --git a/a b/a\nGIT binary patch\nliteral 1\nabc\n';
    vi.mocked(runCapture).mockResolvedValue(reply(`${sha}\n${patch}`));
    expect(await getPreviewPatch(row)).toEqual({ base: sha, patch });
    expect(runCapture).toHaveBeenLastCalledWith(row, buildPreviewPatchCommand(row), { timeoutMs: 60000, follow: true });
  });

  it.each([42, 2])('refuses exec exit %s', async (exitCode) => {
    vi.mocked(runCapture).mockResolvedValue(reply('', exitCode));
    await expect(getPreviewPatch(row)).rejects.toMatchObject({ status: exitCode === 42 ? 413 : 502 });
  });

  it('refuses an oversized patch', async () => {
    vi.mocked(runCapture).mockResolvedValue(reply(`${sha}\n${'x'.repeat(MAX_PREVIEW_PATCH_BYTES + 1)}`));
    await expect(getPreviewPatch(row)).rejects.toMatchObject({ status: 413 });
  });

  it('refuses an incomplete result', async () => {
    vi.mocked(runCapture).mockResolvedValue(reply('partial'));
    await expect(getPreviewPatch(row)).rejects.toMatchObject({ status: 502 });
  });
});


describe('preview workbench routes', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  const router = workbenchRoutes();
  beforeAll(async () => {
    db = await createTestDb();
    await seedUser(db.db, { id: 'owner' });
    await db.db.insert(workspaces).values({ id: 'ws', ownerId: 'owner', name: 'Mine' });
    await db.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'o/r', url: 'https://github.com/o/r' });
    await insertWorkbench({ id: 'wb', workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'o/r', baseBranch: 'main', branch: 'preview', name: 'preview', runtime: 'sandbox', status: 'ready', sandboxId: 'sb', agent: 'claude' });
  });
  beforeEach(() => {
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    vi.stubEnv('SESSION_PREVIEWS_ENABLED', 'true');
    resetFeatureFlagsForTests();
    vi.mocked(runCapture).mockReset();
  });
  afterAll(async () => {
    setWorkbenchFleetClientForTests(null);
    await db.cleanup();
    vi.unstubAllEnvs();
    resetFeatureFlagsForTests();
  });
  const call = (path: string, user = 'owner', port = '3000') => invokeRoute<{ data: { base: string; patch: string } }>(router, 'GET', path, {
    params: { id: 'wb', port }, user: { id: user, email: `${user}@test.invalid`, isAdmin: false },
  });

  it.each(['/:id/patch', '/:id/ports/:port/*'])('requires access and both flags for %s', async (path) => {
    expect((await call(path, 'other')).status).toBe(404);
    for (const flag of ['WORKBENCHES_ENABLED', 'SESSION_PREVIEWS_ENABLED']) {
      vi.stubEnv(flag, 'false');
      resetFeatureFlagsForTests();
      expect((await call(path)).status).toBe(403);
      vi.stubEnv(flag, 'true');
    }
    expect(runCapture).not.toHaveBeenCalled();
  });
  it('returns the patch and maps the size refusal to 413', async () => {
    vi.mocked(runCapture).mockResolvedValue(reply(`${sha}\npatch\n`));
    expect((await call('/:id/patch')).body.data).toEqual({ base: sha, patch: 'patch\n' });
    vi.mocked(runCapture).mockResolvedValue(reply('', 42));
    expect((await call('/:id/patch')).status).toBe(413);
  });
  it.each(['80', '1023', '65536', '1.5'])('refuses HTTP preview port %s', async (port) => {
    expect((await call('/:id/ports/:port/*', 'owner', port)).status).toBe(400);
  });
  it('captures all frames through one followed exec', async () => {
    const fleet = new FakeFleet();
    fleet.frameSize = 1;
    const output = `${sha}\n${'a'.repeat(10000)}\n`;
    fleet.handler = async () => ({ stdout: output });
    setWorkbenchFleetClientForTests(async () => fleet.asClient());
    const result = await originalRunCapture((await getWorkbench('wb'))!, 'printf patch', { follow: true, timeoutMs: 60000 });
    expect(result.stdout).toBe(output);
    expect(fleet.execs).toHaveLength(1);
    expect(fleet.execs[0].follow).toBe(true);
    setWorkbenchFleetClientForTests(null);
  });
});

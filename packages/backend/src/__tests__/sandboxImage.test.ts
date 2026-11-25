import * as runtime from '../services/workbenches/sandboxRuntime.js';
import * as teamsAccess from '../services/teams/access.js';
import * as featureFlags from '../services/featureFlags.js';
import * as workbenchAccess from '../services/workbenches/access.js';
import { invokeRoute } from './helpers/invokeRoute.js';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { FakeFleet } from './helpers/fakeFleet.js';
import { repositories, spaces, teams, workspaces } from '../db/schema.js';
import { insertWorkbench, type WorkbenchRow } from '../services/workbenches/store.js';
import { workbenchRoutes } from '../routes/workbenches.js';
import { resetFeatureFlagsForTests } from '../services/featureFlags.js';
import { resetSandboxStatusCacheForTests } from '../services/workbenches/sandboxStatus.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertImagePath,
  detectImageType,
  MAX_IMAGE_BYTES,
  readSandboxImage,
} from '../services/workbenches/sandboxImage.js';
import { WorkbenchError } from '../services/workbenches/errors.js';
import { runCapture, setWorkbenchFleetClientForTests } from '../services/workbenches/sandboxRuntime.js';

vi.spyOn(runtime, 'runCapture');
afterAll(() => vi.restoreAllMocks());

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const GIF87 = Buffer.from('GIF87a\x01\x00', 'latin1');
const GIF89 = Buffer.from('GIF89a\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

const reply = (bytes: Buffer | string, exitCode = 0, extra: { truncated?: boolean; stderr?: string } = {}) => {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
  return { stdout: buf.toString('utf8'), stdoutBytes: buf, exitCode, stderr: extra.stderr ?? '', ...(extra.truncated ? { truncated: true } : {}) };
};

const row = { id: 'wb', repoFullName: 'o/r', kind: 'session' } as unknown as WorkbenchRow;

async function refusal(promise: Promise<unknown>): Promise<WorkbenchError> {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(WorkbenchError);
  return err as WorkbenchError;
}

describe('detectImageType', () => {
  it.each([
    ['PNG', PNG, 'image/png'],
    ['JPEG', JPEG, 'image/jpeg'],
    ['GIF87a', GIF87, 'image/gif'],
    ['GIF89a', GIF89, 'image/gif'],
    ['WebP', WEBP, 'image/webp'],
  ])('detects %s', (_name, bytes, type) => {
    expect(detectImageType(bytes)).toBe(type);
  });

  it.each([
    ['empty', Buffer.alloc(0)],
    ['text', Buffer.from('GITHUB_TOKEN=ghp_secret\n')],
    ['a cut PNG header', PNG.subarray(0, 7)],
    ['two JPEG bytes', JPEG.subarray(0, 2)],
    ['GIF without a version', Buffer.from('GIF8')],
    ['RIFF that is not WebP', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')])],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['PDF', Buffer.from('%PDF-1.7\n')],
  ])('refuses %s', (_name, bytes) => {
    expect(detectImageType(bytes)).toBeNull();
  });
});

describe('assertImagePath', () => {
  it.each([
    ['/tmp/shot.png', '/tmp/shot.png'],
    ['  docs/shot.png  ', 'docs/shot.png'],
    ['../outside.png', '../outside.png'],
    ["it's here.png", "it's here.png"],
  ])('accepts %j', (path, expected) => {
    expect(assertImagePath(path)).toBe(expected);
  });

  it.each(['', '   ', 'a\0b.png', 'a\nb.png', 'a\rb.png'])('refuses %j with 400', (path) => {
    expect(() => assertImagePath(path)).toThrow(WorkbenchError);
    try {
      assertImagePath(path);
    } catch (err) {
      expect((err as WorkbenchError).status).toBe(400);
    }
  });
});

describe('readSandboxImage', () => {
  beforeEach(() => vi.mocked(runCapture).mockReset());

  it.each([
    ['PNG', PNG, 'image/png'],
    ['JPEG', JPEG, 'image/jpeg'],
    ['GIF', GIF89, 'image/gif'],
    ['WebP', WEBP, 'image/webp'],
  ])('returns a %s as base64', async (_name, bytes, mediaType) => {
    vi.mocked(runCapture).mockResolvedValue(reply(bytes));
    expect(await readSandboxImage(row, '/tmp/shot')).toEqual({
      path: '/tmp/shot',
      mediaType,
      bytes: bytes.length,
      data: bytes.toString('base64'),
    });
  });

  it.each([
    ['an absolute path', '/tmp/shot.png', '/tmp/shot.png'],
    ['a relative path', 'docs/shot.png', 'docs/shot.png'],
    ['a path with spaces', '/tmp/my shot.png', "'/tmp/my shot.png'"],
    ['a path with a quote', "/tmp/it's.png", "'/tmp/it'\\''s.png'"],
    ['a path with shell syntax', '/tmp/$(rm -rf ~).png', "'/tmp/$(rm -rf ~).png'"],
    ['a path that starts with a dash', '-shot.png', '-shot.png'],
  ])('quotes %s in the script', async (_name, path, quoted) => {
    vi.mocked(runCapture).mockResolvedValue(reply(PNG));
    await readSandboxImage(row, path);
    const [, script, opts] = vi.mocked(runCapture).mock.calls[0];
    expect(script).toContain(`[ -f ${quoted} ] || exit 3`);
    expect(script).toContain(`wc -c < ${quoted}`);
    expect(script).toContain(`[ "$n" -le ${MAX_IMAGE_BYTES} ]`);
    expect(script).toContain(`cat -- ${quoted}`);
    // The exec runs in the repository (its default cwd), so a relative path starts there.
    expect(opts).not.toHaveProperty('cwd');
    expect(opts).toMatchObject({ quiet: true });
  });

  it('checks the size before it reads the file', async () => {
    vi.mocked(runCapture).mockResolvedValue(reply(PNG));
    await readSandboxImage(row, '/tmp/shot.png');
    const script = vi.mocked(runCapture).mock.calls[0][1];
    expect(script.indexOf('exit 4')).toBeLessThan(script.indexOf('cat --'));
  });

  it('refuses a missing file with 404', async () => {
    vi.mocked(runCapture).mockResolvedValue(reply('', 3));
    const err = await refusal(readSandboxImage(row, '/tmp/none.png'));
    expect(err.status).toBe(404);
    expect(err.message).toBe('/tmp/none.png does not exist.');
  });

  it.each([
    ['with the size', String(6 * 1024 * 1024), ' (6.0 MB)'],
    ['without a size it can read', '', ''],
  ])('refuses a file over the limit with 413, %s', async (_name, stdout, size) => {
    vi.mocked(runCapture).mockResolvedValue(reply(stdout, 4));
    const err = await refusal(readSandboxImage(row, '/tmp/big.png'));
    expect(err.status).toBe(413);
    expect(err.message).toBe(`/tmp/big.png is too large to show${size}. The limit is 2.5 MB. Take a smaller screenshot or save it as JPEG.`);
  });

  it('refuses an answer the fleet cut with 413', async () => {
    vi.mocked(runCapture).mockResolvedValue(reply(PNG, 0, { truncated: true }));
    expect((await refusal(readSandboxImage(row, '/tmp/big.png'))).status).toBe(413);
  });

  it.each([
    ['a text file', Buffer.from('SECRET=abc\n')],
    ['an empty file', Buffer.alloc(0)],
    ['an SVG', Buffer.from('<svg/>')],
  ])('refuses %s with 415 and returns none of it', async (_name, bytes) => {
    vi.mocked(runCapture).mockResolvedValue(reply(bytes));
    const err = await refusal(readSandboxImage(row, '/home/u/.env'));
    expect(err.status).toBe(415);
    expect(err.message).toBe('/home/u/.env is not a PNG, JPEG, GIF or WebP image.');
    expect(err.message).not.toContain('SECRET');
  });

  it('fails with the exit code and stderr for another failure', async () => {
    vi.mocked(runCapture).mockResolvedValue(reply('', 5, { stderr: 'Permission denied' }));
    await expect(readSandboxImage(row, '/root/x.png')).rejects.toThrow('reading /root/x.png failed (exit 5): Permission denied');
  });

  it('refuses a bad path without an exec', async () => {
    expect((await refusal(readSandboxImage(row, 'a\nb.png'))).status).toBe(400);
    expect(runCapture).not.toHaveBeenCalled();
  });
});

describe('GET /workbenches/:id/image', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  const router = workbenchRoutes();
  const fleet = new FakeFleet();

  beforeAll(async () => {
    db = await createTestDb();
    await seedUser(db.db, { id: 'owner' });
    await db.db.insert(workspaces).values({ id: 'ws', ownerId: 'owner', name: 'Mine' });
    await db.db.insert(repositories).values({ id: 'repo', workspaceId: 'ws', name: 'o/r', url: 'https://github.com/o/r' });
    await insertWorkbench({ id: 'wb', workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'o/r', baseBranch: 'main', branch: 'shots', name: 'shots', runtime: 'sandbox', status: 'ready', sandboxId: 'sb', sandboxState: 'running', agent: 'claude' });
    await insertWorkbench({ id: 'starting', workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'o/r', baseBranch: 'main', branch: 'starting', name: 'starting', runtime: 'sandbox', status: 'provisioning', sandboxId: null, agent: 'claude' });
  });
  beforeEach(() => {
    vi.stubEnv('WORKBENCHES_ENABLED', 'true');
    resetFeatureFlagsForTests();
    resetSandboxStatusCacheForTests();
    fleet.sandboxStatus = 'idle';
    setWorkbenchFleetClientForTests(async () => fleet.asClient());
    vi.mocked(runCapture).mockReset();
  });
  afterAll(async () => {
    setWorkbenchFleetClientForTests(null);
    await db.cleanup();
    vi.unstubAllEnvs();
    resetFeatureFlagsForTests();
  });

  type Body = { success: boolean; data?: unknown; error?: string; code?: string };
  const call = (query: Record<string, string>, opts: { id?: string; user?: string } = {}) => {
    const user = opts.user ?? 'owner';
    return invokeRoute<Body>(router, 'GET', '/:id/image', {
      params: { id: opts.id ?? 'wb' },
      query,
      headers: {},
      user: { id: user, email: `${user}@test.invalid`, isAdmin: false },
    });
  };

  it('returns the image for a live read', async () => {
    vi.mocked(runCapture).mockResolvedValue(reply(PNG));
    const res = await call({ path: '/tmp/shot.png', live: '1' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ path: '/tmp/shot.png', mediaType: 'image/png', bytes: PNG.length, data: PNG.toString('base64') });
  });

  it('reads a running box without live', async () => {
    vi.mocked(runCapture).mockResolvedValue(reply(JPEG));
    const res = await call({ path: 'shot.jpg' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ mediaType: 'image/jpeg' });
  });

  it('refuses a sleeping box without live, and does not wake it', async () => {
    fleet.sandboxStatus = 'suspended';
    const res = await call({ path: '/tmp/shot.png' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('snapshot_unavailable');
    expect(runCapture).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', reply('', 3), 404, 'file_not_found'],
    ['too large', reply('5000000', 4), 413, 'image_too_large'],
    ['not an image', reply('hello'), 415, 'not_an_image'],
  ])('maps a %s file to %i', async (_name, answer, status, code) => {
    vi.mocked(runCapture).mockResolvedValue(answer);
    const res = await call({ path: '/tmp/x', live: '1' });
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });

  it('needs a path', async () => {
    expect((await call({ live: '1' })).status).toBe(400);
    expect(runCapture).not.toHaveBeenCalled();
  });

  it('refuses a session with no sandbox yet', async () => {
    const res = await call({ path: '/tmp/shot.png', live: '1' }, { id: 'starting' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not_ready');
    expect(runCapture).not.toHaveBeenCalled();
  });

  it('hides the session from a space member, who could otherwise read images outside the repository', async () => {
    await db.db.insert(teams).values({ id: 'team', name: 'Team' });
    await db.db.insert(spaces).values({ id: 'space', teamId: 'team', name: 'Space' });
    await insertWorkbench({ id: 'shared', workspaceId: 'ws', repositoryId: 'repo', repoFullName: 'o/r', baseBranch: 'main', branch: 'shared', name: 'shared', runtime: 'sandbox', status: 'ready', sandboxId: 'sb2', sandboxState: 'running', agent: 'claude', spaceId: 'space' } as Parameters<typeof insertWorkbench>[0]);
    const spies = [
      vi.spyOn(teamsAccess, 'canViewItem').mockResolvedValue(true),
      vi.spyOn(featureFlags, 'isFeatureEnabled').mockResolvedValue(true),
      vi.spyOn(workbenchAccess, 'userMayUseWorkbenches').mockResolvedValue(true),
    ];
    try {
      vi.mocked(runCapture).mockResolvedValue(reply(PNG));
      for (const query of [{ path: '/tmp/shot.png' }, { path: '/tmp/shot.png', live: '1' }]) {
        expect((await call(query, { id: 'shared', user: 'teammate' })).status).toBe(404);
      }
      expect(teamsAccess.canViewItem).toHaveBeenCalled();
      expect(runCapture).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("hides another person's session", async () => {
    expect((await call({ path: '/tmp/shot.png', live: '1' }, { user: 'other' })).status).toBe(404);
    expect(runCapture).not.toHaveBeenCalled();
  });
});

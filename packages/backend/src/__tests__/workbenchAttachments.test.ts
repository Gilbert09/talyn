import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Request, type Response } from 'express';
import { Readable } from 'stream';

const getWorkbench = vi.fn();
const writeSandboxFiles = vi.fn(async () => {});
const runCapture = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
let flag = true;

vi.mock('../services/workbenches/store.js', () => ({
  getWorkbench, isThread: (row: { kind?: string }) => row.kind === 'thread',
}));
vi.mock('../services/workbenches/sandboxFiles.js', () => ({ writeSandboxFiles }));
vi.mock('../services/workbenches/sandboxRuntime.js', () => ({
  SANDBOX_WORK_ROOT: '/work', repoDirFor: () => '/work/acme/app', runCapture, recordWorkbenchEvent: vi.fn(),
}));
vi.mock('../services/workbenches/access.js', () => ({
  userMayUseWorkbenches: async () => flag, workbenchesRefusalReason: () => 'disabled',
}));
vi.mock('../middleware/auth.js', () => ({
  assertUser: (req: { user: unknown }) => req.user,
  requireWorkspaceAccess: async (req: { user: { id: string } }) => {
    if (req.user.id !== 'owner-a') throw new Error('denied');
  },
  handleAccessError: (_err: unknown, res: express.Response) => res.status(404).json({ success: false, error: 'Not found' }),
}));

const { workbenchAttachmentRoutes } = await import('../routes/workbenchAttachments.js');
const { wrapAsyncRoutes } = await import('../middleware/asyncHandler.js');

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
const mov = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(16)]);
const oldMov = Buffer.concat([Buffer.from([0, 0, 0, 0x08]), Buffer.from('wide'), Buffer.alloc(16)]);
const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(16)]);
const ready = { id: 'wb-1', workspaceId: 'ws-a', runtime: 'sandbox', status: 'ready', sandboxId: 'box-1', archivedAt: null };

describe('workbench attachment uploads', () => {
  const router = wrapAsyncRoutes(workbenchAttachmentRoutes());

  async function raw(path: string, user = 'owner-a') {
    return new Promise<{ status: number; body: Buffer | { code?: string }; headers: Record<string, string> }>((resolve, reject) => {
      const headers: Record<string, string> = {};
      const req = Object.assign(Readable.from([]), {
        method: 'GET', url: '/wb-1/attachments/raw', originalUrl: '/wb-1/attachments/raw',
        query: { path }, headers: {}, user: { id: user, email: 'user@example.test', isAdmin: false },
      }) as unknown as Request;
      const res = {
        statusCode: 200,
        status(status: number) { this.statusCode = status; return this; },
        set(name: string, value: string) { headers[name.toLowerCase()] = value; return this; },
        json(body: unknown) { resolve({ status: this.statusCode, body: body as { code?: string }, headers }); return this; },
        send(body: Buffer) { resolve({ status: this.statusCode, body, headers }); return this; },
      } as Response;
      router(req, res, (routeError?: unknown) => reject(routeError ?? new Error('No route matched')));
    });
  }

  async function upload(body: Buffer, type = 'image/png', user = 'owner-a', fileName = 'my shot.png') {
    return new Promise<{ status: number; body: { success: boolean; data?: { path: string; mimeType: string; name: string }; code?: string } }>((resolve, reject) => {
      const headers = { 'content-type': type, 'content-length': String(body.length), 'x-attachment-name': encodeURIComponent(fileName) };
      const req = Object.assign(Readable.from([body]), {
        method: 'POST', url: '/wb-1/attachments', originalUrl: '/wb-1/attachments', headers,
        user: { id: user, email: 'user@example.test', isAdmin: false },
        get: (name: string) => headers[name.toLowerCase() as keyof typeof headers],
      }) as unknown as Request;
      const res = {
        statusCode: 200,
        status(status: number) { this.statusCode = status; return this; },
        json(data: unknown) { resolve({ status: this.statusCode, body: data as { success: boolean; data?: { path: string; mimeType: string; name: string }; code?: string } }); return this; },
      } as Response;
      express.json({ limit: '2mb' })(req, res, (err?: unknown) => {
        if (err) return reject(err);
        router(req, res, (routeError?: unknown) => reject(routeError ?? new Error('No route matched')));
      });
    });
  }

  beforeEach(() => {
    flag = true;
    getWorkbench.mockReset().mockResolvedValue(ready);
    writeSandboxFiles.mockClear();
    runCapture.mockClear();
  });

  it('stores an image and returns only its repo path', async () => {
    const response = await upload(png);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      name: 'my shot.png', mimeType: 'image/png', path: expect.stringMatching(/^\.context\/attachments\/[\w-]+-my-shot.png$/),
    });
    expect(writeSandboxFiles).toHaveBeenCalledWith(ready, [
      { path: `/work/acme/app/${response.body.data?.path}`, base64: png.toString('base64') },
    ], { timeoutMs: 120_000 });
    expect(runCapture.mock.calls[0][1]).toContain('git rev-parse --git-path info/exclude');
    expect(runCapture.mock.calls[0][1]).toContain('grep -qxF');
    expect(runCapture.mock.invocationCallOrder[0]).toBeLessThan(writeSandboxFiles.mock.invocationCallOrder[0]);
  });

  it('stores an image in a thread without touching git', async () => {
    const thread = { ...ready, kind: 'thread' };
    getWorkbench.mockResolvedValue(thread);
    const response = await upload(png);
    expect(response.status).toBe(200);
    expect(runCapture).not.toHaveBeenCalled();
    expect(writeSandboxFiles).toHaveBeenCalledWith(thread, [
      { path: `/work/acme/app/${response.body.data?.path}`, base64: png.toString('base64') },
    ], { timeoutMs: 120_000 });
  });

  it('accepts 5 MB of image data past the global JSON limit', async () => {
    const large = Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]);
    expect((await upload(large)).status).toBe(200);
    expect(writeSandboxFiles.mock.calls[0][1][0].base64).toHaveLength(large.toString('base64').length);
  });

  it.each([
    ['an MP4', mp4, 'video/mp4', 'screen recording.mp4', /-screen-recording\.mp4$/],
    ['a QuickTime movie', mov, 'video/quicktime', 'IMG_0001.MOV', /-IMG_0001\.MOV$/],
    ['an old QuickTime movie', oldMov, 'video/quicktime', 'clip.mov', /-clip\.mov$/],
    ['a WebM video', webm, 'video/webm', 'capture.webm', /-capture\.webm$/],
    ['an M4V file as MP4', mp4, 'video/mp4', 'clip.m4v', /-clip\.m4v$/],
    ['a video with no extension', mp4, 'video/mp4', 'recording', /-recording\.mp4$/],
    ['a video with the wrong extension', webm, 'video/webm', 'recording.mp4', /-recording\.webm$/],
    ['an image with no extension', png, 'image/png', 'pasted', /-pasted\.png$/],
  ])('stores %s with a readable extension', async (_label, body, type, name, path) => {
    const response = await upload(body, type, 'owner-a', name);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ name, mimeType: type, path: expect.stringMatching(path) });
    expect(writeSandboxFiles.mock.calls[0][1][0].base64).toBe(body.toString('base64'));
  });

  it('accepts a video larger than the image limit', async () => {
    const large = Buffer.concat([mp4, Buffer.alloc(20 * 1024 * 1024)]);
    expect((await upload(large, 'video/mp4', 'owner-a', 'long.mp4')).status).toBe(200);
  });

  it('refuses an image larger than 10 MB', async () => {
    const large = Buffer.concat([png, Buffer.alloc(10 * 1024 * 1024)]);
    const response = await upload(large);
    expect(response.status).toBe(413);
    expect(writeSandboxFiles).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong bytes', Buffer.from('not png'), 'image/png', 415],
    ['wrong video bytes', png, 'video/mp4', 415],
    ['WebM bytes as QuickTime', webm, 'video/quicktime', 415],
    ['an unsupported video type', mp4, 'video/x-msvideo', 415],
    ['wrong type', png, 'text/plain', 415],
    ['empty body', Buffer.alloc(0), 'image/png', 400],
    ['empty video', Buffer.alloc(0), 'video/mp4', 400],
  ])('rejects %s', async (_label, body, type, status) => {
    expect((await upload(body, type)).status).toBe(status);
    expect(writeSandboxFiles).not.toHaveBeenCalled();
  });

  it('refuses a sandbox that is not ready', async () => {
    getWorkbench.mockResolvedValue({ ...ready, status: 'provisioning' });
    expect((await upload(png)).body.code).toBe('not_ready');
  });

  it('refuses local sessions', async () => {
    getWorkbench.mockResolvedValue({ ...ready, runtime: 'local' });
    expect((await upload(png)).status).toBe(400);
  });

  it('hides another workspace', async () => {
    expect((await upload(png, 'image/png', 'owner-b')).status).toBe(404);
  });

  it('enforces the feature flag', async () => {
    flag = false;
    expect((await upload(png)).status).toBe(403);
  });

  it('serves a sandbox PNG with private cache headers', async () => {
    runCapture.mockResolvedValueOnce({ exitCode: 0, stdout: String(png.length), stderr: '' });
    runCapture.mockResolvedValueOnce({ exitCode: 0, stdout: png.toString('base64'), stderr: '' });
    const response = await raw('.context/attachments/shot.png');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(png);
    expect(response.headers).toMatchObject({
      'content-type': 'image/png', 'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
    });
    expect(runCapture.mock.calls[1][1]).toContain('base64');
  });

  it.each(['../secret.png', '.context/attachments/../secret.png', '.context/attachments/a/b.png'])('rejects unsafe path %s', async (path) => {
    expect((await raw(path)).status).toBe(400);
    expect(runCapture).not.toHaveBeenCalled();
  });

  it('refuses local and unready sessions', async () => {
    getWorkbench.mockResolvedValueOnce({ ...ready, runtime: 'local' });
    expect((await raw('.context/attachments/a.png')).status).toBe(400);
    getWorkbench.mockResolvedValueOnce({ ...ready, status: 'provisioning' });
    expect((await raw('.context/attachments/a.png')).status).toBe(409);
  });

  it('hides another workspace from attachment reads', async () => {
    expect((await raw('.context/attachments/a.png', 'owner-b')).status).toBe(404);
  });

  it('refuses an attachment over 10 MB before reading bytes', async () => {
    runCapture.mockResolvedValueOnce({ exitCode: 0, stdout: String(10 * 1024 * 1024 + 1), stderr: '' });
    expect((await raw('.context/attachments/large.png')).status).toBe(413);
    expect(runCapture).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['clip.mp4', 'video/mp4'],
    ['clip.m4v', 'video/mp4'],
    ['clip.MOV', 'video/quicktime'],
    ['clip.webm', 'video/webm'],
  ])('serves the video %s with its type', async (name, type) => {
    runCapture.mockResolvedValueOnce({ exitCode: 0, stdout: String(mp4.length), stderr: '' });
    runCapture.mockResolvedValueOnce({ exitCode: 0, stdout: mp4.toString('base64'), stderr: '' });
    const response = await raw(`.context/attachments/${name}`);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe(type);
  });

  it('allows a video over 10 MB but refuses one over 50 MB', async () => {
    runCapture.mockResolvedValueOnce({ exitCode: 0, stdout: String(50 * 1024 * 1024 + 1), stderr: '' });
    expect((await raw('.context/attachments/large.mp4')).status).toBe(413);
    expect(runCapture).toHaveBeenCalledTimes(1);
  });

  it('refuses an unknown extension', async () => {
    expect((await raw('.context/attachments/notes.txt')).status).toBe(400);
    expect(runCapture).not.toHaveBeenCalled();
  });

  it('reads images over 2 MB in bounded chunks', async () => {
    const large = Buffer.alloc(2 * 1024 * 1024 + 1, 42);
    runCapture.mockResolvedValueOnce({ exitCode: 0, stdout: String(large.length), stderr: '' });
    runCapture.mockResolvedValueOnce({ exitCode: 0, stdout: large.subarray(0, 2 * 1024 * 1024).toString('base64'), stderr: '' });
    runCapture.mockResolvedValueOnce({ exitCode: 0, stdout: large.subarray(2 * 1024 * 1024).toString('base64'), stderr: '' });
    const response = await raw('.context/attachments/large.png');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(large);
    expect(runCapture).toHaveBeenCalledTimes(3);
  });
});

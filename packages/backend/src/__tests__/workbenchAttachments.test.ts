import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Request, type Response } from 'express';
import { Readable } from 'stream';

const getWorkbench = vi.fn();
const writeSandboxFiles = vi.fn(async () => {});
const runCapture = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
let flag = true;

vi.mock('../services/workbenches/store.js', () => ({ getWorkbench }));
vi.mock('../services/workbenches/sandboxFiles.js', () => ({ writeSandboxFiles }));
vi.mock('../services/workbenches/sandboxRuntime.js', () => ({
  repoDirFor: () => '/work/acme/app', runCapture, recordWorkbenchEvent: vi.fn(),
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
const ready = { id: 'wb-1', workspaceId: 'ws-a', runtime: 'sandbox', status: 'ready', sandboxId: 'box-1', archivedAt: null };

describe('workbench image uploads', () => {
  const router = wrapAsyncRoutes(workbenchAttachmentRoutes());

  async function upload(body: Buffer, type = 'image/png', user = 'owner-a') {
    return new Promise<{ status: number; body: { success: boolean; data?: { path: string; mimeType: string; name: string }; code?: string } }>((resolve, reject) => {
      const headers = { 'content-type': type, 'content-length': String(body.length), 'x-attachment-name': 'my shot.png' };
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

  it('accepts 5 MB of image data past the global JSON limit', async () => {
    const large = Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]);
    expect((await upload(large)).status).toBe(200);
    expect(writeSandboxFiles.mock.calls[0][1][0].base64).toHaveLength(large.toString('base64').length);
  });

  it.each([
    ['wrong bytes', Buffer.from('not png'), 'image/png', 415],
    ['wrong type', png, 'text/plain', 415],
    ['empty body', Buffer.alloc(0), 'image/png', 400],
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
});

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { asyncHandler, wrapAsyncRoutes } from '../middleware/asyncHandler.js';

describe('asyncHandler / wrapAsyncRoutes', () => {
  let server: Server;
  let baseUrl: string;
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  beforeAll(async () => {
    const app = express();

    const router = Router();
    router.get('/ok', async (_req, res) => {
      res.json({ success: true });
    });
    router.get('/rejects', async () => {
      throw new Error('async boom');
    });
    router.get('/throws-sync', () => {
      throw new Error('sync boom');
    });
    // Async router.use middleware that rejects — must also be covered.
    const mwRouter = Router();
    mwRouter.use(async () => {
      throw new Error('middleware boom');
    });
    mwRouter.get('/never', (_req, res) => res.json({ success: true }));

    app.use('/r', wrapAsyncRoutes(router));
    app.use('/mw', wrapAsyncRoutes(mwRouter));
    app.get(
      '/standalone',
      asyncHandler(async () => {
        throw new Error('standalone boom');
      })
    );

    // Mirror the arity-4 error middleware from routes/index.ts.
    app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) {
        next(err);
        return;
      }
      res.status(500).json({ success: false, error: err.message });
    });

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    errorSpy.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('passes through successful async handlers untouched', async () => {
    const res = await fetch(`${baseUrl}/r/ok`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it('turns an async rejection into a 500 JSON error (not a hung request)', async () => {
    const res = await fetch(`${baseUrl}/r/rejects`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: 'async boom' });
  });

  it('still routes synchronous throws to the error middleware', async () => {
    const res = await fetch(`${baseUrl}/r/throws-sync`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: 'sync boom' });
  });

  it('covers async router.use middleware', async () => {
    const res = await fetch(`${baseUrl}/mw/never`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: 'middleware boom' });
  });

  it('asyncHandler wraps a standalone handler', async () => {
    const res = await fetch(`${baseUrl}/standalone`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: 'standalone boom' });
  });

  it('does not wrap nested routers or arity-4 handlers', () => {
    const parent = Router();
    const child = Router();
    child.get('/x', (_req, res) => res.end());
    parent.use('/child', child);
    const errHandler = (_e: Error, _req: Request, _res: Response, _n: NextFunction) => undefined;
    parent.use(errHandler as unknown as express.RequestHandler);

    const stack = (parent as unknown as { stack: Array<{ handle: unknown }> }).stack;
    const before = stack.map((l) => l.handle);
    wrapAsyncRoutes(parent);
    // Nested router + error handler layers must be identical references.
    expect(stack[0].handle).toBe(before[0]);
    expect(stack[1].handle).toBe(before[1]);
  });
});

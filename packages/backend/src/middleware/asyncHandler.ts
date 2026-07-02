import type { NextFunction, Request, RequestHandler, Response, Router } from 'express';

/**
 * Express 4 does NOT catch promise rejections from async handlers — a
 * rejected handler leaves the request hanging and surfaces as an
 * `unhandledRejection` (pre-Node-15 that was silent; now it kills the
 * process). These helpers route rejections into `next(err)` so the
 * arity-4 error middleware in routes/index.ts turns them into 500s.
 */

type AnyHandler = (req: Request, res: Response, next: NextFunction) => unknown;

/** Wrap a single (possibly async) handler so rejections become `next(err)`. */
export function asyncHandler(fn: AnyHandler): RequestHandler {
  return (req, res, next) => {
    try {
      const out = fn(req, res, next);
      if (out instanceof Promise || (out && typeof (out as Promise<unknown>).catch === 'function')) {
        void (out as Promise<unknown>).catch(next);
      }
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Internal express layer shapes — not in @types/express, but stable across
 * express 4.x (`Router#stack` → `Layer`, `Layer#route` → `Route#stack`).
 */
interface RouteLayer {
  handle: AnyHandler & { stack?: unknown };
}
interface RouterLayer {
  route?: { stack: RouteLayer[] };
  handle: AnyHandler & { stack?: unknown };
}

/**
 * Wrap every handler already registered on a router with {@link asyncHandler}.
 * Applied once at mount time (routes/index.ts) so the route files stay
 * untouched — the least invasive way to cover every async handler at once.
 *
 * Skips arity-4 (error) handlers and nested routers (whose `handle` carries
 * its own `stack`); wraps both route handlers and plain `router.use`
 * middleware.
 */
export function wrapAsyncRoutes<T extends Router>(router: T): T {
  const layers = (router as unknown as { stack: RouterLayer[] }).stack ?? [];
  for (const layer of layers) {
    if (layer.route) {
      for (const routeLayer of layer.route.stack) wrapLayer(routeLayer);
    } else {
      wrapLayer(layer);
    }
  }
  return router;
}

function wrapLayer(layer: RouteLayer): void {
  const original = layer.handle;
  if (typeof original !== 'function') return;
  // Nested routers are functions with their own `stack` — don't touch them.
  if (original.stack !== undefined) return;
  // Arity-4 handlers are error middleware; wrapping would change their arity
  // and Express would stop treating them as error handlers.
  if (original.length >= 4) return;
  layer.handle = asyncHandler(original);
}

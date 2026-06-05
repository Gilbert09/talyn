import type { Request, Response, NextFunction } from 'express';
import { withOwnerScope } from '../db/scope.js';

/**
 * Runs the rest of the request stack inside an owner-scoped DB transaction
 * (see `db/scope.ts`), so every query — including those inside shared services
 * reached via `getDbClient()` — is RLS-filtered to the authenticated owner.
 *
 * Mounted after `requireAuth` and after the (cross-tenant, operator-only) debug
 * routes, so it covers the owner/workspace data routers but not the debug
 * surface. Background loops never pass through here, so they keep the pool.
 *
 * Against test pglite (no `authenticated` role) `withOwnerScope` is a
 * passthrough, so this just forwards to `next()` with no transaction held.
 */
export function ownerScope(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (!user) {
    next();
    return;
  }
  // Hold the scope open until the response is fully sent, so the transaction
  // spans the whole handler. `next()` runs synchronously inside the scope, so
  // the handler's async continuations inherit it via AsyncLocalStorage.
  withOwnerScope(
    user.id,
    () =>
      new Promise<void>((resolve) => {
        res.once('finish', resolve);
        res.once('close', resolve);
        next();
      })
  ).catch((err) => {
    if (!res.headersSent) next(err);
  });
}

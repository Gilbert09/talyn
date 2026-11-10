import type { Request, Response, NextFunction } from 'express';
import { runWithoutScope } from '../db/client.js';
import { withOwnerScope } from '../db/scope.js';

const scopeEnders = new WeakMap<Request, () => Promise<void>>();

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
  let release = (): void => undefined;
  let ended = false;
  let done: Promise<void> = Promise.resolve();
  // Registered first: without RLS the scope runs `next()` synchronously.
  scopeEnders.set(req, async () => {
    ended = true;
    release();
    await done;
  });
  done = withOwnerScope(
    user.id,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
        res.once('finish', resolve);
        res.once('close', resolve);
        next();
      }),
    `${req.method} ${req.originalUrl.split('?')[0]}`
  );
  done.catch((err) => {
    if (!ended && !res.headersSent) next(err);
  });
}

/**
 * Commit the request's owner-scoped transaction now, then run `fn` on the pool.
 *
 * For a handler that waits on GitHub after it has proved ownership. Without
 * this, the scope holds a pooled connection idle in transaction for the whole
 * wait. `fn` must only touch rows whose ownership the handler already proved,
 * because RLS does not filter it. `getDbClient()` inside `fn` is the pool. Do
 * not query after this returns: the scoped handle is closed.
 */
export async function continueWithoutOwnerScope<T>(
  req: Request,
  fn: () => Promise<T>
): Promise<T> {
  const end = scopeEnders.get(req);
  scopeEnders.delete(req);
  if (end) await end();
  return runWithoutScope(fn);
}

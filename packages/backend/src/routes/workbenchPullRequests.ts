import { Router, type Request, type Response } from 'express';
import type { ApiResponse } from '@talyn/shared';
import { assertUser, handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import { userMayUseWorkbenches, workbenchesRefusalReason } from '../services/workbenches/access.js';
import { fleetErrorAsRefusal, WorkbenchError } from '../services/workbenches/errors.js';
import {
  adoptPullRequestForWorkbench,
  linkWorkbenchPullRequest,
  openPullRequestsForWorkbench,
  unlinkWorkbenchPullRequest,
} from '../services/workbenches/pullRequest.js';
import { getWorkbench, type WorkbenchRow } from '../services/workbenches/store.js';

/**
 * Workbench pull-request routes that live outside `routes/workbenches.ts`.
 * Mounted on the same `/workbenches` prefix, BEFORE that router, and pre-
 * `ownerScope` for the same reason. The gate is the same as there: the
 * caller's access to the workbench's workspace, then the `workbenches` flag.
 */

const ok = <T>(res: Response, data: T) => res.json({ success: true, data } as ApiResponse<T>);
const bad = (res: Response, status: number, error: string, code?: string) =>
  res.status(status).json({ success: false, error, ...(code ? { code } : {}) });

async function gatedWorkbench(req: Request, res: Response, id: string): Promise<WorkbenchRow | null> {
  const row = await getWorkbench(id);
  if (!row) {
    bad(res, 404, 'Session not found');
    return null;
  }
  try {
    await requireWorkspaceAccess(req, row.workspaceId);
  } catch (err) {
    handleAccessError(err, res);
    return null;
  }
  const user = assertUser(req);
  if (!(await userMayUseWorkbenches({ distinctId: user.id, email: user.email }))) {
    bad(res, 403, `Sessions are not available: ${workbenchesRefusalReason()}.`, 'workbenches_unavailable');
    return null;
  }
  return row;
}

export function workbenchPullRequestRoutes(): Router {
  const router = Router();

  /**
   * Link the open PR the agent opened itself during a Create PR turn, found by
   * the HEAD commit (or branch) of the session. `pullRequest` is null when no
   * single open PR matched.
   */
  router.post('/:id/pull-request/adopt', async (req, res) => {
    const row = await gatedWorkbench(req, res, req.params.id);
    if (!row) return;
    try {
      ok(res, await adoptPullRequestForWorkbench(row, req.body ?? {}));
    } catch (err) {
      const refusal = fleetErrorAsRefusal(err);
      if (!refusal) throw err;
      if (!(err instanceof WorkbenchError)) console.warn('[workbench] fleet request failed:', err);
      bad(res, refusal.status, refusal.message, refusal.code);
    }
  });

  const handlers = [
    ['get', '/:id/pull-requests/open', (row: WorkbenchRow) => openPullRequestsForWorkbench(row)],
    ['post', '/:id/pull-request/link', (row: WorkbenchRow, req: Request) => linkWorkbenchPullRequest(row, req.body?.number)],
    ['post', '/:id/pull-request/unlink', (row: WorkbenchRow) => unlinkWorkbenchPullRequest(row)],
  ] as const;
  for (const [method, path, handler] of handlers) {
    router[method](path, async (req, res) => {
      const row = await gatedWorkbench(req, res, req.params.id);
      if (!row) return;
      try {
        ok(res, await handler(row, req));
      } catch (err) {
        const refusal = fleetErrorAsRefusal(err);
        if (!refusal) throw err;
        bad(res, refusal.status, refusal.message, refusal.code);
      }
    });
  }

  return router;
}

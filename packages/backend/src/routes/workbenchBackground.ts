import { Router, type Request, type Response } from 'express';
import type {
  ApiResponse,
  ScheduleWorkbenchWakeupInput,
  StartWorkbenchBackgroundJobInput,
  WorkbenchWakeupCreatedBy,
} from '@talyn/shared';
import { assertUser, handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import { isFeatureEnabled } from '../services/featureFlags.js';
import { userMayUseWorkbenches, workbenchesRefusalReason } from '../services/workbenches/access.js';
import {
  backgroundOf,
  cancelWakeup,
  keepJobAwake,
  readJobLogs,
  scheduleWakeup,
  startBackgroundJob,
  stopBackgroundJob,
} from '../services/workbenches/background.js';
import { fleetErrorAsRefusal, WorkbenchError } from '../services/workbenches/errors.js';
import { chooseReadSource } from '../services/workbenches/sandboxReadSource.js';
import { getWorkbench, type WorkbenchRow } from '../services/workbenches/store.js';

/**
 * Session background jobs and wake-ups, behind the `sessionBackground` flag.
 * The contract is `api.workbenches.background*` in `@talyn/client`.
 *
 * Owner only: every handler authorises the session's workspace, then the
 * `workbenches` flag, then this flag for the caller. With the flag off, every
 * route answers 404, as if it did not exist. Talyn's MCP tools reach these
 * routes as the owner. Space teammates get nothing here yet.
 *
 * Mounted pre-`ownerScope` with the other workbench routers: the tables are
 * backend-pool-only, and a stop or a log read waits on the fleet.
 */

const ok = <T>(res: Response, data: T) => res.json({ success: true, data } as ApiResponse<T>);
const bad = (res: Response, status: number, error: string, code?: string) =>
  res.status(status).json({ success: false, error, ...(code ? { code } : {}) });

function fail(res: Response, err: unknown): void {
  if (err instanceof WorkbenchError) {
    bad(res, err.status, err.message, err.code);
    return;
  }
  const refusal = fleetErrorAsRefusal(err);
  if (refusal) {
    bad(res, refusal.status, refusal.message, refusal.code);
    return;
  }
  throw err;
}

export function workbenchBackgroundRoutes(): Router {
  const router = Router();

  /** The session, once the caller may use this feature on it. Null means the request is answered. */
  async function gated(req: Request, res: Response): Promise<WorkbenchRow | null> {
    const row = await getWorkbench(req.params.id);
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
    const subject = { distinctId: user.id, email: user.email };
    if (!(await userMayUseWorkbenches(subject))) {
      bad(res, 403, `Sessions are not available: ${workbenchesRefusalReason()}.`, 'workbenches_unavailable');
      return null;
    }
    if (!(await isFeatureEnabled('sessionBackground', subject))) {
      bad(res, 404, 'Not found', 'not_found');
      return null;
    }
    return row;
  }

  router.get('/:id/background', async (req, res) => {
    const row = await gated(req, res);
    if (!row) return;
    ok(res, await backgroundOf(row.id));
  });

  router.post('/:id/background/jobs', async (req, res) => {
    const row = await gated(req, res);
    if (!row) return;
    try {
      ok(res, await startBackgroundJob(row, (req.body ?? {}) as StartWorkbenchBackgroundJobInput));
    } catch (err) {
      fail(res, err);
    }
  });

  router.get('/:id/background/jobs/:jobId/logs', async (req, res) => {
    const row = await gated(req, res);
    if (!row) return;
    const live = req.query.live === '1' || req.query.live === 'true';
    const rawTail = typeof req.query.tail === 'string' ? Number(req.query.tail) : undefined;
    try {
      const asleep = live ? false : !(await chooseReadSource(row)).live;
      ok(res, await readJobLogs(row, req.params.jobId, { tail: rawTail, live, asleep }));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:id/background/jobs/:jobId/stop', async (req, res) => {
    const row = await gated(req, res);
    if (!row) return;
    try {
      ok(res, await stopBackgroundJob(row, req.params.jobId));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:id/background/jobs/:jobId/keep-awake', async (req, res) => {
    const row = await gated(req, res);
    if (!row) return;
    try {
      ok(res, await keepJobAwake(row, req.params.jobId, (req.body as { seconds?: unknown } | undefined)?.seconds));
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/:id/wakeups', async (req, res) => {
    const row = await gated(req, res);
    if (!row) return;
    const body = (req.body ?? {}) as ScheduleWorkbenchWakeupInput & { createdBy?: unknown };
    // Talyn's MCP tool says `agent`. It only labels the row and picks the
    // payer of the chat's running turn; anything else is the person.
    const createdBy: WorkbenchWakeupCreatedBy = body.createdBy === 'agent' ? 'agent' : 'user';
    try {
      ok(res, await scheduleWakeup(row, body, createdBy));
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/:id/wakeups/:wakeupId', async (req, res) => {
    const row = await gated(req, res);
    if (!row) return;
    try {
      ok(res, await cancelWakeup(row, req.params.wakeupId));
    } catch (err) {
      fail(res, err);
    }
  });

  return router;
}

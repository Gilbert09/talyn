import { Router } from 'express';
import type { AdminPage, AdminSessionDetail, AdminSessionSummary, ApiResponse } from '@talyn/shared';
import { getAdminSession, listAdminSessions } from '../../services/admin/sessions.js';

/**
 * Sessions and threads across every account. Read-only on purpose: every
 * action on a session (archive, restore, move) already has a product path with
 * its own safety rules, and a second path from the console would be a second
 * copy of those rules.
 */
export function adminSessionRoutes(): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const page = await listAdminSessions({
      q: req.query.q,
      kind: req.query.kind,
      status: req.query.status,
      state: req.query.state,
      host: req.query.host,
      owner: req.query.owner,
      runtime: req.query.runtime,
      workspaceId: req.query.workspaceId,
      limit: req.query.limit,
      before: req.query.before,
    });
    res.json({ success: true, data: page } as ApiResponse<AdminPage<AdminSessionSummary>>);
  });

  router.get('/:id', async (req, res) => {
    const detail = await getAdminSession(req.params.id, { live: req.query.live !== '0' });
    if (!detail) {
      res.status(404).json({ success: false, error: 'Session not found', code: 'session_not_found' });
      return;
    }
    res.json({ success: true, data: detail } as ApiResponse<AdminSessionDetail>);
  });

  return router;
}

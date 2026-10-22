import { Router } from 'express';
import { prMonitorService, RepoNotReadableError } from '../services/prMonitor.js';
import { GitHubRateLimitError } from '../services/githubRateGate.js';
import { refreshWebhookIndex } from '../services/webhookIndex.js';
import {
  assertUser,
  handleAccessError,
  requireRepositoryAccess,
  requireWorkspaceAccess,
} from '../middleware/auth.js';

export function repositoryRoutes(): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const repos = await prMonitorService.getWatchedRepos(workspaceId);
    res.json({ success: true, data: repos });
  });

  router.post('/', async (req, res) => {
    const { workspaceId, owner, repo, url } = req.body;
    if (!workspaceId || !owner || !repo) {
      return res.status(400).json({
        success: false,
        error: 'workspaceId, owner, and repo are required',
      });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    try {
      const watched = await prMonitorService.addWatchedRepo(workspaceId, owner, repo, url);
      // Refresh the webhook fan-out index so deliveries for this repo match
      // immediately instead of waiting for the next periodic rebuild.
      void refreshWebhookIndex().catch(() => undefined);
      res.json({ success: true, data: watched });
    } catch (err: unknown) {
      if (err instanceof RepoNotReadableError) {
        return res.status(404).json({ success: false, code: 'repo_not_accessible', error: err.message });
      }
      if (err instanceof GitHubRateLimitError) {
        return res.status(503).json({
          success: false,
          code: 'rate_limited',
          error: 'GitHub is rate-limiting Talyn right now — try again in a moment.',
        });
      }
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).json({ success: false, error: msg });
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      await requireRepositoryAccess(req, req.params.id);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const { id } = req.params;
    try {
      await prMonitorService.removeWatchedRepo(id);
      void refreshWebhookIndex().catch(() => undefined);
      res.json({ success: true, data: null });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).json({ success: false, error: msg });
    }
  });

  // The desktop "Refresh" button. Refreshes only the caller's own connected
  // workspaces — never a fleet-wide poll across every tenant's repos.
  //
  // It answers once the new PRs are written; the rest of the refresh reaches the
  // client over the WebSocket. A refresh that reached GitHub for NONE of the
  // repos is an error, because the list the client re-reads next is unchanged
  // and a 200 there reads as "nothing new". A partial one reports its count.
  router.post('/poll', async (req, res) => {
    try {
      const outcome = await prMonitorService.forcePollForOwner(assertUser(req).id, { untilListReady: true });
      if (!outcome) {
        res.json({
          success: true,
          data: { message: 'A refresh is already running', skipped: true, repos: 0, failedRepos: 0, failure: null },
        });
        return;
      }
      if (outcome.repos > 0 && outcome.failedRepos === outcome.repos) {
        res.status(503).json({ success: false, error: outcome.failure ?? 'Could not reach GitHub' });
        return;
      }
      res.json({ success: true, data: { message: 'Poll triggered', skipped: false, ...outcome } });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).json({ success: false, error: msg });
    }
  });

  return router;
}

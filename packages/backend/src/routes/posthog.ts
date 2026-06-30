import { Router } from 'express';
import { assertUser, handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import {
  getPostHogCodeCredentials,
  storePostHogCodeCredentials,
  removePostHogCodeCredentials,
} from '../services/posthogCode/credentials.js';
import { PostHogCodeClient } from '../services/posthogCode/client.js';
import { ensureCloudEnvironment } from '../services/cloudProviders/environment.js';
import type { ApiResponse } from '@talyn/shared';

/**
 * Per-workspace PostHog Code (cloud tasks) credentials. The personal
 * API key is write-only over the API — `GET /status` never returns it,
 * only presence + the non-secret project id / host.
 */
export function posthogRoutes(): Router {
  const router = Router();

  router.get('/status', async (req, res) => {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const creds = await getPostHogCodeCredentials(workspaceId);
    res.json({
      success: true,
      data: {
        connected: Boolean(creds),
        projectId: creds?.projectId,
        host: creds?.host,
      },
    } as ApiResponse<{ connected: boolean; projectId?: string; host?: string }>);
  });

  router.put('/config', async (req, res) => {
    const { workspaceId, apiKey, projectId, host } = req.body as {
      workspaceId?: string;
      apiKey?: string;
      projectId?: string;
      host?: string;
    };
    if (!workspaceId || !apiKey || !projectId) {
      return res.status(400).json({
        success: false,
        error: 'workspaceId, apiKey and projectId are required',
      });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }

    // Validate before persisting so a bad key never gets stored.
    const resolvedHost = host?.replace(/\/+$/, '') || 'https://us.posthog.com';
    try {
      await new PostHogCodeClient(apiKey, projectId, resolvedHost).ping();
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: `Could not authenticate with PostHog: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }

    try {
      await storePostHogCodeCredentials(workspaceId, { apiKey, projectId, host: resolvedHost });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Most likely FASTOWL_TOKEN_KEY isn't set — surface it as a clean
      // 500 instead of letting the throw take down the dev process.
      console.error('[posthog] failed to store credentials:', msg);
      return res.status(500).json({
        success: false,
        error: `Could not store credentials: ${msg}`,
      });
    }

    // Connecting the integration auto-provisions the cloud environment
    // (users don't add it manually). One per user is enough — it's a
    // secret-free marker; the per-workspace credentials above are what
    // actually authorise a run.
    await ensureCloudEnvironment(assertUser(req).id, 'posthog_code');

    res.json({
      success: true,
      data: { connected: true, projectId, host: resolvedHost },
    });
  });

  router.post('/test', async (req, res) => {
    const { workspaceId } = req.body as { workspaceId?: string };
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const creds = await getPostHogCodeCredentials(workspaceId);
    if (!creds) {
      return res.json({ success: true, data: { connected: false, error: 'Not configured' } });
    }
    try {
      await new PostHogCodeClient(creds.apiKey, creds.projectId, creds.host).ping();
      res.json({ success: true, data: { connected: true } });
    } catch (err) {
      res.json({
        success: true,
        data: { connected: false, error: err instanceof Error ? err.message : String(err) },
      });
    }
  });

  router.delete('/config', async (req, res) => {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    await removePostHogCodeCredentials(workspaceId);
    res.json({ success: true } as ApiResponse<void>);
  });

  return router;
}

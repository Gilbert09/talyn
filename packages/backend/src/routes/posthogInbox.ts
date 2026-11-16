import { Router, type Request, type Response } from 'express';
import {
  POSTHOG_INBOX_OAUTH_UNAVAILABLE_CODE,
  POSTHOG_INBOX_RULES_UNAVAILABLE_CODE,
  type ApiResponse,
  type PostHogInboxStatus,
} from '@talyn/shared';
import { assertUser, handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import { userMayUsePostHogInboxRules } from '../services/workflowsAccess.js';
import { normalizeHost } from '../services/posthogCode/hostPolicy.js';
import { isPostHogOAuthEnabled } from '../services/posthogCode/oauthConfig.js';
import { PostHogInboxClient } from '../services/posthogInbox/api.js';
import { removeInboxConnection, storeInboxApiKey } from '../services/posthogInbox/credentials.js';
import { startInboxAuthorization } from '../services/posthogInbox/oauth.js';
import { clearInboxPollerBackoff } from '../services/posthogInbox/poller.js';
import { deleteDestinationsOnDisconnect } from '../services/posthogInbox/pushSetup.js';
import { posthogInboxStatus } from '../services/posthogInbox/preview.js';
import { captureWorkspaceEvent } from '../services/analytics.js';
import { originClient } from './posthog.js';

/**
 * The PostHog Inbox's own PostHog connection: connect with OAuth, save a
 * personal API key, disconnect. The status is `GET /workflows/posthog-inbox/status`.
 *
 * These routes write only the `posthog_inbox` row. They are behind the
 * `posthogInboxRules` flag (a 404 when it is off, like the workflow routes),
 * and NOT behind the PostHog Code retirement: the Inbox is not a cloud
 * provider. The OAuth callback is PostHog Code's (`/posthog/oauth/callback`),
 * which routes the state by its `kind`.
 */
export function posthogInboxRoutes(): Router {
  const router = Router();

  /** The flag for the caller, then access to the workspace. */
  async function gate(req: Request, res: Response, workspaceId: string | undefined): Promise<boolean> {
    if (!workspaceId) {
      res.status(400).json({ success: false, error: 'workspaceId is required' });
      return false;
    }
    const user = assertUser(req);
    if (!(await userMayUsePostHogInboxRules({ distinctId: user.id, email: user.email }))) {
      res.status(404).json({
        success: false,
        error: 'PostHog Inbox automations are not available for this account.',
        code: POSTHOG_INBOX_RULES_UNAVAILABLE_CODE,
      });
      return false;
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      handleAccessError(err, res);
      return false;
    }
    return true;
  }

  /** Begin the OAuth flow for the Inbox. Returns the PostHog URL to open. */
  router.post('/oauth/start', async (req, res) => {
    const { workspaceId, host, projectId } = (req.body ?? {}) as {
      workspaceId?: string;
      host?: string;
      projectId?: string;
    };
    if (!(await gate(req, res, workspaceId))) return;
    if (!isPostHogOAuthEnabled()) {
      return res.status(400).json({
        success: false,
        error: 'Connecting with PostHog is not available on this deployment. Use a personal API key.',
        code: POSTHOG_INBOX_OAUTH_UNAVAILABLE_CODE,
      });
    }
    let resolvedHost: string;
    try {
      resolvedHost = normalizeHost(host);
    } catch (err) {
      return res.status(400).json({ success: false, error: (err as Error).message });
    }
    const { authorizeUrl } = await startInboxAuthorization({
      workspaceId: workspaceId as string,
      userId: assertUser(req).id,
      host: resolvedHost,
      client: originClient(req),
      projectIdHint: typeof projectId === 'string' && projectId ? projectId : undefined,
    });
    res.json({ success: true, data: { authorizeUrl } } as ApiResponse<{ authorizeUrl: string }>);
  });

  /**
   * Save a personal API key for the Inbox. PostHog must answer a one-report
   * list with it (`inbox:read`) before it is stored, so a bad key never is.
   */
  router.put('/config', async (req, res) => {
    const { workspaceId, apiKey, projectId, host } = (req.body ?? {}) as {
      workspaceId?: string;
      apiKey?: string;
      projectId?: string;
      host?: string;
    };
    if (!(await gate(req, res, workspaceId))) return;
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    const project = typeof projectId === 'string' ? projectId.trim() : '';
    if (!key || !project) {
      return res.status(400).json({ success: false, error: 'apiKey and projectId are required' });
    }
    let resolvedHost: string;
    try {
      resolvedHost = normalizeHost(host);
      await new PostHogInboxClient(key, project, resolvedHost).listReports({ limit: 1 });
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: `PostHog did not accept the key for the Inbox: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    try {
      await storeInboxApiKey(workspaceId as string, { apiKey: key, projectId: project, host: resolvedHost });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[posthog-inbox] failed to store credentials:', msg);
      return res.status(500).json({ success: false, error: `Could not store credentials: ${msg}` });
    }
    await clearInboxPollerBackoff(workspaceId as string);
    captureWorkspaceEvent(workspaceId as string, 'posthog_inbox_connected', { authMethod: 'personal_api_key' });
    const data = await posthogInboxStatus(workspaceId as string);
    res.json({ success: true, data } as ApiResponse<PostHogInboxStatus>);
  });

  /**
   * Remove the Inbox's own connection. A PostHog Code connection stays.
   * Talyn's PostHog push destination is deleted first with this connection,
   * best effort: it never blocks the disconnect.
   */
  router.delete('/config', async (req, res) => {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!(await gate(req, res, workspaceId))) return;
    await deleteDestinationsOnDisconnect(workspaceId as string);
    await removeInboxConnection(workspaceId as string);
    const data = await posthogInboxStatus(workspaceId as string);
    res.json({ success: true, data } as ApiResponse<PostHogInboxStatus>);
  });

  return router;
}

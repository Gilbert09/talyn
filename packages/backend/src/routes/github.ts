import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { githubService } from '../services/github.js';
import { prMonitorService } from '../services/prMonitor.js';
import {
  isGitHubAppConfigured,
  buildInstallUrl,
  exchangeUserCode,
  fetchInstallation,
  fetchInstallationRepos,
} from '../services/githubApp.js';
import { getPoolDbClient } from '../db/client.js';
import { githubInstallations } from '../db/schema.js';
import {
  handleAccessError,
  requireWorkspaceAccess,
} from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { debugBus } from '../services/debugBus.js';
import type { ApiResponse } from '@fastowl/shared';

// OAuth flows don't run more than a few times per user per hour. 20 per
// 10 minutes per IP is generous for legitimate retries and blunts brute-
// force attempts at guessing state tokens on /callback.
const oauthRateLimit = rateLimit({
  windowMs: 10 * 60_000,
  max: 20,
  message: 'Too many OAuth requests — slow down.',
});

// Store pending OAuth states (in production, use Redis or similar).
// Keyed by the opaque state token; records which user started the flow
// for which workspace so the public /callback can't be hijacked.
const pendingOAuthStates = new Map<
  string,
  { workspaceId: string; userId: string; expiresAt: number }
>();

setInterval(() => {
  const now = Date.now();
  for (const [state, data] of pendingOAuthStates) {
    if (data.expiresAt < now) pendingOAuthStates.delete(state);
  }
}, 60000);

/**
 * Routes hit by GitHub's browser redirect — no auth header available.
 * The state-token lookup is the entire security model here; any request
 * without a matching pending state is rejected.
 */
export function githubPublicRoutes(): Router {
  const router = Router();

  // GitHub App install redirect. GitHub appends `installation_id`,
  // `setup_action`, plus the OAuth `code` (user authorization requested during
  // install) and our `state`. We exchange the code for the user-to-server
  // token, persist the installation + integration, then kick a bulk refresh.
  router.get('/app/callback', oauthRateLimit, async (req, res) => {
    const { code, state, installation_id, error, error_description } = req.query;
    if (error) {
      return res.status(400).type('html').send(
        renderCallbackPage({
          ok: false,
          message: (error_description as string) || (error as string) || 'GitHub App error',
        })
      );
    }
    if (!code || !state || !installation_id) {
      return res.status(400).type('html').send(
        renderCallbackPage({ ok: false, message: 'Missing code, state, or installation_id' })
      );
    }
    const [workspaceId, stateToken] = (state as string).split(':');
    const pendingState = pendingOAuthStates.get(stateToken);
    if (!pendingState || pendingState.workspaceId !== workspaceId) {
      return res.status(400).type('html').send(
        renderCallbackPage({ ok: false, message: 'Invalid install state — try again from FastOwl' })
      );
    }
    pendingOAuthStates.delete(stateToken);

    try {
      await completeAppInstallation(workspaceId, code as string, String(installation_id));
      res.type('html').send(renderCallbackPage({ ok: true, message: 'GitHub App connected!' }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).type('html').send(renderCallbackPage({ ok: false, message }));
    }
  });

  return router;
}

/**
 * Finish an App installation: exchange the OAuth code for the user-to-server
 * token, read the installation's account + selected repos, upsert the global
 * `github_installations` row, store the workspace integration (user token +
 * installationId), and trigger a bulk refresh so the UI fills immediately.
 */
async function completeAppInstallation(
  workspaceId: string,
  code: string,
  installationId: string
): Promise<void> {
  const userToken = await exchangeUserCode(code);
  const info = await fetchInstallation(installationId);
  const repoFullNames = await fetchInstallationRepos(installationId).catch(() => []);

  const db = getPoolDbClient();
  const now = new Date();
  await db
    .insert(githubInstallations)
    .values({
      installationId,
      accountLogin: info.accountLogin,
      accountType: info.accountType,
      repoFullNames,
      suspendedAt: info.suspended ? now : null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: githubInstallations.installationId,
      set: {
        accountLogin: info.accountLogin,
        accountType: info.accountType,
        repoFullNames,
        suspendedAt: info.suspended ? now : null,
        updatedAt: now,
      },
    });

  const nowMs = Date.now();
  await githubService.storeToken(
    workspaceId,
    userToken.access_token,
    userToken.token_type,
    userToken.scope,
    {
      installationId,
      // Present only when the App has token expiry enabled — drives rotation.
      ...(userToken.refreshToken ? { refreshToken: userToken.refreshToken } : {}),
      ...(userToken.expiresInSec
        ? { accessTokenExpiresAt: nowMs + userToken.expiresInSec * 1000 }
        : {}),
      ...(userToken.refreshTokenExpiresInSec
        ? { refreshTokenExpiresAt: nowMs + userToken.refreshTokenExpiresInSec * 1000 }
        : {}),
    }
  );

  debugBus.recordEvent({
    service: 'github',
    action: 'installation:connected',
    summary: `installation ${installationId} (${info.accountLogin}) connected to ws ${workspaceId.slice(0, 8)} — ${repoFullNames.length} repo(s)`,
    workspaceId,
  });

  // Fill the UI immediately rather than waiting for the first webhook.
  void prMonitorService.refreshWorkspaceNow(workspaceId).catch((err) => {
    console.error('[github] post-install bulk refresh failed:', err);
  });
}

/**
 * Render the minimal callback landing page. The user's browser opened
 * the OAuth flow and GitHub redirects back here — we need to give them
 * *something* to look at before they close the tab. The desktop app
 * polls its GitHub status on focus, so there's no need for a deep link.
 */
function renderCallbackPage(opts: { ok: boolean; message: string }): string {
  const color = opts.ok ? '#16a34a' : '#dc2626';
  const title = opts.ok ? 'GitHub connected' : 'Connection failed';
  const safe = escapeHtml(opts.message);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>FastOwl — ${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #0b0b0f; color: #e5e7eb; display: grid; place-items: center;
           min-height: 100vh; margin: 0; }
    .card { background: #16161d; border: 1px solid #27272f; border-radius: 12px;
            padding: 32px 40px; max-width: 420px; text-align: center; }
    h1 { margin: 0 0 8px 0; font-size: 20px; color: ${color}; }
    p { margin: 0; color: #9ca3af; font-size: 14px; line-height: 1.5; }
    .hint { margin-top: 18px; font-size: 12px; color: #6b7280; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${safe}</p>
    <p class="hint">You can close this tab and return to FastOwl.</p>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Authenticated GitHub routes. Every endpoint takes a workspaceId (body or
 * query) and we verify the caller owns that workspace before touching the
 * stored integration tokens.
 */
export function githubRoutes(): Router {
  const router = Router();

  // Helper: pull workspaceId from body or query, verify ownership, or 4xx.
  async function gateWorkspace(
    req: import('express').Request,
    res: import('express').Response,
    source: 'body' | 'query' = 'query'
  ): Promise<string | null> {
    const workspaceId =
      source === 'body'
        ? (req.body?.workspaceId as string | undefined)
        : (req.query.workspaceId as string | undefined);
    if (!workspaceId) {
      res.status(400).json({ success: false, error: 'workspaceId is required' });
      return null;
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      handleAccessError(err, res);
      return null;
    }
    return workspaceId;
  }

  router.get('/status', async (req, res) => {
    const configured = githubService.isConfigured();

    if (!configured) {
      return res.json({
        success: true,
        data: {
          configured: false,
          connected: false,
          message: 'GitHub App not configured. Set GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY (see docs/SETUP.md §3b).',
        },
      });
    }

    const workspaceId = req.query.workspaceId as string | undefined;
    if (workspaceId) {
      try {
        await requireWorkspaceAccess(req, workspaceId);
      } catch (err) {
        return handleAccessError(err, res);
      }
      const status = githubService.getConnectionStatus(workspaceId);
      return res.json({
        success: true,
        data: { configured: true, ...status },
      });
    }

    res.json({ success: true, data: { configured: true, connected: false } });
  });

  // GitHub App install URL. The public /app/callback validates the state token
  // before persisting anything.
  router.post('/app/install-url', oauthRateLimit, async (req, res) => {
    const workspaceId = await gateWorkspace(req, res, 'body');
    if (!workspaceId) return;
    if (!isGitHubAppConfigured()) {
      return res.status(400).json({ success: false, error: 'GitHub App not configured' });
    }
    const state = uuid();
    pendingOAuthStates.set(state, {
      workspaceId,
      userId: req.user!.id,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    try {
      const installUrl = buildInstallUrl(`${workspaceId}:${state}`);
      res.json({ success: true, data: { installUrl, state } });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  router.post('/disconnect', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res, 'body');
    if (!workspaceId) return;
    await githubService.removeToken(workspaceId, 'user disconnected via POST /github/disconnect');
    res.json({ success: true } as ApiResponse<void>);
  });

  router.get('/user', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const user = await githubService.getUser(workspaceId);
      res.json({ success: true, data: user });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  router.get('/repos', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const repos = await githubService.listRepositories(workspaceId);
      res.json({ success: true, data: repos });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  // Everything the user can watch: their own repos + all their orgs'
  // repos, merged. Expensive (fans out across orgs) — the desktop caches
  // the result in localStorage and only re-hits this on explicit refresh.
  router.get('/all-repos', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const repos = await githubService.listAllAccessibleRepos(workspaceId);
      res.json({ success: true, data: repos });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  // Orgs the user belongs to — drives the org-browse repo picker.
  router.get('/orgs', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const orgs = await githubService.listOrganizations(workspaceId);
      res.json({ success: true, data: orgs });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  // Repos in a specific org. Lets the user watch repos in orgs they
  // belong to (e.g. public org repos) that don't surface in /user/repos.
  router.get('/orgs/:org/repos', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res);
    if (!workspaceId) return;
    try {
      const repos = await githubService.listOrgRepositories(workspaceId, req.params.org);
      res.json({ success: true, data: repos });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  // The PR-management surface (list / get / files / checks /
  // create / update / merge / review / comment) was removed in
  // Phase 7 — read paths moved to /pull-requests, write paths
  // are explicit "open on GitHub" deep-links. The internal
  // `githubService.createPullRequest` is still used by
  // openPullRequestForTask but no longer has its own HTTP route.

  router.get('/repos/:owner/:repo/branches', async (req, res) => {
    const workspaceId = await gateWorkspace(req, res);
    if (!workspaceId) return;
    const { owner, repo } = req.params;
    const { per_page, page } = req.query;
    try {
      const branches = await githubService.listBranches(workspaceId, owner, repo, {
        per_page: per_page ? parseInt(per_page as string, 10) : undefined,
        page: page ? parseInt(page as string, 10) : undefined,
      });
      res.json({ success: true, data: branches });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(400).json({ success: false, error: message });
    }
  });

  return router;
}

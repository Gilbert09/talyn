import { Router } from 'express';
import type { CloudProviderType, ApiResponse, FleetAgent } from '@talyn/shared';
import { randomBytes } from 'crypto';
import { assertUser, handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import { buildAuthorizeUrl, exchangeCode, splitPastedCode } from '../services/selfHosted/claudeOauth.js';
import {
  patchSelfHostedConfig,
  readSelfHostedConfig,
} from '../services/selfHosted/credentials.js';
import { createPkcePair } from '../services/posthogCode/oauth.js';
import { decryptString, encryptString } from '../services/tokenCrypto.js';

/**
 * How long a half-finished Claude sign-in stays valid.
 *
 * Long enough to approve in a browser and paste back, short enough that an
 * abandoned attempt does not leave a usable verifier lying in the row. The
 * authorization code Anthropic issues is shorter-lived than this anyway.
 */
const PENDING_AUTH_TTL_MS = 10 * 60_000;

/** Opaque, single-use, and only ever compared against what we minted. */
function randomState(): string {
  return randomBytes(16).toString('hex');
}
import { getCloudProvider, listCloudProviders } from '../services/cloudProviders/registry.js';
import { ensureCloudEnvironment } from '../services/cloudProviders/environment.js';
import { fleetRefusalReason, workspaceMayUseFleet } from '../services/cloudProviders/fleetAccess.js';
import { fleetAgentStatus } from '../services/selfHosted/credentials.js';

interface CloudProviderInfo {
  type: CloudProviderType;
  displayName: string;
  capabilities?: { model?: boolean; runtimeAdapter?: boolean };
  connected: boolean;
  /**
   * Which agent vendors are connected behind this provider.
   *
   * Only Talyn Fleet has more than one — it runs the workspace's own Claude
   * subscription or its own Codex subscription, and `connected` alone cannot
   * say which. The per-task picker needs to know: offering "Talyn Fleet · Codex"
   * to a workspace that never connected Codex produces a task that is refused at
   * dispatch, which is a worse answer than not offering it.
   *
   * Presence only, never values.
   */
  connectedAgents?: FleetAgent[];
  /**
   * Agents whose stored sign-in was REJECTED and cannot be refreshed — the user
   * has to reconnect. Still listed in `connectedAgents`, deliberately: the card
   * has to render the agent to offer "Reconnect", and hiding it would read as
   * "you never set this up".
   */
  reauthAgents?: FleetAgent[];
}

/**
 * Generic, provider-agnostic surface for cloud task providers. Lists the
 * registered providers + their per-workspace connection status, and proxies
 * credential CRUD to each provider's own methods. Adding a provider needs
 * no change here — it registers in index.ts and shows up automatically.
 */
export function cloudProviderRoutes(): Router {
  const router = Router();

  // List providers + connected status for a workspace.
  router.get('/', async (req, res) => {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    // Hiding a provider this workspace may not use is COSMETIC — it keeps the
    // settings screen honest, and nothing more. The gate that matters is at
    // dispatch and at credential-write below, because a filtered list is not a
    // permission check: the CLI, the MCP server and curl never render it.
    const mayUseFleet = await workspaceMayUseFleet(workspaceId);
    const providers: CloudProviderInfo[] = await Promise.all(
      listCloudProviders()
        .filter((p) => p.type !== 'selfhosted' || mayUseFleet)
        .map(async (p) => ({
          type: p.type,
          displayName: p.displayName,
          capabilities: p.capabilities,
          connected: await p.hasCredentials(workspaceId),
          ...(p.type === 'selfhosted' ? await fleetAgentStatus(workspaceId) : {}),
        })),
    );
    res.json({ success: true, data: providers } as ApiResponse<CloudProviderInfo[]>);
  });

  // Validate + store credentials, then auto-provision the env marker.
  router.put('/:type/config', async (req, res) => {
    const provider = getCloudProvider(req.params.type);
    if (!provider) {
      return res.status(404).json({ success: false, error: 'Unknown cloud provider' });
    }
    const { workspaceId } = req.body as { workspaceId?: string };
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }

    // Refuse before any credential is validated or stored. A workspace that
    // cannot dispatch to the fleet has no business holding a fleet token: it
    // would sit encrypted in the integrations row forever, and the first thing
    // anyone would try after being told "not allowed" is to configure it again.
    if (provider.type === 'selfhosted' && !(await workspaceMayUseFleet(workspaceId))) {
      return res.status(403).json({ success: false, error: fleetRefusalReason() });
    }

    const result = await provider.validateCredentials(workspaceId, req.body);
    if (!result.ok) {
      return res.status(400).json({ success: false, error: result.error });
    }
    await ensureCloudEnvironment(assertUser(req).id, provider.type);
    res.json({ success: true, data: { connected: true } });
  });

  /**
   * Start a Claude sign-in: mint PKCE, park the verifier, hand back the URL.
   *
   * Its own pair of routes rather than the generic `/:type/config`, because the
   * flow is two requests with a browser trip between them and the second one
   * carries a code rather than a credential.
   *
   * The same two routes serve the desktop and the web. Anthropic's client
   * redirects to a page Anthropic hosts, so — unlike Codex, whose loopback
   * redirect forces its authorize leg into the desktop main process — there is
   * nothing here that a browser cannot do.
   */
  router.post('/selfhosted/claude/authorize', async (req, res) => {
    const { workspaceId } = req.body as { workspaceId?: string };
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    if (!(await workspaceMayUseFleet(workspaceId))) {
      return res.status(403).json({ success: false, error: fleetRefusalReason() });
    }

    const { verifier, challenge } = createPkcePair();
    const state = randomState();
    // The verifier never leaves the server: the pasted code is worthless
    // without it, which is the whole point of PKCE.
    await patchSelfHostedConfig(workspaceId, {
      claudePendingAuth: {
        state,
        codeVerifierEnc: encryptString(verifier),
        expiresAt: new Date(Date.now() + PENDING_AUTH_TTL_MS).toISOString(),
      },
    });

    res.json({
      success: true,
      data: { url: buildAuthorizeUrl({ codeChallenge: challenge, state }) },
    });
  });

  /** Finish it: exchange the pasted code, store the pair, clear the pending row. */
  router.post('/selfhosted/claude/complete', async (req, res) => {
    const { workspaceId, code } = req.body as { workspaceId?: string; code?: string };
    if (!workspaceId || !code?.trim()) {
      return res.status(400).json({ success: false, error: 'workspaceId and code are required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }

    const pending = (await readSelfHostedConfig(workspaceId))?.claudePendingAuth;
    if (!pending) {
      return res.status(400).json({
        success: false,
        error: 'Start the Claude sign-in again — this one was not found.',
      });
    }
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      await patchSelfHostedConfig(workspaceId, { claudePendingAuth: undefined });
      return res.status(400).json({
        success: false,
        error: 'That sign-in expired. Start it again.',
      });
    }

    const { code: authCode, state } = splitPastedCode(code);
    // The state Anthropic echoes back must be the one we minted. A mismatch
    // means the code came from a different sign-in — most likely an older tab.
    if (state && state !== pending.state) {
      return res.status(400).json({
        success: false,
        error: 'That code is from a different sign-in. Start again and use the newest one.',
      });
    }

    try {
      const credential = await exchangeCode({
        code: authCode,
        codeVerifier: decryptString(pending.codeVerifierEnc),
        ...(state ? { state } : {}),
      });
      await patchSelfHostedConfig(workspaceId, {
        claudeOAuth: credential,
        claudePendingAuth: undefined,
      });
      await ensureCloudEnvironment(assertUser(req).id, 'selfhosted');
      res.json({ success: true, data: { connected: true } });
    } catch (err) {
      // The pending row is cleared either way: a code is single-use, so
      // whatever went wrong, this attempt cannot be retried with it.
      await patchSelfHostedConfig(workspaceId, { claudePendingAuth: undefined });
      res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : 'Could not complete the Claude sign-in.',
      });
    }
  });

  router.post('/:type/test', async (req, res) => {
    const provider = getCloudProvider(req.params.type);
    if (!provider) {
      return res.status(404).json({ success: false, error: 'Unknown cloud provider' });
    }
    const { workspaceId } = req.body as { workspaceId?: string };
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const data = provider.testConnection
      ? await provider.testConnection(workspaceId)
      : { connected: await provider.hasCredentials(workspaceId) };
    res.json({ success: true, data });
  });

  router.delete('/:type/config', async (req, res) => {
    const provider = getCloudProvider(req.params.type);
    if (!provider) {
      return res.status(404).json({ success: false, error: 'Unknown cloud provider' });
    }
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    await provider.removeCredentials(workspaceId);
    res.json({ success: true } as ApiResponse<void>);
  });

  return router;
}

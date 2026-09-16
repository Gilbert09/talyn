import { Router, type Request, type Response } from 'express';
import { validateMcpServer, type ApiResponse, type McpServerDefinition } from '@talyn/shared';
import { captureWorkspaceEvent } from '../services/analytics.js';
import { assertUser, handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import { withMcpServerLimitGate } from '../services/billing/entitlements.js';
import {
  mcpServersRefusalReason,
  workspaceMayUseMcpServers,
} from '../services/mcpServersAccess.js';
import { probeMcpServer } from '../services/mcpServers/probe.js';
import {
  McpOAuthUnavailableError,
  completeMcpOAuth,
  serverIdFromState,
  startMcpOAuth,
} from '../services/mcpServers/oauth.js';
import {
  createMcpServer,
  mcpOAuthStore,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  mcpServersForDispatch,
  recordMcpProbe,
  updateMcpServer,
} from '../services/mcpServers/store.js';

/**
 * MCP MCP servers — `/api/v1/mcp-servers`, mounted below `ownerScope`.
 *
 * Every handler gates on the flag independently of whether the client drew the
 * nav item. `GET /features` decides only what to DRAW: the CLI, the MCP server
 * and plain `curl` all walk straight past a hidden tab.
 *
 * No response carries a credential. The store's projection is what enforces
 * that, and `hasSecret` is the only thing any read says about one.
 */

/** Shape, never content: a server's URL is a vendor, its name is the user's. */
function serverShape(s: McpServerDefinition): Record<string, unknown> {
  let host = 'invalid';
  try {
    host = new URL(s.url).hostname;
  } catch {
    // Left as "invalid" — a shape event must not throw.
  }
  return {
    mcp_server_host: host,
    mcp_auth_kind: s.authKind,
    mcp_from_catalog: s.catalogHandle !== null,
    mcp_tools_restricted: Array.isArray(s.tools),
    mcp_tool_count: Array.isArray(s.tools) ? s.tools.length : null,
    mcp_enabled: s.enabled,
  };
}

export function mcpServerRoutes(): Router {
  const router = Router();

  /**
   * Authorise the workspace and check the flag.
   *
   * Returns false when it has already answered the request, so every handler
   * reads `if (!(await gate(...))) return;` and cannot forget one of the checks.
   */
  async function gate(req: Request, res: Response, workspaceId: string): Promise<boolean> {
    if (!workspaceId) {
      res.status(400).json({ success: false, error: 'workspaceId is required' });
      return false;
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      handleAccessError(err, res);
      return false;
    }
    if (!(await workspaceMayUseMcpServers(workspaceId))) {
      res.status(403).json({
        success: false,
        error: `MCP servers are not available: ${mcpServersRefusalReason()}.`,
        code: 'mcp_servers_unavailable',
      });
      return false;
    }
    return true;
  }

  /**
   * Load a server and authorise its workspace in one step.
   *
   * Returns null when it has already answered. A row the caller may not reach
   * and a row that does not exist are both 404, deliberately: distinguishing
   * them would let anybody enumerate other workspaces' server ids.
   */
  async function loadAndGate(
    req: Request,
    res: Response
  ): Promise<McpServerDefinition | null> {
    const server = await getMcpServer(req.params.id as string);
    if (!server) {
      res.status(404).json({ success: false, error: 'no such MCP server' });
      return null;
    }
    if (!(await gate(req, res, server.workspaceId))) return null;
    return server;
  }

  router.get('/', async (req: Request, res: Response) => {
    const workspaceId = String(req.query.workspaceId ?? '');
    if (!(await gate(req, res, workspaceId))) return;
    const data = await listMcpServers(workspaceId);
    res.json({ success: true, data } as ApiResponse<typeof data>);
  });

  /**
   * The counter, for the nav badge.
   *
   * Declared ABOVE `/:id` so the literal path is not swallowed by the
   * parameterised one — Express matches in declaration order.
   */
  router.get('/count', async (req: Request, res: Response) => {
    const workspaceId = String(req.query.workspaceId ?? '');
    if (!(await gate(req, res, workspaceId))) return;
    const servers = await listMcpServers(workspaceId);
    const data = { enabled: servers.filter((s) => s.enabled).length };
    res.json({ success: true, data } as ApiResponse<typeof data>);
  });

  router.get('/:id', async (req: Request, res: Response) => {
    const server = await loadAndGate(req, res);
    if (!server) return;
    res.json({ success: true, data: server } as ApiResponse<typeof server>);
  });

  router.post('/', async (req: Request, res: Response) => {
    const workspaceId = String(req.body?.workspaceId ?? '');
    if (!(await gate(req, res, workspaceId))) return;

    let normalized;
    try {
      normalized = validateMcpServer(req.body);
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : 'invalid MCP server',
      });
    }

    // The name is a hostname label inside the sandbox, so two servers in one
    // dispatch set cannot share one. Caught here, where the message can name
    // the problem, rather than as a 400 from the fleet with nothing to act on.
    const existing = await listMcpServers(workspaceId);
    if (existing.some((s) => s.name === normalized.name)) {
      return res.status(409).json({
        success: false,
        error: `this workspace already has an MCP server called "${normalized.name}"`,
      });
    }

    const created = await withMcpServerLimitGate(assertUser(req).id, () =>
      createMcpServer(workspaceId, normalized)
    );
    captureWorkspaceEvent(workspaceId, 'mcp_server_connected', serverShape(created));
    res.status(201).json({ success: true, data: created } as ApiResponse<typeof created>);
  });

  router.patch('/:id', async (req: Request, res: Response) => {
    const server = await loadAndGate(req, res);
    if (!server) return;

    let normalized;
    try {
      normalized = validateMcpServer({ ...req.body, name: req.body?.name ?? server.name });
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : 'invalid MCP server',
      });
    }

    const siblings = await listMcpServers(server.workspaceId);
    if (siblings.some((s) => s.id !== server.id && s.name === normalized.name)) {
      return res.status(409).json({
        success: false,
        error: `this workspace already has an MCP server called "${normalized.name}"`,
      });
    }

    const updated = await updateMcpServer(server.id, normalized);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'no such MCP server' });
    }
    captureWorkspaceEvent(server.workspaceId, 'mcp_server_updated', serverShape(updated));
    res.json({ success: true, data: updated } as ApiResponse<typeof updated>);
  });

  router.delete('/:id', async (req: Request, res: Response) => {
    const server = await loadAndGate(req, res);
    if (!server) return;
    await deleteMcpServer(server.id);
    captureWorkspaceEvent(server.workspaceId, 'mcp_server_disconnected', serverShape(server));
    res.json({ success: true, data: null } as ApiResponse<null>);
  });

  /**
   * Ask the server to introduce itself, and list its tools.
   *
   * One endpoint rather than two because they are one round trip: `tools/list`
   * needs the session `initialize` opened, so splitting them would mean
   * connecting twice to answer two halves of the same question.
   *
   * The result is STORED as well as returned, so the list page can show what a
   * server last said without re-probing every vendor on every render.
   */
  router.post('/:id/test', async (req: Request, res: Response) => {
    const server = await loadAndGate(req, res);
    if (!server) return;

    // Decrypted through the dispatch path deliberately: probing with a
    // different credential from the one a run would carry is how a green tick
    // comes to mean nothing.
    const [withSecret] = await mcpServersForDispatch(server.workspaceId, [server.id]);
    const probe = await probeMcpServer({
      url: server.url,
      authKind: server.authKind,
      inject: server.inject,
      secret: withSecret?.secret ?? null,
    });
    await recordMcpProbe(server.id, probe);
    captureWorkspaceEvent(server.workspaceId, 'mcp_server_tested', {
      ...serverShape(server),
      mcp_probe_ok: probe.ok,
    });
    res.json({ success: true, data: probe } as ApiResponse<typeof probe>);
  });

  /**
   * Start the sign-in leg, and say where to send a browser.
   *
   * A POST and not a redirect, because it WRITES a flow and may register a
   * client at a third party — neither belongs behind a link a prefetcher will
   * follow. The caller does the redirect with what it gets back, then polls.
   */
  router.post('/:id/connect', async (req: Request, res: Response) => {
    const server = await loadAndGate(req, res);
    if (!server) return;
    try {
      const stored = await mcpOAuthStore.read(server.id);
      const started = await startMcpOAuth(server, stored, new Date());
      await mcpOAuthStore.write(server.id, started.stored);
      captureWorkspaceEvent(server.workspaceId, 'mcp_server_connect_started', {
        ...serverShape(server),
        mcp_client_source: started.stored.clientSource ?? null,
      });
      const data = {
        flowId: started.flowId,
        authorizeUrl: started.authorizeUrl,
        expiresAt: started.expiresAt,
        scopes: started.scopes,
      };
      res.json({ success: true, data } as ApiResponse<typeof data>);
    } catch (err) {
      // A vendor that cannot be signed in to is not a 500. The message is the
      // whole answer — "paste an API key instead" is something to act on.
      const message = err instanceof Error ? err.message : 'could not start sign-in';
      res.status(err instanceof McpOAuthUnavailableError ? 501 : 409).json({
        success: false,
        error: message,
        code: 'mcp_oauth_unavailable',
      });
    }
  });

  /**
   * Did that sign-in finish?
   *
   * The poll a client runs while somebody is at the consent screen. Returns the
   * STATUS and never a credential.
   */
  router.get('/:id/connect/:flow', async (req: Request, res: Response) => {
    const server = await loadAndGate(req, res);
    if (!server) return;
    const stored = await mcpOAuthStore.read(server.id);
    // A finished flow has been cleared, so "no flow and connected" is success
    // rather than a missing row.
    const data = {
      status: stored?.status ?? 'pending',
      pending: stored?.flow?.id === req.params.flow,
      ...(stored?.detail ? { detail: stored.detail } : {}),
    };
    res.json({ success: true, data } as ApiResponse<typeof data>);
  });

  /**
   * Finish a sign-in, from the callback page.
   *
   * The page the vendor's browser lands on is on the WEB APP — it is the
   * redirect URI the authorization server was told — and it has nothing but
   * `code` and `state`. The state names the server; the stored flow's hash is
   * what authorises the exchange.
   *
   * Authenticated and workspace-gated like every other route here. The code
   * passing through the user's browser is harmless on its own: PKCE binds it to
   * a verifier that never leaves this process.
   */
  router.post('/complete', async (req: Request, res: Response) => {
    const state = String(req.body?.state ?? '');
    const code = String(req.body?.code ?? '');
    if (!state || !code) {
      return res.status(400).json({ success: false, error: 'state and code are required' });
    }
    const serverId = serverIdFromState(state);
    if (!serverId) {
      return res.status(400).json({ success: false, error: 'that sign-in did not come from here' });
    }
    const server = await getMcpServer(serverId);
    if (!server) {
      return res.status(404).json({ success: false, error: 'no such MCP server' });
    }
    if (!(await gate(req, res, server.workspaceId))) return;

    const stored = await mcpOAuthStore.read(server.id);
    if (!stored) {
      return res.status(409).json({ success: false, error: 'there is no sign-in waiting to be finished' });
    }
    try {
      const next = await completeMcpOAuth(stored, state, code, new Date());
      await mcpOAuthStore.write(server.id, next);
      captureWorkspaceEvent(server.workspaceId, 'mcp_server_connected_oauth', serverShape(server));
      const updated = await getMcpServer(server.id);
      res.json({ success: true, data: updated } as ApiResponse<typeof updated>);
    } catch (err) {
      // The vendor's own words where there are any. A refusal here is a fact
      // about the grant, not a server fault, so it is a 409 and not a 500.
      const message = err instanceof Error ? err.message : 'could not finish sign-in';
      await mcpOAuthStore.write(server.id, {
        ...stored,
        status: 'pending',
        detail: message,
        flow: undefined,
      });
      res.status(409).json({ success: false, error: message });
    }
  });

  /**
   * Hand back the grant, without forgetting who this server is.
   *
   * The endpoints and the client id are KEPT: they do not move, and keeping
   * them is what lets a reconnect skip discovery and registration rather than
   * leaving another orphan client at the vendor.
   */
  router.post('/:id/disconnect', async (req: Request, res: Response) => {
    const server = await loadAndGate(req, res);
    if (!server) return;
    const stored = await mcpOAuthStore.read(server.id);
    if (stored) {
      await mcpOAuthStore.write(server.id, {
        ...stored,
        status: 'pending',
        detail: undefined,
        accessTokenEnc: undefined,
        refreshTokenEnc: undefined,
        expiresAt: undefined,
        flow: undefined,
      });
    }
    captureWorkspaceEvent(server.workspaceId, 'mcp_server_disconnected_oauth', serverShape(server));
    const updated = await getMcpServer(server.id);
    res.json({ success: true, data: updated } as ApiResponse<typeof updated>);
  });

  return router;
}

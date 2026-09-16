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
  createMcpServer,
  deleteMcpServer,
  getMcpServer,
  listMcpServers,
  mcpServersForDispatch,
  recordMcpProbe,
  updateMcpServer,
} from '../services/mcpServers/store.js';

/**
 * MCP tool servers — `/api/v1/mcp-servers`, mounted below `ownerScope`.
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
        error: `Tool servers are not available: ${mcpServersRefusalReason()}.`,
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
      res.status(404).json({ success: false, error: 'no such tool server' });
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
        error: err instanceof Error ? err.message : 'invalid tool server',
      });
    }

    // The name is a hostname label inside the sandbox, so two servers in one
    // dispatch set cannot share one. Caught here, where the message can name
    // the problem, rather than as a 400 from the fleet with nothing to act on.
    const existing = await listMcpServers(workspaceId);
    if (existing.some((s) => s.name === normalized.name)) {
      return res.status(409).json({
        success: false,
        error: `this workspace already has a tool server called "${normalized.name}"`,
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
        error: err instanceof Error ? err.message : 'invalid tool server',
      });
    }

    const siblings = await listMcpServers(server.workspaceId);
    if (siblings.some((s) => s.id !== server.id && s.name === normalized.name)) {
      return res.status(409).json({
        success: false,
        error: `this workspace already has a tool server called "${normalized.name}"`,
      });
    }

    const updated = await updateMcpServer(server.id, normalized);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'no such tool server' });
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

  return router;
}

import { Router } from 'express';
import type { ApiResponse } from '@talyn/shared';
import { validateWorkflow } from '@talyn/shared';
import { handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflowRuns,
  listWorkflows,
  updateWorkflow,
} from '../services/workflows/store.js';
import {
  workspaceMayUseWorkflows,
  workflowsRefusalReason,
} from '../services/workflowsAccess.js';

/**
 * Workflows — user-defined PR automation.
 *
 * Mounted BELOW `ownerScope`: every row here is workspace-scoped, so the RLS
 * policies (migration 0052) are the second line of defence behind
 * `requireWorkspaceAccess`.
 *
 * Every handler gates on the allow-list. That is not belt-and-braces with the
 * hidden nav item — the nav item is not a gate at all, it is a decoration that
 * the CLI, the MCP server and plain `curl` walk straight past. See
 * `services/workflowsAccess.ts`.
 *
 * A refusal is 403 with the reason, not 404. The three reasons (the deployment
 * has it off, nobody is allow-listed, you are not on the list) are genuinely
 * different, and reading a forgotten env var as "working as intended" costs an
 * evening.
 */

/** How many history rows one page returns when the caller does not say. */
const DEFAULT_RUN_PAGE = 50;
/**
 * Hard ceiling on a history page. The rows carry a per-action jsonb, and this
 * endpoint is keyset-paginated, so a caller wanting more should page rather than
 * ask for one enormous response.
 */
const MAX_RUN_PAGE = 200;

export function workflowRoutes(): Router {
  const router = Router();

  /** Resolve + authorise + gate. Returns null when it has already answered. */
  async function gate(
    req: Parameters<Parameters<Router['get']>[1]>[0],
    res: Parameters<Parameters<Router['get']>[1]>[1],
    workspaceId: string
  ): Promise<boolean> {
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
    if (!(await workspaceMayUseWorkflows(workspaceId))) {
      res.status(403).json({
        success: false,
        error: `Workflows are not available: ${workflowsRefusalReason()}.`,
        code: 'workflows_unavailable',
      });
      return false;
    }
    return true;
  }

  router.get('/', async (req, res) => {
    const workspaceId = req.query.workspaceId as string;
    if (!(await gate(req, res, workspaceId))) return;
    const data = await listWorkflows(workspaceId);
    res.json({ success: true, data } as ApiResponse<typeof data>);
  });

  router.post('/', async (req, res) => {
    const workspaceId = (req.body as { workspaceId?: string } | undefined)?.workspaceId ?? '';
    if (!(await gate(req, res, workspaceId))) return;
    let normalized;
    try {
      normalized = validateWorkflow(req.body);
    } catch (err) {
      // The validator's messages are written for a person — pass them through
      // rather than flattening every bad shape to "invalid workflow".
      return res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : 'invalid workflow',
      });
    }
    const data = await createWorkflow(workspaceId, normalized);
    res.json({ success: true, data } as ApiResponse<typeof data>);
  });

  router.patch('/:id', async (req, res) => {
    const existing = await getWorkflow(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Workflow not found' });
    }
    if (!(await gate(req, res, existing.workspaceId))) return;

    // A PATCH here is a whole-workflow replace, not a field merge. The trigger,
    // the conditions and the actions validate against each other — a condition
    // is legal only for certain events — so a partial update could land a
    // combination the validator would have refused as a whole.
    let normalized;
    try {
      normalized = validateWorkflow({ ...existing, ...(req.body as object) });
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : 'invalid workflow',
      });
    }
    const data = await updateWorkflow(existing.id, existing.workspaceId, normalized);
    if (!data) return res.status(404).json({ success: false, error: 'Workflow not found' });
    res.json({ success: true, data } as ApiResponse<typeof data>);
  });

  router.delete('/:id', async (req, res) => {
    const existing = await getWorkflow(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Workflow not found' });
    }
    if (!(await gate(req, res, existing.workspaceId))) return;
    await deleteWorkflow(existing.id, existing.workspaceId);
    res.json({ success: true, data: null } as ApiResponse<null>);
  });

  /** One workflow's run history, newest first. `cursor` is the last row's createdAt. */
  router.get('/:id/runs', async (req, res) => {
    const existing = await getWorkflow(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Workflow not found' });
    }
    if (!(await gate(req, res, existing.workspaceId))) return;
    const asked = Number(req.query.limit);
    const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, MAX_RUN_PAGE) : DEFAULT_RUN_PAGE;
    const data = await listWorkflowRuns(existing.id, {
      limit,
      cursor: (req.query.cursor as string) || null,
    });
    res.json({ success: true, data } as ApiResponse<typeof data>);
  });

  return router;
}

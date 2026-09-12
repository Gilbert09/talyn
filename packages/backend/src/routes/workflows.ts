import { Router, type Request, type Response } from 'express';
import type { ApiResponse } from '@talyn/shared';
import { validateWorkflow } from '@talyn/shared';
import type { NormalizedWorkflow } from '@talyn/shared';
import { captureWorkspaceEvent } from '../services/analytics.js';
import { handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import {
  countWorkflows,
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
import { workflowSuggestions } from '../services/workflows/suggestions.js';

/**
 * Workflows — user-defined PR automation.
 *
 * Mounted BELOW `ownerScope`: every row here is workspace-scoped, so the RLS
 * policies (migration 0052) are the second line of defence behind
 * `requireWorkspaceAccess`.
 *
 * Every handler gates on the kill switch. That is not belt-and-braces with the
 * hidden nav item — the nav item is not a gate at all, it is a decoration that
 * the CLI, the MCP server and plain `curl` walk straight past. See
 * `services/workflowsAccess.ts`.
 *
 * A refusal is 403 with the reason, not 404: somebody switching the feature off
 * should be able to tell that from a route that does not exist.
 */

/** How many history rows one page returns when the caller does not say. */
const DEFAULT_RUN_PAGE = 50;
/**
 * Hard ceiling on a history page. The rows carry a per-action jsonb, and this
 * endpoint is keyset-paginated, so a caller wanting more should page rather than
 * ask for one enormous response.
 */
const MAX_RUN_PAGE = 200;

/**
 * What a workflow definition event reports.
 *
 * The SHAPE of the rule, never its content: which triggers, which condition
 * KEYS, which action types. Not the name, not the label values, not the logins,
 * not the prompt. Those are the user's words about their own repositories, and a
 * product-analytics event is the wrong place for them — we want to know whether
 * people build workflows and which parts they reach for, and none of that needs
 * the contents.
 *
 * (`workflow_ran` does carry repo and PR number, because a run without the thing
 * it ran on cannot be debugged. A definition can.)
 */
function workflowShape(
  id: string,
  workflow: Pick<NormalizedWorkflow, 'events' | 'conditions' | 'actions' | 'enabled'>
): Record<string, unknown> {
  return {
    workflow_id: id,
    enabled: workflow.enabled,
    trigger_count: workflow.events.length,
    events: workflow.events,
    condition_keys: Object.keys(workflow.conditions).sort(),
    condition_count: Object.keys(workflow.conditions).length,
    action_types: workflow.actions.map((a) => a.type),
    action_count: workflow.actions.length,
  };
}

export function workflowRoutes(): Router {
  const router = Router();

  /**
   * Authorise the workspace and check the allow-list.
   *
   * Returns false when it has already answered the request, so every handler
   * reads `if (!(await gate(...))) return;` and cannot forget one of the two
   * checks.
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
    if (!workspaceMayUseWorkflows()) {
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

  /**
   * Just the counters, for the sidebar's nav badge.
   *
   * Separate from `GET /` because this one is fetched on every client boot,
   * whether or not anybody opens the Workflows page, and the list read is the
   * expensive one — every rule's jsonb plus an aggregate over the whole run
   * history. This returns a single integer.
   *
   * Mounted ABOVE `/:id`, like `/suggestions`: Express matches in declaration
   * order and `/count` would otherwise be read as a workflow id and 404.
   */
  router.get('/count', async (req, res) => {
    const workspaceId = req.query.workspaceId as string;
    if (!(await gate(req, res, workspaceId))) return;
    const data = await countWorkflows(workspaceId);
    res.json({ success: true, data } as ApiResponse<typeof data>);
  });

  /**
   * The editor's autocomplete options.
   *
   * Two modes, and the default is the cheap one. With no query beyond the
   * workspace this is a pure database read — the watched repositories and their
   * default branches — which is what the editor wants when it opens, and costs
   * nothing. `github=1` additionally reads labels for the repositories in
   * `repos`, plus the collaborators and teams of their owners.
   *
   * The split exists because the first version spent 320+ GitHub requests the
   * moment the editor opened, on a workspace watching 80 repositories. Now
   * nothing is spent until somebody opens a field that needs it, and then only
   * for the repositories the workflow names.
   *
   * Mounted ABOVE `/:id` — Express matches in declaration order, and
   * `/suggestions` would otherwise be read as a workflow id and 404.
   *
   * Never fails: `workflowSuggestions` settles each fetch independently and
   * returns empty lists with `partial: true` for whatever it could not get. A
   * picker with no suggestions is still a working text field; a 500 is an editor
   * that will not open.
   */
  router.get('/suggestions', async (req, res) => {
    const workspaceId = req.query.workspaceId as string;
    if (!(await gate(req, res, workspaceId))) return;
    const repos = String(req.query.repos ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    const data = await workflowSuggestions(workspaceId, {
      repos,
      includeGithub: req.query.github === '1',
    });
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
    // Server-side, not from the client: `workflow_ran` can tell us how often
    // workflows FIRE but not how many people build one, and a user whose three
    // workflows never match is indistinguishable from a user who built none.
    // Emitted here so a client that reports nothing cannot hide adoption — the
    // Session 116 lesson.
    captureWorkspaceEvent(workspaceId, 'workflow_created', workflowShape(data.id, normalized));
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

    captureWorkspaceEvent(
      existing.workspaceId,
      'workflow_updated',
      workflowShape(existing.id, normalized)
    );
    // Its own event, because switching a workflow OFF is the strongest signal
    // that something about it is wrong — and it is invisible inside a generic
    // "updated" that fires for every rename too.
    if (normalized.enabled !== existing.enabled) {
      captureWorkspaceEvent(existing.workspaceId, 'workflow_enabled_toggled', {
        ...workflowShape(existing.id, normalized),
        previously_enabled: existing.enabled,
      });
    }
    res.json({ success: true, data } as ApiResponse<typeof data>);
  });

  router.delete('/:id', async (req, res) => {
    const existing = await getWorkflow(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Workflow not found' });
    }
    if (!(await gate(req, res, existing.workspaceId))) return;
    await deleteWorkflow(existing.id, existing.workspaceId);
    captureWorkspaceEvent(existing.workspaceId, 'workflow_deleted', {
      ...workflowShape(existing.id, existing),
      // How long it lasted. A rule deleted within the hour is a failed attempt;
      // one deleted after a month did its job and stopped being needed.
      age_hours: Math.round((Date.now() - new Date(existing.createdAt).getTime()) / 3_600_000),
    });
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

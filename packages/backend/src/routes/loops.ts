import { Router, type Request, type Response } from 'express';
import { eq, and } from 'drizzle-orm';
import {
  fleetAgentForModel,
  presetForCron,
  validateLoop,
  type ApiResponse,
  type NormalizedLoop,
} from '@talyn/shared';
import { captureWorkspaceEvent } from '../services/analytics.js';
import { handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import { getDbClient } from '../db/client.js';
import { repositories as reposTable } from '../db/schema.js';
import { fleetRefusalReason, workspaceMayUseFleet } from '../services/cloudProviders/fleetAccess.js';
import { getCloudProvider } from '../services/cloudProviders/registry.js';
import { fleetAgentStatus } from '../services/selfHosted/credentials.js';
import { loopsRefusalReason, workspaceMayUseLoops } from '../services/loopsAccess.js';
import { dispatchRun } from '../services/loops/dispatch.js';
import { claimFiring } from '../services/loops/runs.js';
import {
  countLoops,
  createLoop,
  deleteLoop,
  getLoop,
  getLoopRun,
  listLoopRuns,
  listLoops,
  updateLoop,
} from '../services/loops/store.js';

/**
 * Loops — recurring prompts on a cron schedule.
 *
 * Mounted BELOW `ownerScope`: every row here is workspace-scoped, so the RLS
 * policies (migration 0054) are the second line of defence behind
 * `requireWorkspaceAccess`.
 *
 * Every handler gates on the flag, and a refusal is 403 with the reason rather
 * than 404 — somebody who has switched the feature off should be able to tell
 * that from a route that does not exist. Hiding the nav item is not a gate: the
 * CLI, the MCP server and plain `curl` all walk straight past one, and the
 * scheduler has no client at all.
 */

/** How many history rows one page returns when the caller does not say. */
const DEFAULT_RUN_PAGE = 50;
/** Hard ceiling on a page — this endpoint is keyset-paginated, so ask again. */
const MAX_RUN_PAGE = 200;

/**
 * What a loop definition event reports.
 *
 * The SHAPE of the rule, never its content: the schedule preset, the provider,
 * the model. Never the name, never the prompt, never the repository. Those are
 * the user's words about their own code, and product analytics is the wrong
 * place for them — we want to know whether people build loops and what they
 * schedule, and none of that needs the contents.
 */
function loopShape(id: string, loop: NormalizedLoop): Record<string, unknown> {
  return {
    loop_id: id,
    enabled: loop.enabled,
    schedule_kind: presetForCron(loop.cron).kind,
    custom_cron: presetForCron(loop.cron).kind === 'cron',
    timezone: loop.timezone,
    provider: loop.provider,
    model: loop.model,
    concurrency: loop.concurrency,
    prompt_length: loop.prompt.length,
  };
}

export function loopRoutes(): Router {
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
    if (!(await workspaceMayUseLoops(workspaceId))) {
      res.status(403).json({
        success: false,
        error: `Loops are not available: ${loopsRefusalReason()}.`,
        code: 'loops_unavailable',
      });
      return false;
    }
    return true;
  }

  /**
   * The checks the shared validator cannot make, because they need the database.
   *
   * All three are re-checked again at fire time (`services/loops/dispatch.ts`),
   * and that is not redundant: a loop is saved once and fires for months, and
   * every one of these can be taken away in between. Checking here is what
   * stops somebody SAVING a loop that could never have run.
   *
   * Returns an error message, or null when the loop is dispatchable today.
   */
  async function checkTarget(
    workspaceId: string,
    loop: NormalizedLoop
  ): Promise<string | null> {
    const repo = await getDbClient()
      .select({ id: reposTable.id })
      .from(reposTable)
      .where(and(eq(reposTable.id, loop.repositoryId), eq(reposTable.workspaceId, workspaceId)))
      .limit(1);
    if (!repo[0]) return 'That repository is not connected to this workspace.';

    if (!getCloudProvider(loop.provider)) {
      return `${loop.provider} is not available on this deployment.`;
    }

    if (loop.provider === 'selfhosted') {
      if (!(await workspaceMayUseFleet(workspaceId))) {
        return `Talyn Fleet is not available: ${fleetRefusalReason()}.`;
      }
      // The model carries the vendor, so the agent that must be connected is
      // the one the model implies. Saving a Codex loop with no Codex
      // subscription would produce a loop that fails every firing.
      const agent = fleetAgentForModel(loop.model);
      const { connectedAgents } = await fleetAgentStatus(workspaceId);
      if (!connectedAgents.includes(agent)) {
        const label = agent === 'codex' ? 'Codex' : 'Claude';
        return `Talyn Fleet has no ${label} subscription connected to this workspace.`;
      }
    }
    return null;
  }

  router.get('/', async (req, res) => {
    const workspaceId = req.query.workspaceId as string;
    if (!(await gate(req, res, workspaceId))) return;
    const data = await listLoops(workspaceId);
    res.json({ success: true, data } as ApiResponse<typeof data>);
  });

  /**
   * Just the counter, for the sidebar's nav badge.
   *
   * Declared ABOVE `/:id`: Express matches in declaration order, and `/count`
   * would otherwise be read as a loop id and 404.
   */
  router.get('/count', async (req, res) => {
    const workspaceId = req.query.workspaceId as string;
    if (!(await gate(req, res, workspaceId))) return;
    const data = await countLoops(workspaceId);
    res.json({ success: true, data } as ApiResponse<typeof data>);
  });

  router.post('/', async (req, res) => {
    const workspaceId = (req.body as { workspaceId?: string } | undefined)?.workspaceId ?? '';
    if (!(await gate(req, res, workspaceId))) return;
    let normalized: NormalizedLoop;
    try {
      normalized = validateLoop(req.body);
    } catch (err) {
      // The validator's messages are written for a person — pass them through
      // rather than flattening every bad shape to "invalid loop".
      return res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : 'invalid loop',
      });
    }
    const problem = await checkTarget(workspaceId, normalized);
    if (problem) return res.status(400).json({ success: false, error: problem });

    const data = await createLoop(workspaceId, normalized);
    captureWorkspaceEvent(workspaceId, 'loop_created', loopShape(data.id, normalized));
    res.json({ success: true, data } as ApiResponse<typeof data>);
  });

  router.patch('/:id', async (req, res) => {
    const existing = await getLoop(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Loop not found' });
    if (!(await gate(req, res, existing.workspaceId))) return;

    // A whole-loop replace, not a field merge. The provider and the model
    // validate against each other — the two model catalogues overlap — so
    // patching one field alone could land a combination the validator would
    // have refused as a whole.
    let normalized: NormalizedLoop;
    try {
      normalized = validateLoop({ ...existing, ...(req.body as object) });
    } catch (err) {
      return res.status(400).json({
        success: false,
        error: err instanceof Error ? err.message : 'invalid loop',
      });
    }
    const problem = await checkTarget(existing.workspaceId, normalized);
    if (problem) return res.status(400).json({ success: false, error: problem });

    const data = await updateLoop(existing.id, normalized);
    if (!data) return res.status(404).json({ success: false, error: 'Loop not found' });

    captureWorkspaceEvent(existing.workspaceId, 'loop_updated', loopShape(existing.id, normalized));
    // Its own event: switching a loop OFF is the strongest signal that
    // something about it is wrong, and it is invisible inside a generic
    // "updated" that also fires for every rename.
    if (normalized.enabled !== existing.enabled) {
      captureWorkspaceEvent(existing.workspaceId, 'loop_enabled_toggled', {
        ...loopShape(existing.id, normalized),
        previously_enabled: existing.enabled,
      });
    }
    res.json({ success: true, data } as ApiResponse<typeof data>);
  });

  router.delete('/:id', async (req, res) => {
    const existing = await getLoop(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Loop not found' });
    if (!(await gate(req, res, existing.workspaceId))) return;
    await deleteLoop(existing.id);
    captureWorkspaceEvent(existing.workspaceId, 'loop_deleted', {
      loop_id: existing.id,
      schedule_kind: presetForCron(existing.cron).kind,
      provider: existing.provider,
      // How long it lasted. A loop deleted within the hour is a failed attempt;
      // one deleted after a month did its job and stopped being needed.
      age_hours: Math.round((Date.now() - new Date(existing.createdAt).getTime()) / 3_600_000),
    });
    res.json({ success: true, data: null } as ApiResponse<null>);
  });

  /** One loop's run history, newest first. `cursor` is the last row's createdAt. */
  router.get('/:id/runs', async (req, res) => {
    const existing = await getLoop(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Loop not found' });
    if (!(await gate(req, res, existing.workspaceId))) return;
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_RUN_PAGE) : DEFAULT_RUN_PAGE;
    const data = await listLoopRuns(existing.id, {
      limit,
      cursor: (req.query.cursor as string) ?? null,
    });
    res.json({ success: true, data } as ApiResponse<typeof data>);
  });

  /**
   * Run now.
   *
   * The only way to try a loop without waiting for its next occurrence, which
   * for a daily loop is otherwise a day. It goes through the SAME `dispatchRun`
   * the scheduler uses, so a manual run cannot pass where a scheduled one would
   * fail — a test that exercises a different path is not a test.
   *
   * A task-limit refusal surfaces as the run's own `waiting_slot`, not as a 402:
   * the run exists either way, and the history is where the user will look.
   */
  router.post('/:id/run', async (req, res) => {
    const existing = await getLoop(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Loop not found' });
    if (!(await gate(req, res, existing.workspaceId))) return;

    // `scheduledFor` is NOW, and that is what keeps a manual run from colliding
    // with the scheduled occurrence it sits next to: the unique key is
    // (loop_id, scheduled_for), and no cron occurrence lands on this
    // millisecond.
    const scheduledFor = new Date();
    const loop = {
      id: existing.id,
      workspaceId: existing.workspaceId,
      name: existing.name,
      prompt: existing.prompt,
      cron: existing.cron,
      timezone: existing.timezone,
      provider: existing.provider,
      model: existing.model,
      concurrency: existing.concurrency,
      repositoryId: existing.repositoryId,
      repoFullName: existing.repoFullName,
      nextRunAt: existing.nextRunAt ? new Date(existing.nextRunAt) : null,
      consecutiveFailures: 0,
    };
    const claim = await claimFiring(loop, scheduledFor, 'manual');
    await dispatchRun(loop, claim.id, scheduledFor);
    const data = await getLoopRun(claim.id);
    res.json({ success: true, data } as ApiResponse<typeof data>);
  });

  return router;
}

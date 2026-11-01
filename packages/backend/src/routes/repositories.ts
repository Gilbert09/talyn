import { runWithoutScope } from '../db/client.js';
import { putRepositoryBake } from '../services/workbenches/bake.js';
import { userMayUseWorkbenches } from '../services/workbenches/access.js';
import { detectRepoPreview, getPreviewRepository, mergePreview, previewResponse, validatePreviewChoice } from '../services/preview/repoPreview.js';
import {
  detectRepoSandboxSize, getSizeRepository, mergeSandboxSize, sandboxSizeResponse, validateSandboxSizeChoice,
} from '../services/workbenches/sandboxSize.js';
import { Router, type Request, type Response } from 'express';
import { prepareRecordedStep, type PutRepositoryInstructionsInput, type RecordSetupStepInput } from '@talyn/shared';
import {
  getSetupRecipe,
  learningDisabled,
  recordSetupSteps,
  revertSetupStep,
  setSetupLearning,
} from '../services/workbenches/setupRecipe.js';
import { getWorkbench } from '../services/workbenches/store.js';
import { WorkbenchError } from '../services/workbenches/errors.js';
import {
  getRepositoryInstructions,
  listRepositoryInstructions,
  putRepositoryInstructions,
  removeRepositoryInstructions,
} from '../services/workbenches/repositoryInstructions.js';
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
      const watched = await runWithoutScope(() => prMonitorService.addWatchedRepo(workspaceId, owner, repo, url));
      // Refresh the webhook fan-out index so deliveries for this repo match
      // immediately instead of waiting for the next periodic rebuild.
      void refreshWebhookIndex().catch(() => undefined);
      void runWithoutScope(async () => {
        const user = assertUser(req);
        if (!(await userMayUseWorkbenches({ distinctId: user.id, email: user.email }))) return;
        const row = await getPreviewRepository(watched.id);
        if (row) await detectRepoPreview(workspaceId, row);
      }).catch((err) => console.warn('[preview] watch detection failed:', err));
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

  async function previewGate(req: Request, res: Response): Promise<boolean> {
    try { await requireRepositoryAccess(req, req.params.id); }
    catch (err) { handleAccessError(err, res); return false; }
    const user = assertUser(req);
    if (!(await userMayUseWorkbenches({ distinctId: user.id, email: user.email }))) {
      res.status(403).json({ success: false, error: 'Sessions are not available for this account.' });
      return false;
    }
    return true;
  }

  // ---- Instructions written in Talyn for a repository ----

  /** Which of the workspace's repositories have instructions. No text. */
  router.get('/instructions', async (req, res) => {
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
    if (!workspaceId) return res.status(400).json({ success: false, error: 'workspaceId is required' });
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const user = assertUser(req);
    if (!(await userMayUseWorkbenches({ distinctId: user.id, email: user.email }))) {
      return res.status(403).json({ success: false, error: 'Sessions are not available for this account.' });
    }
    res.json({ success: true, data: await listRepositoryInstructions(workspaceId) });
  });

  router.get('/:id/instructions', async (req, res) => {
    if (!(await previewGate(req, res))) return;
    res.json({ success: true, data: await getRepositoryInstructions(req.params.id) });
  });

  router.put('/:id/instructions', async (req, res) => {
    if (!(await previewGate(req, res))) return;
    try {
      const data = await putRepositoryInstructions(req.params.id, req.body as Partial<PutRepositoryInstructionsInput>);
      res.json({ success: true, data });
    } catch (err) {
      if (err instanceof WorkbenchError) {
        return res.status(err.status).json({ success: false, error: err.message, code: err.code });
      }
      throw err;
    }
  });

  router.delete('/:id/instructions', async (req, res) => {
    if (!(await previewGate(req, res))) return;
    if (!(await removeRepositoryInstructions(req.params.id))) {
      return res.status(404).json({ success: false, error: 'This repository has no instructions.' });
    }
    res.json({ success: true, data: null });
  });

  router.get('/:id/preview', async (req, res) => {
    if (!(await previewGate(req, res))) return;
    const row = await getPreviewRepository(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: 'Repository not found.' });
    const detected = await detectRepoPreview(row.workspaceId, row);
    row.settings = { ...row.settings, preview: { ...row.settings?.preview, ...(detected ? { detected } : {}) } };
    res.json({ success: true, data: previewResponse(row) });
  });

  router.patch('/:id/preview', async (req, res) => {
    if (!(await previewGate(req, res))) return;
    let choice;
    try { choice = validatePreviewChoice(req.body); }
    catch (err) { return res.status(400).json({ success: false, error: (err as Error).message }); }
    await mergePreview(req.params.id, choice);
    const row = await getPreviewRepository(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: 'Repository not found.' });
    res.json({ success: true, data: previewResponse(row) });
  });

  router.post('/:id/preview/detect', async (req, res) => {
    if (!(await previewGate(req, res))) return;
    const row = await getPreviewRepository(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: 'Repository not found.' });
    const detected = await detectRepoPreview(row.workspaceId, row, { force: true });
    row.settings = { ...row.settings, preview: { ...row.settings?.preview, ...(detected ? { detected } : {}) } };
    res.json({ success: true, data: previewResponse(row) });
  });

  router.get('/:id/sandbox-size', async (req, res) => {
    if (!(await previewGate(req, res))) return;
    const row = await getSizeRepository(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: 'Repository not found.' });
    const detected = await detectRepoSandboxSize(row.workspaceId, row);
    row.settings = { ...row.settings, ...(detected ? { detectedSandboxSize: detected } : {}) };
    res.json({ success: true, data: sandboxSizeResponse(row) });
  });

  router.patch('/:id/sandbox-size', async (req, res) => {
    if (!(await previewGate(req, res))) return;
    let sandboxSize;
    try { sandboxSize = validateSandboxSizeChoice(req.body); }
    catch (err) { return res.status(400).json({ success: false, error: (err as Error).message }); }
    await mergeSandboxSize(req.params.id, { sandboxSize });
    const row = await getSizeRepository(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: 'Repository not found.' });
    res.json({ success: true, data: sandboxSizeResponse(row) });
  });

  router.get('/:id/bake', async (req, res) => {
    if (!(await previewGate(req, res))) return;
    const row = await getSizeRepository(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: 'Repository not found.' });
    res.json({ success: true, data: row.settings?.bake ?? null });
  });

  router.put('/:id/bake', async (req, res) => {
    if (!(await previewGate(req, res))) return;
    const row = await getSizeRepository(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: 'Repository not found.' });
    try {
      res.json({ success: true, data: await putRepositoryBake(req.params.id, req.body) });
    } catch (err) {
      res.status(400).json({ success: false, error: (err as Error).message });
    }
  });

  // ---- The setup recipe: steps that sessions learned, applied to new boxes and the bake ----

  router.get('/:id/setup-recipe', async (req, res) => {
    if (!(await previewGate(req, res))) return;
    res.json({ success: true, data: await getSetupRecipe(req.params.id) });
  });

  /** Revert one step. It stays listed as reverted, so it is not learned again. */
  router.delete('/:id/setup-recipe/steps/:stepId', async (req, res) => {
    if (!(await previewGate(req, res))) return;
    const step = await revertSetupStep(req.params.id, req.params.stepId);
    if (!step) return res.status(404).json({ success: false, error: 'This repository has no such setup step.' });
    res.json({ success: true, data: await getSetupRecipe(req.params.id) });
  });

  router.post('/:id/setup-recipe/disable', async (req, res) => {
    if (!(await previewGate(req, res))) return;
    await setSetupLearning(req.params.id, true);
    res.json({ success: true, data: await getSetupRecipe(req.params.id) });
  });

  router.post('/:id/setup-recipe/enable', async (req, res) => {
    if (!(await previewGate(req, res))) return;
    await setSetupLearning(req.params.id, false);
    res.json({ success: true, data: await getSetupRecipe(req.params.id) });
  });

  /** An agent's own step (`talyn_record_setup_step`). The same refusals as a learned step. */
  router.post('/:id/setup-recipe/steps', async (req, res) => {
    if (!(await previewGate(req, res))) return;
    const body = (req.body ?? {}) as Partial<RecordSetupStepInput>;
    if (typeof body.command !== 'string' || typeof (body.why ?? '') !== 'string') {
      return res.status(400).json({ success: false, error: 'command must be a string.' });
    }
    let workbenchId: string | null = null;
    if (body.sessionId !== undefined) {
      const session = typeof body.sessionId === 'string' ? await getWorkbench(body.sessionId) : null;
      if (!session || session.repositoryId !== req.params.id) {
        return res.status(400).json({ success: false, error: 'The session is not a session on this repository.', code: 'session_not_on_repository' });
      }
      workbenchId = session.id;
    }
    if (await learningDisabled(req.params.id)) {
      return res.status(409).json({ success: false, error: 'Setup learning is off for this repository.', code: 'setup_learning_disabled' });
    }
    const prepared = prepareRecordedStep(body.command, body.why ?? '');
    if (prepared.refused.length > 0) {
      return res.status(400).json({ success: false, error: prepared.refused[0].reason, code: 'setup_step_refused' });
    }
    const recorded = await recordSetupSteps({
      repositoryId: req.params.id,
      workbenchId,
      source: 'agent',
      candidates: prepared.steps,
    });
    if (recorded.added.length === 0 && recorded.seen.length === 0) {
      return res.status(409).json({ success: false, error: 'The setup recipe is full. A person can revert steps to make room.', code: 'setup_recipe_full' });
    }
    res.json({ success: true, data: { steps: [...recorded.added, ...recorded.seen] } });
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

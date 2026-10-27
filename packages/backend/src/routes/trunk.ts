import { Router, type Request, type Response } from 'express';
import { eq, sql } from 'drizzle-orm';
import type { ApiResponse, MergeEtaAnswer, TrunkIntegrationStatus } from '@talyn/shared';
import { getDbClient } from '../db/client.js';
import { pullRequests as pullRequestsTable } from '../db/schema.js';
import { assertUser, handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import {
  removeTrunkToken,
  storeTrunkToken,
  trunkStatus,
} from '../services/trunk/credentials.js';
import { clearMergeEtaCache, mergeEtaForPr, type MergeEtaPr } from '../services/trunk/mergeEta.js';
import {
  trunkMergeEtaRefusalReason,
  userMayUseTrunkMergeEta,
} from '../services/trunkMergeEtaAccess.js';

/**
 * Trunk merge ETAs, behind the `trunk-merge-eta` flag.
 *
 *   GET    /trunk/status?workspaceId=          is a token set (never the token)
 *   PUT    /trunk/token        { workspaceId, token }
 *   DELETE /trunk/token?workspaceId=
 *   GET    /pull-requests/:id/merge-eta        Trunk's ETA for one PR
 */

/**
 * The PR columns the ETA needs. The landing branch and the labels are read out
 * of `last_summary` in SQL, so the blob itself never ships. The branch mirrors
 * `prLandingBranch`: a stack's base when there is one, else the PR's own base.
 */
const MERGE_ETA_COLUMNS = {
  id: pullRequestsTable.id,
  workspaceId: pullRequestsTable.workspaceId,
  owner: pullRequestsTable.owner,
  repo: pullRequestsTable.repo,
  number: pullRequestsTable.number,
  state: pullRequestsTable.state,
  landingBranch: sql<string | null>`COALESCE(NULLIF(${pullRequestsTable.lastSummary} -> 'stack' ->> 'baseRefName', ''), ${pullRequestsTable.lastSummary} ->> 'baseBranch')`,
  labels: sql<unknown>`${pullRequestsTable.lastSummary} -> 'labels'`,
} as const;

// The token goes into an HTTP header, so it must be visible ASCII with no spaces.
const TOKEN_SHAPE = /^[\x21-\x7e]+$/;

async function refuseUnlessEnabled(req: Request, res: Response): Promise<boolean> {
  const user = assertUser(req);
  if (await userMayUseTrunkMergeEta({ distinctId: user.id, email: user.email })) return false;
  res.status(403).json({
    success: false,
    error: `Trunk merge ETAs are not available: ${trunkMergeEtaRefusalReason()}.`,
    code: 'trunk_merge_eta_unavailable',
  });
  return true;
}

export function trunkRoutes(): Router {
  const router = Router();

  router.get('/status', async (req, res) => {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    if (await refuseUnlessEnabled(req, res)) return;
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    res.json({ success: true, data: await trunkStatus(workspaceId) } as ApiResponse<TrunkIntegrationStatus>);
  });

  router.put('/token', async (req, res) => {
    const { workspaceId, token } = req.body as { workspaceId?: string; token?: unknown };
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    const trimmed = typeof token === 'string' ? token.trim() : '';
    if (!trimmed || !TOKEN_SHAPE.test(trimmed)) {
      return res
        .status(400)
        .json({ success: false, error: 'Paste the Trunk organization API token, with no spaces.' });
    }
    if (await refuseUnlessEnabled(req, res)) return;
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    try {
      await storeTrunkToken(workspaceId, trimmed);
    } catch (err) {
      // Most likely TALYN_TOKEN_KEY is not set. The message never holds the token.
      console.error('[trunk] failed to store the token:', err instanceof Error ? err.message : err);
      return res.status(500).json({ success: false, error: 'Could not store the Trunk token.' });
    }
    clearMergeEtaCache(workspaceId);
    res.json({ success: true, data: await trunkStatus(workspaceId) } as ApiResponse<TrunkIntegrationStatus>);
  });

  router.delete('/token', async (req, res) => {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    if (await refuseUnlessEnabled(req, res)) return;
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    await removeTrunkToken(workspaceId);
    clearMergeEtaCache(workspaceId);
    res.json({ success: true, data: await trunkStatus(workspaceId) } as ApiResponse<TrunkIntegrationStatus>);
  });

  return router;
}

/** Mounted at `/pull-requests`, ahead of the main PR router. */
export function trunkPullRequestRoutes(): Router {
  const router = Router();

  router.get('/:id/merge-eta', async (req, res) => {
    if (await refuseUnlessEnabled(req, res)) return;
    const rows = await getDbClient()
      .select(MERGE_ETA_COLUMNS)
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, req.params.id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return res.status(404).json({ success: false, error: 'Pull request not found' });
    }
    try {
      await requireWorkspaceAccess(req, row.workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const answer = await mergeEtaForPr(row as MergeEtaPr);
    res.json({ success: true, data: answer } as ApiResponse<MergeEtaAnswer>);
  });

  return router;
}

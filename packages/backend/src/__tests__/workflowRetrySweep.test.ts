import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { validateWorkflow } from '@talyn/shared';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  repositories as repositoriesTable,
  workflowRuns as runsTable,
  workspaces as workspacesTable,
} from '../db/schema.js';
import { createWorkflow, _resetWorkflowStore } from '../services/workflows/store.js';
import { claimRun, MAX_RETRY_ATTEMPTS, settleRun } from '../services/workflows/runs.js';
import { workflowRetrySweep } from '../services/workflows/retrySweep.js';
import { githubService } from '../services/github.js';
import { githubRateGate, GitHubRateLimitError } from '../services/githubRateGate.js';

/**
 * The retry sweep.
 *
 * A workflow action that GitHub rate-limited used to settle `failed` and stop
 * there — the delivery consumed, the unique (workflow_id, delivery_id) index
 * making a redelivery a no-op. Four PRs on PostHog/posthog lost their labels in
 * one burst to gates of 128–163s.
 *
 * What is pinned here is the behaviour that makes retrying SAFE rather than just
 * possible: it re-runs only what has not already succeeded, it does not spend an
 * attempt while the gate is still closed, and it gives up honestly rather than
 * owing work forever.
 */

const WORKSPACE = 'ws-1';
const REPO_ID = 'repo-1';

const FACTS = {
  event: 'pr_opened' as const,
  repoFullName: 'acme/widget',
  number: 42,
  title: 'Add a widget',
  url: 'https://github.com/acme/widget/pull/42',
  author: { login: 'alice', isBot: false },
  actor: { login: 'alice', isBot: false },
  baseBranch: 'main',
  defaultBranch: 'main',
  headBranch: 'alice/widget',
  draft: false,
  labels: [],
};

describe('workflow retry sweep', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let addLabels: ReturnType<typeof vi.spyOn>;

  /** Park a run exactly as the engine would when its action was rate-limited. */
  async function parkedRun(
    workflowId: string,
    opts: {
      actions?: Array<{ type: string; ok: boolean; code?: string; detail?: string }>;
      attempts?: number;
      dueInMs?: number;
      deliveryId?: string;
    } = {}
  ) {
    const claim = await claimRun({
      workflowId,
      workspaceId: WORKSPACE,
      repositoryId: REPO_ID,
      facts: FACTS,
      deliveryId: opts.deliveryId ?? `d-${Math.random()}`,
    });
    if (!claim.claimed) throw new Error('could not claim');
    await settleRun(claim.run.id, {
      status: 'pending_retry',
      actions: (opts.actions ?? [
        { type: 'add_labels', ok: false, code: 'rate_gated', error: 'rate limited' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ]) as any,
      attempts: opts.attempts ?? 1,
      retryAfter: new Date(Date.now() + (opts.dueInMs ?? -1_000)),
    });
    return claim.run.id;
  }

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.test' });
    await db
      .insert(workspacesTable)
      .values({ id: WORKSPACE, ownerId: TEST_USER_ID, name: 'T', settings: {} });
    await db.insert(repositoriesTable).values({
      id: REPO_ID,
      workspaceId: WORKSPACE,
      name: 'acme/widget',
      url: 'https://github.com/acme/widget',
      defaultBranch: 'main',
    });
    delete process.env.WORKFLOWS_ENABLED;
    _resetWorkflowStore();
    addLabels = vi.spyOn(githubService, 'addPullRequestLabels').mockResolvedValue(undefined);
    vi.spyOn(githubService, 'accountKeyFor').mockReturnValue('acme');
    // Gate clear by default; individual tests close it.
    vi.spyOn(githubRateGate, 'blockedUntil').mockReturnValue(0);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    _resetWorkflowStore();
    await cleanup();
  });

  async function addWorkflow(actions: unknown[] = [{ type: 'add_labels', labels: ['talyn-seen'] }]) {
    return createWorkflow(
      WORKSPACE,
      validateWorkflow({
        name: 'Label new PRs',
        events: ['pr_opened'],
        actions,
      })
    );
  }

  it('re-runs a parked action once the gate has cleared', async () => {
    const wf = await addWorkflow();
    const runId = await parkedRun(wf.id);

    const retried = await workflowRetrySweep.tick();

    expect(retried).toBe(1);
    expect(addLabels).toHaveBeenCalledWith(WORKSPACE, 'acme', 'widget', 42, ['talyn-seen']);
    const [row] = await db.select().from(runsTable).where(eq(runsTable.id, runId));
    expect(row?.status).toBe('succeeded');
    // The schedule must be cleared, or the sweep picks it up forever.
    expect(row?.retryAfter).toBeNull();
    expect(row?.attempts).toBe(2);
  });

  it('leaves a run alone until it is due', async () => {
    const wf = await addWorkflow();
    await parkedRun(wf.id, { dueInMs: 60_000 });

    expect(await workflowRetrySweep.tick()).toBe(0);
    expect(addLabels).not.toHaveBeenCalled();
  });

  it('does not spend an attempt while the gate is still closed', async () => {
    // The gate can be EXTENDED after a run is parked. Re-running into it would
    // burn an attempt on a call that cannot succeed.
    vi.spyOn(githubRateGate, 'blockedUntil').mockReturnValue(Date.now() + 120_000);
    const wf = await addWorkflow();
    const runId = await parkedRun(wf.id);

    expect(await workflowRetrySweep.tick()).toBe(0);

    expect(addLabels).not.toHaveBeenCalled();
    const [row] = await db.select().from(runsTable).where(eq(runsTable.id, runId));
    expect(row?.status).toBe('pending_retry');
    expect(row?.attempts).toBe(1);
    // Re-parked for the NEW gate, not the old one.
    expect(row?.retryAfter?.getTime()).toBeGreaterThan(Date.now() + 60_000);
  });

  it('re-runs ONLY what has not already succeeded', async () => {
    // A run whose comment posted and whose label was gated must not post the
    // comment twice.
    const comment = vi.spyOn(githubService, 'createIssueComment').mockResolvedValue(undefined);
    const wf = await addWorkflow([
      { type: 'comment', body: 'hello' },
      { type: 'add_labels', labels: ['talyn-seen'] },
    ]);
    const runId = await parkedRun(wf.id, {
      actions: [
        { type: 'comment', ok: true, detail: 'commented' },
        { type: 'add_labels', ok: false, code: 'rate_gated' },
      ],
    });

    await workflowRetrySweep.tick();

    expect(comment).not.toHaveBeenCalled();
    expect(addLabels).toHaveBeenCalledTimes(1);
    const [row] = await db.select().from(runsTable).where(eq(runsTable.id, runId));
    const outcomes = row?.actions as Array<{ type: string; ok: boolean }>;
    // Merged in place: the history renders outcomes against the action list, so a
    // retried action has to land back in its own slot.
    expect(outcomes.map((o) => [o.type, o.ok])).toEqual([
      ['comment', true],
      ['add_labels', true],
    ]);
  });

  it('parks AGAIN when the retry is rate-limited too', async () => {
    // The whole point of a bounded retry: a second gate is another park, not a
    // failure, until the attempt bound runs out.
    addLabels.mockRejectedValue(new GitHubRateLimitError('rate limited', 90_000));
    const wf = await addWorkflow();
    const runId = await parkedRun(wf.id);

    await workflowRetrySweep.tick();

    const [row] = await db.select().from(runsTable).where(eq(runsTable.id, runId));
    expect(row?.status).toBe('pending_retry');
    expect(row?.attempts).toBe(2);
    expect(row?.retryAfter).not.toBeNull();
    expect((row?.actions as Array<{ code?: string }>)[0]?.code).toBe('rate_gated');
  });

  it('gives up after the attempt bound, and says so', async () => {
    const wf = await addWorkflow();
    const runId = await parkedRun(wf.id, { attempts: MAX_RETRY_ATTEMPTS });
    addLabels.mockRejectedValue(new Error('still broken'));

    await workflowRetrySweep.tick();

    const [row] = await db.select().from(runsTable).where(eq(runsTable.id, runId));
    // Out of attempts reads as a failure — the history must not claim a run is
    // still waiting when nothing will pick it up again.
    expect(row?.status).toBe('failed');
    expect(row?.retryAfter).toBeNull();
  });

  it('gives up when the workflow was EDITED out from under it', () => {
    // The reachable version of "the workflow changed while this waited". A
    // deleted workflow cannot strand a parked run — `workflow_runs.workflow_id`
    // is ON DELETE cascade, so the run goes with it — but an EDIT can leave the
    // action at that index a different one, and re-running it would do something
    // the user did not ask for.
    return (async () => {
      const wf = await addWorkflow([{ type: 'add_labels', labels: ['talyn-seen'] }]);
      const runId = await parkedRun(wf.id, {
        actions: [{ type: 'add_labels', ok: false, code: 'rate_gated' }],
      });

      // Same position, different action.
      const { updateWorkflow } = await import('../services/workflows/store.js');
      await updateWorkflow(
        wf.id,
        WORKSPACE,
        validateWorkflow({
          name: wf.name,
          events: ['pr_opened'],
          actions: [{ type: 'comment', body: 'something else entirely' }],
        })
      );

      await workflowRetrySweep.tick();

      expect(addLabels).not.toHaveBeenCalled();
      const [row] = await db.select().from(runsTable).where(eq(runsTable.id, runId));
      expect(row?.status).toBe('failed');
      expect(row?.retryAfter).toBeNull();
      expect((row?.actions as Array<{ error?: string }>)[0]?.error).toMatch(/gave up/);
    })();
  });

  it('does nothing at all when workflows are switched off', async () => {
    const wf = await addWorkflow();
    await parkedRun(wf.id);
    process.env.WORKFLOWS_ENABLED = 'false';

    expect(await workflowRetrySweep.tick()).toBe(0);
    expect(addLabels).not.toHaveBeenCalled();
  });

  it('re-runs a comment with the facts it was going to interpolate', async () => {
    // The webhook payload is long gone by the time a gate clears, so the facts
    // are stored on the run. Without them the retry would post the template with
    // blanks where the branches should be.
    const comment = vi.spyOn(githubService, 'createIssueComment').mockResolvedValue(undefined);
    const wf = await addWorkflow([{ type: 'comment', body: '{{pr.headBranch}} → {{pr.baseBranch}}' }]);
    await parkedRun(wf.id, {
      actions: [{ type: 'comment', ok: false, code: 'rate_gated' }],
    });

    await workflowRetrySweep.tick();

    expect(comment).toHaveBeenCalledWith(
      WORKSPACE,
      'acme',
      'widget',
      42,
      'alice/widget → main'
    );
  });
});

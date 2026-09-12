import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { WorkflowInput } from '@talyn/shared';
import { validateWorkflow } from '@talyn/shared';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  pullRequests as pullRequestsTable,
  repositories as repositoriesTable,
  tasks as tasksTable,
  workflowRuns as runsTable,
  workspaces as workspacesTable,
} from '../db/schema.js';
import { createWorkflow, _resetWorkflowStore, listWorkflows } from '../services/workflows/store.js';
import { evaluateWorkflowsForDelivery, isSelfEcho } from '../services/workflows/engine.js';
import type { WebhookDelivery } from '../services/webhookPayload.js';
import type { WatchTarget } from '../services/webhookIndex.js';
import { githubService } from '../services/github.js';
import { githubRateGate, GitHubRateLimitError } from '../services/githubRateGate.js';
import { prMonitorService } from '../services/prMonitor.js';
import * as prCache from '../services/prCache.js';
import * as prCloudFix from '../services/prCloudFix.js';
import * as taskCreate from '../services/taskCreate.js';
import { TaskLimitError } from '../services/billing/entitlements.js';
import * as analytics from '../services/analytics.js';

/**
 * The engine end to end, against a real Postgres.
 *
 * What is pinned here is the behaviour that cannot be checked any other way:
 * the allow-list gate, the delivery-level idempotency (a redelivery must not
 * post a second comment), the loop guards, and the plan-limit deferral that has
 * no request behind it to 402.
 */

const WORKSPACE = 'ws-1';
const REPO_ID = 'repo-1';

const target: WatchTarget = {
  workspaceId: WORKSPACE,
  repositoryId: REPO_ID,
  owner: 'acme',
  repo: 'widget',
};

function delivery(over: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    deliveryId: 'delivery-1',
    eventType: 'pull_request',
    action: 'opened',
    repoFullName: 'acme/widget',
    enqueuedAtMs: 0,
    payload: {
      pull_request: {
        number: 42,
        title: 'Add a widget',
        html_url: 'https://github.com/acme/widget/pull/42',
        draft: false,
        user: { login: 'alice', type: 'User' },
        base: { ref: 'main' },
        head: { ref: 'alice/widget' },
        labels: [],
      },
      sender: { login: 'alice', type: 'User' },
    },
    ...over,
  };
}

async function addWorkflow(over: Partial<WorkflowInput> = {}) {
  return createWorkflow(
    WORKSPACE,
    validateWorkflow({
      name: 'Label new PRs',
      events: ['pr_opened'],
      actions: [{ type: 'add_labels', labels: ['talyn-seen'] }],
      ...over,
    })
  );
}

describe('workflow engine', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let addLabels: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.test' });
    await db.insert(workspacesTable).values({
      id: WORKSPACE,
      ownerId: TEST_USER_ID,
      name: 'Test',
      settings: {},
    });
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
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.WORKFLOWS_ENABLED;
    _resetWorkflowStore();
    await cleanup();
  });

  it('runs a matching workflow and records the run', async () => {
    const wf = await addWorkflow();
    const ran = await evaluateWorkflowsForDelivery(delivery(), [target]);

    expect(ran).toBe(1);
    expect(addLabels).toHaveBeenCalledWith(WORKSPACE, 'acme', 'widget', 42, ['talyn-seen']);

    const runs = await db.select().from(runsTable).where(eq(runsTable.workflowId, wf.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'succeeded',
      event: 'pr_opened',
      repoFullName: 'acme/widget',
      prNumber: 42,
      prTitle: 'Add a widget',
      prAuthor: 'alice',
      deliveryId: 'delivery-1',
    });
    // The PR is denormalised onto the run, so the history survives a PR Talyn
    // never tracked and a row that is later deleted.
    expect(runs[0]?.pullRequestId).toBeNull();
    expect(runs[0]?.actions).toEqual([
      { type: 'add_labels', ok: true, detail: 'added talyn-seen' },
    ]);
  });

  it('acts on a PR it does not track at all', async () => {
    await addWorkflow();
    const prs = await db.select().from(pullRequestsTable);
    expect(prs).toHaveLength(0);

    await evaluateWorkflowsForDelivery(delivery(), [target]);
    expect(addLabels).toHaveBeenCalledTimes(1);
  });

  it('is a NO-OP on a redelivery of the same event', async () => {
    const wf = await addWorkflow();
    await evaluateWorkflowsForDelivery(delivery(), [target]);
    // GitHub replays the delivery; the unique (workflow_id, delivery_id) index
    // is what stops a second comment / second label call.
    const again = await evaluateWorkflowsForDelivery(delivery(), [target]);

    expect(again).toBe(0);
    expect(addLabels).toHaveBeenCalledTimes(1);
    const runs = await db.select().from(runsTable).where(eq(runsTable.workflowId, wf.id));
    expect(runs).toHaveLength(1);
  });

  it('runs again for a DIFFERENT delivery on the same PR', async () => {
    await addWorkflow({ events: ['pr_opened', 'pr_synchronized'] });
    await evaluateWorkflowsForDelivery(delivery(), [target]);
    await evaluateWorkflowsForDelivery(
      delivery({ deliveryId: 'delivery-2', action: 'synchronize' }),
      [target]
    );
    expect(addLabels).toHaveBeenCalledTimes(2);
  });

  it('does nothing for a disabled workflow', async () => {
    await addWorkflow({ enabled: false });
    expect(await evaluateWorkflowsForDelivery(delivery(), [target])).toBe(0);
    expect(addLabels).not.toHaveBeenCalled();
  });

  it('does nothing when the event does not match', async () => {
    await addWorkflow({ events: ['pr_merged'] });
    expect(await evaluateWorkflowsForDelivery(delivery(), [target])).toBe(0);
    expect(addLabels).not.toHaveBeenCalled();
    expect(await db.select().from(runsTable)).toHaveLength(0);
  });

  it('does nothing when a condition does not match', async () => {
    await addWorkflow({ conditions: { author: { kind: 'bot' } } });
    expect(await evaluateWorkflowsForDelivery(delivery(), [target])).toBe(0);
  });

  describe('the kill switch', () => {
    it('runs for every workspace by default — no allow-list any more', async () => {
      await addWorkflow();
      expect(await evaluateWorkflowsForDelivery(delivery(), [target])).toBe(1);
      expect(addLabels).toHaveBeenCalled();
    });

    it('ignores a stale allow-list left on a deployment', async () => {
      // The env var is gone from the code. A value someone forgot to delete must
      // not resurrect a gate that no longer exists.
      process.env.WORKFLOWS_ALLOWED_EMAILS = 'somebody-else@example.test';
      await addWorkflow();
      expect(await evaluateWorkflowsForDelivery(delivery(), [target])).toBe(1);
      delete process.env.WORKFLOWS_ALLOWED_EMAILS;
    });

    it('stops everything when the switch is pulled', async () => {
      await addWorkflow();
      process.env.WORKFLOWS_ENABLED = 'false';
      expect(await evaluateWorkflowsForDelivery(delivery(), [target])).toBe(0);
      expect(addLabels).not.toHaveBeenCalled();
    });
  });

  describe('loop protection', () => {
    it('skips a delivery that is Talyn hearing its own label back', async () => {
      process.env.GITHUB_APP_SLUG = 'talyn-app';
      await addWorkflow({
        events: ['pr_labeled'],
        actions: [{ type: 'add_labels', labels: ['triaged'] }],
      });
      const echo = delivery({
        action: 'labeled',
        payload: {
          ...delivery().payload,
          label: { name: 'talyn-seen' },
          sender: { login: 'talyn-app[bot]', type: 'Bot' },
        },
      });
      expect(await evaluateWorkflowsForDelivery(echo, [target])).toBe(0);
      expect(addLabels).not.toHaveBeenCalled();
      delete process.env.GITHUB_APP_SLUG;
    });

    it('still fires when a PERSON adds the label', async () => {
      process.env.GITHUB_APP_SLUG = 'talyn-app';
      await addWorkflow({
        events: ['pr_labeled'],
        actions: [{ type: 'add_labels', labels: ['triaged'] }],
      });
      const byHand = delivery({
        action: 'labeled',
        payload: {
          ...delivery().payload,
          label: { name: 'needs-review' },
          sender: { login: 'alice', type: 'User' },
        },
      });
      expect(await evaluateWorkflowsForDelivery(byHand, [target])).toBe(1);
      delete process.env.GITHUB_APP_SLUG;
    });

    it('never suppresses a merge, even though Talyn merges PRs', () => {
      process.env.GITHUB_APP_SLUG = 'talyn-app';
      // "Comment when it merges" is a rule people want, and a merge cannot
      // re-trigger a merge — the PR is closed.
      expect(
        isSelfEcho({
          event: 'pr_merged',
          repoFullName: 'acme/widget',
          number: 1,
          title: '',
          url: '',
          author: { login: 'alice', isBot: false },
          actor: { login: 'talyn-app[bot]', isBot: true },
          baseBranch: 'main',
          headBranch: 'x',
          draft: false,
          labels: [],
        })
      ).toBe(false);
      delete process.env.GITHUB_APP_SLUG;
    });

    it('stands down at the per-PR cap, announcing it exactly once', async () => {
      const wf = await addWorkflow({
        events: ['pr_opened', 'pr_synchronized', 'pr_edited'],
        maxRunsPerPrPerHour: 2,
      });

      for (const [i, action] of ['opened', 'synchronize', 'edited'].entries()) {
        await evaluateWorkflowsForDelivery(
          delivery({ deliveryId: `d-${i}`, action }),
          [target]
        );
      }
      // A fourth attempt, over the cap and already announced.
      await evaluateWorkflowsForDelivery(delivery({ deliveryId: 'd-9', action: 'edited' }), [target]);

      expect(addLabels).toHaveBeenCalledTimes(2);
      const runs = await db.select().from(runsTable).where(eq(runsTable.workflowId, wf.id));
      const skipped = runs.filter((r) => r.status === 'skipped');
      // Exactly ONE refusal recorded, not one per attempt — a storm must not
      // fill the history with identical rows.
      expect(skipped).toHaveLength(1);
      expect((skipped[0]?.actions as Array<{ code?: string }>)[0]?.code).toBe('rate_capped');
      // …and the skip does not count toward the cap that produced it.
      expect(runs.filter((r) => r.status === 'succeeded')).toHaveLength(2);
    });

    it('does not count skipped rows in the stats', async () => {
      const wf = await addWorkflow({ events: ['pr_opened', 'pr_edited'], maxRunsPerPrPerHour: 1 });
      await evaluateWorkflowsForDelivery(delivery({ deliveryId: 'a' }), [target]);
      await evaluateWorkflowsForDelivery(delivery({ deliveryId: 'b', action: 'edited' }), [target]);
      const [listed] = await listWorkflows(WORKSPACE);
      expect(listed?.id).toBe(wf.id);
      expect(listed?.stats.runsTotal).toBe(1);
      expect(listed?.stats.lastStatus).toBe('skipped');
    });
  });

  describe('a run that starts a task', () => {
    beforeEach(async () => {
      // Real rows, because `workflow_runs` links to both behind foreign keys.
      await db.insert(pullRequestsTable).values({
        id: 'pr-row-1',
        workspaceId: WORKSPACE,
        repositoryId: REPO_ID,
        owner: 'acme',
        repo: 'widget',
        number: 42,
        state: 'open',
        lastSummary: {},
      });
      await db.insert(tasksTable).values({
        id: 'task-1',
        workspaceId: WORKSPACE,
        type: 'pr_response',
        title: 'x',
        description: 'x',
        status: 'queued',
      });
      vi.spyOn(prCache, 'getOrFetchPRSummary').mockResolvedValue({
        rowId: 'pr-row-1',
        cacheMiss: false,
        delta: {} as never,
        summary: {
          owner: 'acme',
          repo: 'widget',
          number: 42,
          title: 'Add a widget',
          url: 'https://github.com/acme/widget/pull/42',
          headBranch: 'alice/widget',
          baseBranch: 'main',
        } as never,
      });
      vi.spyOn(prCloudFix, 'activePrTaskId').mockResolvedValue(null);
      vi.spyOn(prCloudFix, 'resolveCloudEnv').mockResolvedValue({
        envId: 'env-1',
        provider: 'selfhosted',
      });
    });

    it('links the task to the workflow and the run, in both directions', async () => {
      const create = vi
        .spyOn(taskCreate, 'createCloudTask')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValue({ id: 'task-1' } as any);
      const wf = await addWorkflow({
        actions: [{ type: 'run_prompt', prompt: 'Review this' }],
      });

      await evaluateWorkflowsForDelivery(delivery(), [target]);

      const [run] = await db.select().from(runsTable).where(eq(runsTable.workflowId, wf.id));
      expect(run?.taskId).toBe('task-1');
      expect(run?.pullRequestId).toBe('pr-row-1');
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'pr_response',
          pullRequestId: 'pr-row-1',
          workflow: { workflowId: wf.id, runId: run?.id, event: 'pr_opened' },
        })
      );
    });

    it('stands down when a run is already working the PR', async () => {
      vi.spyOn(prCloudFix, 'activePrTaskId').mockResolvedValue('task-already');
      const create = vi.spyOn(taskCreate, 'createCloudTask');
      await addWorkflow({ actions: [{ type: 'run_prompt', prompt: 'Review this' }] });

      await evaluateWorkflowsForDelivery(delivery(), [target]);

      expect(create).not.toHaveBeenCalled();
      const [run] = await db.select().from(runsTable);
      expect(run?.status).toBe('failed');
      expect((run?.actions as Array<{ code?: string }>)[0]?.code).toBe('task_already_running');
    });

    it('keeps the outcome when the task it links to has vanished', async () => {
      // A task deleted mid-run (or a PR un-watched, which deletes its row) must
      // not cost the run its record: the outcome is the history, the link is a
      // convenience. One combined UPDATE would fail the FK and leave the run
      // stuck at `running` forever.
      vi.spyOn(taskCreate, 'createCloudTask').mockResolvedValue({
        id: 'task-that-never-existed',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      await addWorkflow({ actions: [{ type: 'run_prompt', prompt: 'Review this' }] });

      await evaluateWorkflowsForDelivery(delivery(), [target]);

      const [run] = await db.select().from(runsTable);
      expect(run?.status).toBe('succeeded');
      expect(run?.taskId).toBeNull();
      expect((run?.actions as Array<{ ok: boolean }>)[0]?.ok).toBe(true);
    });

    it('records the plan cap as a refusal rather than throwing', async () => {
      vi.spyOn(taskCreate, 'createCloudTask').mockRejectedValue(new TaskLimitError(3, 3, 1));
      await addWorkflow({ actions: [{ type: 'run_prompt', prompt: 'Review this' }] });

      await evaluateWorkflowsForDelivery(delivery(), [target]);

      const [run] = await db.select().from(runsTable);
      expect(run?.status).toBe('failed');
      expect(run?.taskId).toBeNull();
      expect((run?.actions as Array<{ code?: string }>)[0]?.code).toBe('task_limit_reached');
    });
  });

  describe('analytics', () => {
    // These events are how anybody finds out whether workflows are used and
    // whether they work. They are emitted server-side because a client that
    // reports nothing must not be able to hide adoption (Session 116), and a
    // test is what stops them being refactored away silently.
    it('reports every run, with its failure codes', async () => {
      const capture = vi.spyOn(analytics, 'captureWorkspaceEvent').mockReturnValue(undefined);
      addLabels.mockRejectedValueOnce(new Error('GitHub API error 403'));
      await addWorkflow();

      await evaluateWorkflowsForDelivery(delivery(), [target]);

      const ran = capture.mock.calls.find(([, event]) => event === 'workflow_ran');
      expect(ran?.[2]).toMatchObject({
        status: 'failed',
        failed_count: 1,
        failure_codes: ['github_error'],
        repo: 'acme/widget',
        pr_number: 42,
      });
    });

    it('emits one flat event per failed action', async () => {
      const capture = vi.spyOn(analytics, 'captureWorkspaceEvent').mockReturnValue(undefined);
      addLabels.mockRejectedValueOnce(new Error('GitHub API error 403'));
      await addWorkflow();

      await evaluateWorkflowsForDelivery(delivery(), [target]);

      const failures = capture.mock.calls.filter(
        ([, event]) => event === 'workflow_action_failed'
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]?.[2]).toMatchObject({
        action_type: 'add_labels',
        code: 'github_error',
        // A GitHub 403 is a breakage, not a decision Talyn made.
        refused: false,
      });
    });

    it('waits out a SHORT gate instead of dropping the action', async () => {
      // `apiRequest` already sleeps any block under MAX_GATE_WAIT_MS. An earlier
      // `gateClosed()` pre-check jumped in front of that and refused the moment
      // the account was gated at all — dropping actions a two-second wait would
      // have completed. The gate is not consulted up front any more.
      vi.spyOn(githubRateGate, 'isBlocked').mockReturnValue(true);
      await addWorkflow();

      await evaluateWorkflowsForDelivery(delivery(), [target]);

      // The label call was still attempted; the gate is the HTTP layer's problem.
      expect(addLabels).toHaveBeenCalled();
      const [run] = await db.select().from(runsTable);
      expect(run?.status).toBe('succeeded');
    });

    it('reports how long GitHub asked for when the gate is too long to wait', async () => {
      addLabels.mockRejectedValueOnce(new GitHubRateLimitError('rate limited', 295_000));
      await addWorkflow();

      await evaluateWorkflowsForDelivery(delivery(), [target]);

      const [run] = await db.select().from(runsTable);
      const outcome = (run?.actions as Array<{ code?: string; error?: string }>)[0];
      expect(outcome?.code).toBe('rate_gated');
      // The number is the point: "another 295s" is actionable where "right now"
      // is not.
      expect(outcome?.error).toMatch(/295s/);
    });

    it('marks a REFUSAL apart from a breakage', async () => {
      // The rate gate, the plan cap and "a run is already working this PR" are
      // the system working. A dashboard that counts them as failures makes a
      // healthy workspace look broken.
      addLabels.mockRejectedValueOnce(new GitHubRateLimitError('rate limited', 295_000));
      const capture = vi.spyOn(analytics, 'captureWorkspaceEvent').mockReturnValue(undefined);
      await addWorkflow();

      await evaluateWorkflowsForDelivery(delivery(), [target]);

      const failure = capture.mock.calls.find(
        ([, event]) => event === 'workflow_action_failed'
      );
      expect(failure?.[2]).toMatchObject({ code: 'rate_gated', refused: true });
    });

    it('says nothing when nothing failed', async () => {
      const capture = vi.spyOn(analytics, 'captureWorkspaceEvent').mockReturnValue(undefined);
      await addWorkflow();
      await evaluateWorkflowsForDelivery(delivery(), [target]);
      expect(
        capture.mock.calls.filter(([, event]) => event === 'workflow_action_failed')
      ).toHaveLength(0);
    });
  });

  describe('several actions', () => {
    it('lands "partial" and keeps going when one action fails', async () => {
      addLabels.mockRejectedValueOnce(new Error('GitHub API error 403'));
      const comment = vi.spyOn(githubService, 'createIssueComment').mockResolvedValue(undefined);
      await addWorkflow({
        actions: [
          { type: 'add_labels', labels: ['talyn-seen'] },
          { type: 'comment', body: 'Thanks {{pr.author}}' },
        ],
      });

      await evaluateWorkflowsForDelivery(delivery(), [target]);

      // The second action still ran — a workflow must not lose its tail to its
      // head's failure.
      expect(comment).toHaveBeenCalledWith(WORKSPACE, 'acme', 'widget', 42, 'Thanks alice');
      const [run] = await db.select().from(runsTable);
      expect(run?.status).toBe('partial');
      const outcomes = run?.actions as Array<{ type: string; ok: boolean }>;
      expect(outcomes.map((o) => [o.type, o.ok])).toEqual([
        ['add_labels', false],
        ['comment', true],
      ]);
    });

    it('lands "failed" when every action fails', async () => {
      addLabels.mockRejectedValue(new Error('GitHub API error 403'));
      await addWorkflow();
      await evaluateWorkflowsForDelivery(delivery(), [target]);
      const [run] = await db.select().from(runsTable);
      expect(run?.status).toBe('failed');
    });
  });

  describe('enrichment', () => {
    it('fills a base branch an issue_comment payload cannot carry', async () => {
      await db.insert(pullRequestsTable).values({
        id: 'pr-row-1',
        workspaceId: WORKSPACE,
        repositoryId: REPO_ID,
        owner: 'acme',
        repo: 'widget',
        number: 42,
        state: 'open',
        lastSummary: { title: 'Add a widget', baseBranch: 'release/2', draft: false, labels: [] },
      });
      await addWorkflow({
        events: ['pr_comment'],
        conditions: { baseBranches: ['release/2'] },
      });

      const commented = delivery({
        eventType: 'issue_comment',
        action: 'created',
        payload: {
          issue: {
            number: 42,
            title: 'Add a widget',
            html_url: 'https://github.com/acme/widget/pull/42',
            user: { login: 'alice', type: 'User' },
            labels: [],
            pull_request: {},
          },
          comment: { body: 'ping', user: { login: 'bob', type: 'User' } },
        },
      });

      expect(await evaluateWorkflowsForDelivery(commented, [target])).toBe(1);
    });

    it('fails the condition when there is no row to enrich from', async () => {
      await addWorkflow({ events: ['pr_comment'], conditions: { baseBranches: ['main'] } });
      const commented = delivery({
        eventType: 'issue_comment',
        action: 'created',
        payload: {
          issue: {
            number: 42,
            user: { login: 'alice', type: 'User' },
            labels: [],
            pull_request: {},
          },
          comment: { body: 'ping', user: { login: 'bob', type: 'User' } },
        },
      });
      expect(await evaluateWorkflowsForDelivery(commented, [target])).toBe(0);
    });
  });

  describe('targetIsViewer', () => {
    it('fires only when the request names the connected user', async () => {
      vi.spyOn(githubService, 'getViewerLogin').mockResolvedValue('tom');
      await addWorkflow({
        events: ['pr_review_requested'],
        conditions: { targetIsViewer: true },
      });

      const forTom = delivery({
        action: 'review_requested',
        payload: { ...delivery().payload, requested_reviewer: { login: 'tom', type: 'User' } },
      });
      const forSomeoneElse = delivery({
        deliveryId: 'd-other',
        action: 'review_requested',
        payload: { ...delivery().payload, requested_reviewer: { login: 'carol', type: 'User' } },
      });

      expect(await evaluateWorkflowsForDelivery(forTom, [target])).toBe(1);
      expect(await evaluateWorkflowsForDelivery(forSomeoneElse, [target])).toBe(0);
    });
  });

  describe('watch_pr', () => {
    it('goes through the watch path, which is what sets `watching`', async () => {
      await db.insert(pullRequestsTable).values({
        id: 'pr-row-1',
        workspaceId: WORKSPACE,
        repositoryId: REPO_ID,
        owner: 'acme',
        repo: 'widget',
        number: 42,
        state: 'open',
        lastSummary: {},
      });
      const watch = vi.spyOn(prMonitorService, 'watchPullRequest').mockResolvedValue({
        ok: true,
        rowId: 'pr-row-1',
        alreadyTracked: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        summary: {} as any,
      });
      await addWorkflow({ actions: [{ type: 'watch_pr' }] });

      await evaluateWorkflowsForDelivery(delivery(), [target]);

      expect(watch).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: WORKSPACE, number: 42 })
      );
      const [run] = await db.select().from(runsTable);
      expect(run?.status).toBe('succeeded');
      expect(run?.pullRequestId).toBe('pr-row-1');
    });

    it('refuses a closed PR rather than reporting success', async () => {
      vi.spyOn(prMonitorService, 'watchPullRequest').mockResolvedValue({
        ok: false,
        reason: 'not_open',
        summary: null,
      });
      await addWorkflow({ actions: [{ type: 'watch_pr' }] });
      await evaluateWorkflowsForDelivery(delivery(), [target]);
      const [run] = await db.select().from(runsTable);
      expect((run?.actions as Array<{ code?: string }>)[0]?.code).toBe('not_open');
    });
  });

  it('runs each workspace watching the repo independently', async () => {
    // Two workspaces watching one repo, each with its own workflow: BOTH run
    // now. This used to assert the second was filtered out by the allow-list.
    await seedUser(db, { id: 'user-2', email: 'other@example.test' });
    await db.insert(workspacesTable).values({
      id: 'ws-2',
      ownerId: 'user-2',
      name: 'Other',
      settings: {},
    });
    await db.insert(repositoriesTable).values({
      id: 'repo-2',
      workspaceId: 'ws-2',
      name: 'acme/widget',
      url: 'https://github.com/acme/widget',
      defaultBranch: 'main',
    });
    await createWorkflow(
      'ws-2',
      validateWorkflow({
        name: 'Theirs',
        events: ['pr_opened'],
        actions: [{ type: 'add_labels', labels: ['theirs'] }],
      })
    );
    await addWorkflow();

    const ran = await evaluateWorkflowsForDelivery(delivery(), [
      target,
      { workspaceId: 'ws-2', repositoryId: 'repo-2', owner: 'acme', repo: 'widget' },
    ]);

    expect(ran).toBe(2);
    expect(addLabels).toHaveBeenCalledTimes(2);
    expect(addLabels).toHaveBeenCalledWith(WORKSPACE, 'acme', 'widget', 42, ['talyn-seen']);
    expect(addLabels).toHaveBeenCalledWith('ws-2', 'acme', 'widget', 42, ['theirs']);
  });

  it('does not let one workspace’s failure stop another’s workflow', async () => {
    await addWorkflow();
    // A target naming a workspace that does not exist: the loop must carry on.
    const ran = await evaluateWorkflowsForDelivery(delivery(), [
      { workspaceId: 'ws-missing', repositoryId: 'repo-missing', owner: 'acme', repo: 'widget' },
      target,
    ]);
    expect(ran).toBe(1);
  });
});

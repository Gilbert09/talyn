import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { SlackEventFacts } from '@talyn/shared';
import { validateWorkflow } from '@talyn/shared';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  repositories as repositoriesTable,
  workflowRuns as runsTable,
  workflows as workflowsTable,
  workspaces as workspacesTable,
} from '../db/schema.js';
import {
  createWorkflow,
  _resetWorkflowStore,
  listWorkflowRuns,
  listWorkflows,
} from '../services/workflows/store.js';
import { evaluateWorkflows, evaluateWorkflowsForDelivery } from '../services/workflows/engine.js';
import { checkRateCap, claimRun, rateCapScope, settleRun } from '../services/workflows/runs.js';
import { workflowRetrySweep } from '../services/workflows/retrySweep.js';
import type { WorkflowSourceAdapter } from '../services/workflows/source.js';
import { workspaceMayUseSlackRules } from '../services/workflowsAccess.js';
import type { WebhookDelivery } from '../services/webhookPayload.js';
import type { WatchTarget } from '../services/webhookIndex.js';
import { githubService } from '../services/github.js';
import { githubRateGate } from '../services/githubRateGate.js';
import * as analytics from '../services/analytics.js';

/**
 * The engine core with more than one source.
 *
 * What is pinned: a GitHub run records its integration and its subject; the
 * rate cap counts per subject, and old runs keyed by the 0130 backfill count
 * the same as new ones; rows written before 0130 read back as GitHub; and the
 * core runs a non-GitHub source through the same claim, cap, settle and
 * analytics without any GitHub call, behind its own flag.
 */

const WORKSPACE = 'ws-1';
const REPO_ID = 'repo-1';

const target: WatchTarget = {
  workspaceId: WORKSPACE,
  repositoryId: REPO_ID,
  owner: 'acme',
  repo: 'widget',
};

function delivery(over: Partial<WebhookDelivery> & { number?: number } = {}): WebhookDelivery {
  const { number = 42, ...rest } = over;
  return {
    deliveryId: 'delivery-1',
    eventType: 'pull_request',
    action: 'opened',
    repoFullName: 'acme/widget',
    enqueuedAtMs: 0,
    payload: {
      pull_request: {
        number,
        title: 'Add a widget',
        html_url: `https://github.com/acme/widget/pull/${number}`,
        draft: false,
        user: { login: 'alice', type: 'User' },
        base: { ref: 'main' },
        head: { ref: 'alice/widget' },
        labels: [],
      },
      sender: { login: 'alice', type: 'User' },
    },
    ...rest,
  };
}

/** A minimal Slack-shaped source, standing in for `sources/slack.ts`. */
interface FakeSlackInput {
  eventId: string;
  facts: SlackEventFacts;
}

const fakeSlackSource: WorkflowSourceAdapter<
  FakeSlackInput,
  { workspaceId: string; repositoryId: null },
  SlackEventFacts
> = {
  integration: 'slack',
  facts: (input) => [input.facts],
  deliveryId: (input) => `slack:${input.eventId}`,
  targets: async () => [{ workspaceId: WORKSPACE, repositoryId: null }],
  workspaceAllowed: workspaceMayUseSlackRules,
  prepare: async (_target, facts) => ({ facts }),
  actionContext: (_target, facts, base) => ({
    ...base,
    integration: 'slack',
    repositoryId: null,
    facts,
  }),
  blockedUntilMs: () => 0,
  describe: (input) => `slack event ${input.eventId}`,
};

function slackMessage(over: Partial<SlackEventFacts> = {}, eventId = 'Ev1'): FakeSlackInput {
  return {
    eventId,
    facts: {
      integration: 'slack',
      event: 'slack_message',
      teamId: 'T1',
      channelId: 'C1',
      channelName: 'eng-bugs',
      userId: 'U1',
      text: 'checkout is broken',
      ts: '1700000000.000100',
      threadTs: null,
      authorLinked: true,
      ...over,
    },
  };
}

async function addGithubRule(over: Record<string, unknown> = {}) {
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

async function addSlackRule(over: Record<string, unknown> = {}) {
  return createWorkflow(
    WORKSPACE,
    validateWorkflow({
      integration: 'slack',
      name: 'Bugs channel',
      events: ['slack_message'],
      conditions: { slackTeamId: 'T1', channels: ['C1', 'C2'] },
      actions: [{ type: 'slack_react', emoji: 'eyes' }],
      ...over,
    })
  );
}

/** The 0130 backfill statement, read from the migration so the test runs the real SQL. */
function backfillStatement(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const file = readFileSync(path.join(dir, '../db/migrations/0130_integration_rules.sql'), 'utf8');
  const statement = file
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim()
    )
    .find((chunk) => chunk.startsWith('UPDATE "workflow_runs"'));
  if (!statement) throw new Error('0130 has no backfill UPDATE');
  return statement;
}

describe('workflow engine — integrations', () => {
  let db: Database;
  let cleanup: () => Promise<void>;
  let addLabels: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    ({ db, cleanup } = await createTestDb());
    await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.test' });
    await db
      .insert(workspacesTable)
      .values({ id: WORKSPACE, ownerId: TEST_USER_ID, name: 'Test', settings: {} });
    await db.insert(repositoriesTable).values({
      id: REPO_ID,
      workspaceId: WORKSPACE,
      name: 'acme/widget',
      url: 'https://github.com/acme/widget',
      defaultBranch: 'main',
    });
    delete process.env.WORKFLOWS_ENABLED;
    delete process.env.SLACK_CHANNEL_RULES_ENABLED;
    _resetWorkflowStore();
    addLabels = vi.spyOn(githubService, 'addPullRequestLabels').mockResolvedValue(undefined);
    vi.spyOn(githubService, 'accountKeyFor').mockReturnValue('acme');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.WORKFLOWS_ENABLED;
    delete process.env.SLACK_CHANNEL_RULES_ENABLED;
    _resetWorkflowStore();
    await cleanup();
  });

  describe('GitHub runs', () => {
    it('record their integration and their subject', async () => {
      const wf = await addGithubRule();
      expect(await evaluateWorkflowsForDelivery(delivery(), [target])).toBe(1);
      const [run] = await db.select().from(runsTable).where(eq(runsTable.workflowId, wf.id));
      expect(run).toMatchObject({
        integration: 'github',
        subjectKey: 'pr:acme/widget#42',
        subjectLabel: 'acme/widget#42',
        repoFullName: 'acme/widget',
        prNumber: 42,
        workbenchId: null,
      });
      const [api] = await listWorkflowRuns(wf.id, { limit: 5 });
      expect(api).toMatchObject({
        integration: 'github',
        subjectKey: 'pr:acme/widget#42',
        subjectLabel: 'acme/widget#42',
        workbenchId: null,
      });
    });

    it.each(['workflow_ran', 'workflow_action_failed'])('tags %s with the integration', async (event) => {
      const capture = vi.spyOn(analytics, 'captureWorkspaceEvent').mockReturnValue(undefined);
      addLabels.mockRejectedValueOnce(new Error('GitHub API error 403'));
      await addGithubRule();
      await evaluateWorkflowsForDelivery(delivery(), [target]);
      const call = capture.mock.calls.find(([, name]) => name === event);
      expect(call?.[2]).toMatchObject({ integration: 'github', repo: 'acme/widget', pr_number: 42 });
    });

    it('never runs a Slack rule on a GitHub delivery', async () => {
      process.env.SLACK_CHANNEL_RULES_ENABLED = 'true';
      const slack = await addSlackRule();
      await addGithubRule();
      expect(await evaluateWorkflowsForDelivery(delivery(), [target])).toBe(1);
      const slackRuns = await db.select().from(runsTable).where(eq(runsTable.workflowId, slack.id));
      expect(slackRuns).toHaveLength(0);
    });
  });

  describe('rows from before 0130', () => {
    it('reads an old rule back as a GitHub rule', async () => {
      // Written without the column, as every row before the migration was.
      await db.execute(sql`
        INSERT INTO workflows (id, workspace_id, name, events, conditions, actions)
        VALUES ('wf-old', ${WORKSPACE}, 'Old rule', '["pr_opened"]'::jsonb, '{}'::jsonb,
                '[{"type":"watch_pr"}]'::jsonb)
      `);
      const [old] = await listWorkflows(WORKSPACE);
      expect(old).toMatchObject({ id: 'wf-old', integration: 'github' });
      expect(await listWorkflows(WORKSPACE, { integration: 'github' })).toHaveLength(1);
      expect(await listWorkflows(WORKSPACE, { integration: 'slack' })).toHaveLength(0);
    });

    it('keys an old run the way the engine keys a new one', async () => {
      const wf = await addGithubRule();
      await db.execute(sql`
        INSERT INTO workflow_runs (id, workflow_id, workspace_id, repo_full_name, pr_number,
                                   event, delivery_id, status)
        VALUES ('run-old', ${wf.id}, ${WORKSPACE}, 'acme/widget', 42, 'pr_opened', 'd-old',
                'succeeded')
      `);
      await db.execute(sql.raw(backfillStatement()));
      const [old] = await db.select().from(runsTable).where(eq(runsTable.id, 'run-old'));
      expect(old).toMatchObject({
        integration: 'github',
        subjectKey: 'pr:acme/widget#42',
        subjectLabel: 'acme/widget#42',
      });

      // …and it is the key a new run on the same PR writes.
      await evaluateWorkflowsForDelivery(delivery({ deliveryId: 'd-new' }), [target]);
      const keys = (await db.select().from(runsTable)).map((r) => r.subjectKey);
      expect(new Set(keys)).toEqual(new Set(['pr:acme/widget#42']));
    });
  });

  describe('the rate cap keys on the subject', () => {
    it.each([
      [42, 'stands down', 0],
      [43, 'runs', 1],
    ])('a backfilled run on #42 → a delivery for #%i %s', async (number, _label, expectedCalls) => {
      const wf = await addGithubRule({ maxRunsPerPrPerHour: 1 });
      await db.execute(sql`
        INSERT INTO workflow_runs (id, workflow_id, workspace_id, repo_full_name, pr_number,
                                   event, delivery_id, status)
        VALUES ('run-old', ${wf.id}, ${WORKSPACE}, 'acme/widget', 42, 'pr_opened', 'd-old',
                'succeeded')
      `);
      await db.execute(sql.raw(backfillStatement()));

      await evaluateWorkflowsForDelivery(delivery({ deliveryId: 'd-new', number }), [target]);
      expect(addLabels).toHaveBeenCalledTimes(expectedCalls);
    });

    it('builds its WHERE on subject_key, which the 0130 index covers', () => {
      const query = db
        .select({ n: sql<number>`count(*)` })
        .from(runsTable)
        .where(rateCapScope({ workflowId: 'w', subjectKey: 'pr:acme/widget#42' }))
        .toSQL();
      expect(query.sql).toContain('"subject_key"');
      expect(query.sql).not.toContain('"repo_full_name"');
      expect(query.sql).not.toContain('"pr_number"');
      expect(query.params).toContain('pr:acme/widget#42');
    });

    it.each([
      ['pr:acme/widget#42', { allowed: false, announce: true }],
      ['pr:acme/widget#43', { allowed: true }],
      ['slack:T1:C1', { allowed: true }],
    ])('checkRateCap(%s) after one run on #42', async (subjectKey, verdict) => {
      const wf = await addGithubRule();
      await evaluateWorkflowsForDelivery(delivery(), [target]);
      expect(await checkRateCap({ workflowId: wf.id, subjectKey, cap: 1 })).toEqual(verdict);
    });
  });

  describe('a non-GitHub source through the same core', () => {
    it('does nothing while the Slack flag is off', async () => {
      await addSlackRule();
      expect(await evaluateWorkflows(fakeSlackSource, slackMessage())).toBe(0);
      expect(await db.select().from(runsTable)).toHaveLength(0);
    });

    it('does nothing when the workflows kill switch is pulled, whatever the Slack flag says', async () => {
      process.env.SLACK_CHANNEL_RULES_ENABLED = 'true';
      process.env.WORKFLOWS_ENABLED = 'false';
      await addSlackRule();
      expect(await evaluateWorkflows(fakeSlackSource, slackMessage())).toBe(0);
    });

    it('claims, acts and settles a Slack run with no PR and no GitHub call', async () => {
      process.env.SLACK_CHANNEL_RULES_ENABLED = 'true';
      const blockedUntil = vi.spyOn(githubRateGate, 'blockedUntil');
      const capture = vi.spyOn(analytics, 'captureWorkspaceEvent').mockReturnValue(undefined);
      const wf = await addSlackRule();

      expect(await evaluateWorkflows(fakeSlackSource, slackMessage())).toBe(1);

      const [run] = await db.select().from(runsTable).where(eq(runsTable.workflowId, wf.id));
      expect(run).toMatchObject({
        integration: 'slack',
        subjectKey: 'slack:T1:C1',
        subjectLabel: '#eng-bugs',
        deliveryId: 'slack:Ev1',
        repoFullName: null,
        prNumber: null,
        prTitle: '',
        event: 'slack_message',
        // No Slack install in this suite, so the reaction fails as Slack's.
        status: 'failed',
      });
      expect((run?.actions as Array<{ code?: string; error?: string }>)[0]).toMatchObject({
        code: 'slack_error',
      });
      expect((run?.facts as SlackEventFacts).channelId).toBe('C1');
      expect(addLabels).not.toHaveBeenCalled();
      expect(blockedUntil).not.toHaveBeenCalled();

      const ran = capture.mock.calls.find(([, name]) => name === 'workflow_ran');
      expect(ran?.[2]).toMatchObject({
        integration: 'slack',
        event: 'slack_message',
        slack_team_id: 'T1',
        slack_channel_id: 'C1',
      });
      // Never the message text: it is a person's words.
      expect(JSON.stringify(ran?.[2])).not.toContain('checkout is broken');

      // The API keeps PR fields a string and a number for old clients.
      const [api] = await listWorkflowRuns(wf.id, { limit: 5 });
      expect(api).toMatchObject({ integration: 'slack', repoFullName: '', prNumber: 0 });
    });

    it.each([
      ['slack_reply', { type: 'slack_reply', text: 'On it' }],
      ['slack_react', { type: 'slack_react', emoji: 'eyes' }],
    ])('records %s with no Slack install as a Slack failure, without throwing', async (_type, action) => {
      process.env.SLACK_CHANNEL_RULES_ENABLED = 'true';
      const wf = await addSlackRule({ actions: [action] });
      await evaluateWorkflows(fakeSlackSource, slackMessage());
      const [run] = await db.select().from(runsTable).where(eq(runsTable.workflowId, wf.id));
      expect(run?.status).toBe('failed');
      expect((run?.actions as Array<{ code?: string }>)[0]?.code).toBe('slack_error');
    });

    it('claims a redelivered Slack event only once', async () => {
      process.env.SLACK_CHANNEL_RULES_ENABLED = 'true';
      await addSlackRule();
      expect(await evaluateWorkflows(fakeSlackSource, slackMessage())).toBe(1);
      expect(await evaluateWorkflows(fakeSlackSource, slackMessage())).toBe(0);
      expect(await db.select().from(runsTable)).toHaveLength(1);
    });

    it.each([
      ['a second message in the same channel', 'C1', 'skipped'],
      ['a message in another watched channel', 'C2', 'failed'],
    ])('caps per channel: %s', async (_label, channelId, status) => {
      process.env.SLACK_CHANNEL_RULES_ENABLED = 'true';
      await addSlackRule({ maxRunsPerPrPerHour: 1 });
      await evaluateWorkflows(fakeSlackSource, slackMessage({}, 'Ev1'));
      await evaluateWorkflows(fakeSlackSource, slackMessage({ channelId, ts: '2' }, 'Ev2'));
      const second = (await db.select().from(runsTable)).find((r) => r.deliveryId === 'slack:Ev2');
      expect(second?.status).toBe(status);
      if (status === 'skipped') {
        expect((second?.actions as Array<{ error?: string }>)[0]?.error).toMatch(/on this channel/);
      }
    });

    it.each([
      ['an unlinked author', { authorLinked: false }],
      ['a thread reply', { threadTs: '1699999999.000001' }],
      ['an unwatched channel', { channelId: 'C9' }],
      ['another Slack team', { teamId: 'T2' }],
    ])('runs nothing for %s', async (_label, over) => {
      process.env.SLACK_CHANNEL_RULES_ENABLED = 'true';
      await addSlackRule();
      expect(await evaluateWorkflows(fakeSlackSource, slackMessage(over))).toBe(0);
    });

    it('never runs a GitHub rule on Slack facts', async () => {
      process.env.SLACK_CHANNEL_RULES_ENABLED = 'true';
      const github = await addGithubRule({ events: ['pr_opened'] });
      await addSlackRule();
      await evaluateWorkflows(fakeSlackSource, slackMessage());
      const runs = await db.select().from(runsTable).where(eq(runsTable.workflowId, github.id));
      expect(runs).toHaveLength(0);
    });
  });

  describe('the retry sweep and Slack runs', () => {
    it('re-runs a parked Slack run from its stored facts, with no GitHub gate', async () => {
      process.env.SLACK_CHANNEL_RULES_ENABLED = 'true';
      const blockedUntil = vi.spyOn(githubRateGate, 'blockedUntil');
      const wf = await addSlackRule();
      const { facts } = slackMessage();
      const claim = await claimRun({
        workflowId: wf.id,
        workspaceId: WORKSPACE,
        repositoryId: null,
        facts,
        deliveryId: 'slack:Ev-parked',
      });
      if (!claim.claimed) throw new Error('could not claim');
      await settleRun(claim.run.id, {
        status: 'pending_retry',
        actions: [{ type: 'slack_react', ok: false, code: 'rate_gated', error: 'slow down' }],
        attempts: 1,
        retryAfter: new Date(Date.now() - 1_000),
      });

      expect(await workflowRetrySweep.tick()).toBe(1);

      const [run] = await db.select().from(runsTable).where(eq(runsTable.id, claim.run.id));
      expect(run?.attempts).toBe(2);
      expect(run?.status).toBe('failed');
      expect((run?.actions as Array<{ code?: string }>)[0]?.code).toBe('slack_error');
      expect(blockedUntil).not.toHaveBeenCalled();
    });

    it('gives up a Slack run whose facts were lost, rather than guessing', async () => {
      const wf = await addSlackRule();
      await db.execute(sql`
        INSERT INTO workflow_runs (id, workflow_id, workspace_id, integration, event, delivery_id,
                                   status, actions, retry_after)
        VALUES ('run-lost', ${wf.id}, ${WORKSPACE}, 'slack', 'slack_message', 'slack:lost',
                'pending_retry',
                '[{"type":"slack_react","ok":false,"code":"rate_gated","error":"slow"}]'::jsonb,
                now() - interval '1 minute')
      `);
      await workflowRetrySweep.tick();
      const [run] = await db.select().from(runsTable).where(eq(runsTable.id, 'run-lost'));
      expect(run?.status).toBe('failed');
      expect(run?.retryAfter).toBeNull();
    });
  });

  it('stores the integration on the rule row', async () => {
    const wf = await addSlackRule();
    const [row] = await db
      .select({ integration: workflowsTable.integration })
      .from(workflowsTable)
      .where(eq(workflowsTable.id, wf.id));
    expect(row?.integration).toBe('slack');
  });
});

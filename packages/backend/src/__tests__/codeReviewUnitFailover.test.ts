import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { CODE_REVIEW_FINDINGS_SENTINEL, type FleetAgent } from '@talyn/shared';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  integrations,
  prCodeReviewEvents,
  prCodeReviewRuns,
  prCodeReviews,
  pullRequests,
  repositories,
  workspaces,
} from '../db/schema.js';

/**
 * A review unit whose vendor refused it.
 *
 * The incident (2026-10-07): a workspace with Claude and Codex both connected
 * ran a review on Codex while its ChatGPT plan was at its usage limit. All
 * three lens units settled `unparseable` ("The agent produced no final
 * message."), the review said "No reviewer finished", and "Review again" sent
 * the same three units to Codex. The vendor's sentence was never read, and the
 * idle Claude subscription was never asked.
 *
 * These run the real poller, executor, store and quota modules against pglite.
 * Only the fleet's HTTP client, GitHub and the vendor quota probe are faked.
 */

const INCIDENT =
  'harness_no_output: the harness produced no agent turn: You have hit your ChatGPT usage ' +
  'limit (prolite plan). Try again in ~7194 min.';
const CLAUDE_RATE_LIMIT = 'rate_limited: rate limited by the anthropic api';
const CLAUDE_SPENT = "You're out of extra usage. Add more at claude.ai/settings/usage";

const { fleet, createSandbox, verifyAgentQuota, scheduleReviewEvaluation, startCodeRun, capture } =
  vi.hoisted(() => ({
    fleet: { getSandbox: vi.fn(), getEvents: vi.fn() },
    createSandbox: vi.fn(),
    verifyAgentQuota: vi.fn(),
    scheduleReviewEvaluation: vi.fn(),
    startCodeRun: vi.fn(),
    capture: vi.fn(),
  }));

vi.mock('../services/selfHosted/client.js', async () => {
  const actual = await vi.importActual<typeof import('../services/selfHosted/client.js')>(
    '../services/selfHosted/client.js'
  );
  return {
    ...actual,
    FleetClient: class {
      createSandbox = createSandbox;
    },
  };
});
vi.mock('../services/selfHosted/credentials.js', async () => {
  const actual = await vi.importActual<typeof import('../services/selfHosted/credentials.js')>(
    '../services/selfHosted/credentials.js'
  );
  return { ...actual, getSelfHostedClient: vi.fn(async () => fleet) };
});
vi.mock('../services/selfHosted/quotaProbe.js', () => ({ verifyAgentQuota }));
vi.mock('../services/github.js', () => ({
  githubService: {
    getVerifiedAccessToken: vi.fn(async () => 'gho_token'),
    getAllPRFiles: vi.fn(async () => [
      { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+x' },
    ]),
  },
}));
vi.mock('../services/codeReview/evaluator.js', () => ({ scheduleReviewEvaluation }));
vi.mock('../services/codeReviewAccess.js', () => ({
  workspaceMayUseCodeReview: vi.fn(async () => true),
}));
vi.mock('../services/prCloudFix.js', () => ({
  resolveCloudEnvChain: vi.fn(async () => [
    { provider: 'selfhosted', envId: 'env-fleet' },
    { provider: 'posthog_code', envId: 'env-ph' },
  ]),
}));
vi.mock('../services/posthogCode/codeRun.js', () => ({ startCodeRun }));
vi.mock('../services/analytics.js', async () => {
  const actual = await vi.importActual<typeof import('../services/analytics.js')>(
    '../services/analytics.js'
  );
  return { ...actual, captureWorkspaceEvent: capture };
});

const { codeReviewPoller } = await import('../services/codeReview/poller.js');
const { dispatchUnit } = await import('../services/codeReview/executor.js');
const { countLiveUnits, getReview, getRun } = await import('../services/codeReview/store.js');
const { heldBackAgents } = await import('../services/selfHosted/exhaustedQuota.js');
const { cycleFailureMessage } = await import('../services/codeReview/failureMessage.js');
const { FleetCapacityError } = await import('../services/selfHosted/client.js');
type RunRow = import('../services/codeReview/store.js').RunRow;

const reconcile = (run: RunRow) =>
  (codeReviewPoller as unknown as { reconcileRun(run: RunRow): Promise<void> }).reconcileRun(run);

const CODEX_MODEL = 'gpt-5.6-sol';
const CLAUDE_MODEL = 'claude-opus-5';
const LENS = { kind: 'lens' as const, lens: 'correctness', chunkIndex: 0 };

let db: Database;
let cleanup: () => Promise<void>;
let encrypted: (v: string) => unknown;
let priorTokenKey: string | undefined;

type Connection = 'connected' | 'reauth' | 'absent';

/** Connect the workspace's fleet agents. Pasted keys resolve with no vendor call. */
async function connect(agents: Partial<Record<FleetAgent, Connection>>): Promise<void> {
  const config: Record<string, unknown> = {};
  if (agents.claude === 'connected') config.anthropicKeyEnc = encrypted('sk-ant-api-test');
  // A sign-in the vendor will not renew, with no pasted key to fall back to.
  if (agents.claude === 'reauth') {
    config.claudeOAuth = { reauthRequiredAt: new Date().toISOString() };
  }
  if (agents.codex === 'connected') config.openaiKeyEnc = encrypted('sk-test-openai');
  if (agents.codex === 'reauth') {
    config.codexOAuth = { reauthRequiredAt: new Date().toISOString() };
  }
  await db.delete(integrations).where(eq(integrations.workspaceId, 'ws1'));
  await db.insert(integrations).values({
    id: 'int1',
    workspaceId: 'ws1',
    type: 'selfhosted',
    enabled: true,
    config,
  });
}

async function hold(agent: FleetAgent): Promise<void> {
  const rows = await db.select().from(integrations).where(eq(integrations.id, 'int1'));
  const config = (rows[0]!.config ?? {}) as Record<string, unknown>;
  await db
    .update(integrations)
    .set({ config: { ...config, quotaExhausted: { [agent]: { at: new Date().toISOString() } } } })
    .where(eq(integrations.id, 'int1'));
}

let seq = 0;
/** A unit with a live sandbox behind it, as the executor leaves one. */
async function runningUnit(over: Partial<typeof prCodeReviewRuns.$inferInsert> = {}): Promise<RunRow> {
  seq += 1;
  const id = `run-${seq}`;
  await db.insert(prCodeReviewRuns).values({
    id,
    reviewId: 'rev1',
    workspaceId: 'ws1',
    cycle: 1,
    kind: 'lens',
    lens: 'correctness',
    chunkIndex: 0,
    status: 'running',
    provider: 'selfhosted',
    model: CODEX_MODEL,
    sandboxId: `sb-${id}`,
    eventCursor: 7,
    dispatchedAt: new Date(),
    ...over,
  });
  return (await getRun(id))!;
}

/** A terminal sandbox. `outcome` is the initial task's, which is what decides. */
function sandboxEnded(outcome: 'completed' | 'failed', error?: string): void {
  fleet.getSandbox.mockResolvedValue({
    sandbox: {
      id: 'sb',
      status: 'stopped',
      tasks: [{ taskId: 't', status: outcome, ...(error ? { error } : {}) }],
    },
  });
  fleet.getEvents.mockResolvedValue({ events: [] });
}

const eventCodes = async () =>
  (await db.select({ code: prCodeReviewEvents.code }).from(prCodeReviewEvents)).map((e) => e.code);

const failoverEvents = () =>
  capture.mock.calls.filter((c) => c[1] === 'code_review_unit_failed_over').map((c) => c[2]);

beforeEach(async () => {
  priorTokenKey = process.env.TALYN_TOKEN_KEY;
  process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
  process.env.FLEET_API_TOKEN = 'fleet-token';
  process.env.FLEET_PINNED_ENDPOINT = 'https://fleet.test';
  ({ db, cleanup } = await createTestDb());
  ({ encryptString: encrypted } = await import('../services/tokenCrypto.js'));
  vi.clearAllMocks();
  createSandbox.mockImplementation(async (input: { id: string }) => ({
    sandbox: { id: input.id, status: 'running' },
    host: 'host-1',
  }));
  verifyAgentQuota.mockResolvedValue('spent');

  await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.com' });
  await db.insert(workspaces).values({
    id: 'ws1',
    ownerId: TEST_USER_ID,
    name: 'ws',
    // The workspace runs Codex by default, and has its own model for each agent.
    settings: {
      fleetModel: CODEX_MODEL,
      fleetModels: { claude: CLAUDE_MODEL, codex: CODEX_MODEL },
    },
  });
  await db.insert(repositories).values({
    id: 'repo1',
    workspaceId: 'ws1',
    name: 'a/b',
    url: 'https://github.com/a/b',
    defaultBranch: 'main',
  });
  await db.insert(pullRequests).values({
    id: 'pr1',
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    owner: 'a',
    repo: 'b',
    number: 1,
    state: 'open',
    lastSummary: { title: 'T', headSha: 'abc1234', headBranch: 'feat', baseBranch: 'main' },
  });
  await db.insert(prCodeReviews).values({
    id: 'rev1',
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    pullRequestId: 'pr1',
    cycle: 1,
    preset: 'standard',
    phase: 'reviewing',
    lensKeys: ['correctness', 'security', 'reliability'],
    runsTotal: 3,
    targetHeadSha: 'abc1234',
  });
  await connect({ claude: 'connected', codex: 'connected' });
});

afterEach(async () => {
  await cleanup();
  if (priorTokenKey === undefined) delete process.env.TALYN_TOKEN_KEY;
  else process.env.TALYN_TOKEN_KEY = priorTokenKey;
  delete process.env.FLEET_API_TOKEN;
  delete process.env.FLEET_PINNED_ENDPOINT;
});

describe('recording why a fleet unit failed', () => {
  it('settles the incident sentence as a usage limit with the detail stored, never unparseable', async () => {
    await connect({ codex: 'connected' });
    const run = await runningUnit();
    sandboxEnded('failed', INCIDENT);

    await reconcile(run);

    const after = (await getRun(run.id))!;
    expect(after.status).toBe('failed');
    expect(after.failureCode).toBe('usage_limit');
    expect(after.failureDetail).toBe(INCIDENT);
    expect(await eventCodes()).toEqual(['usage_limit']);
    expect(scheduleReviewEvaluation).toHaveBeenCalledWith('rev1', 'poller:unit_settled');
  });

  it.each([
    ['an unrelated error', 'guest agent exited with status 137', 'run_failed'],
    ['a harness failure the sandbox names', 'spawn E2BIG', 'prompt_too_large'],
    ['no error at all', undefined, 'run_failed'],
  ])('settles %s with its own code and never moves it', async (_label, error, code) => {
    const run = await runningUnit();
    sandboxEnded('failed', error);

    await reconcile(run);

    const after = (await getRun(run.id))!;
    expect(after.status).toBe('failed');
    expect(after.failureCode).toBe(code);
    expect(after.failureDetail).toBe(error ?? null);
    expect(after.failedOverFrom).toBeNull();
  });

  it('caps the stored detail at 500 characters', async () => {
    const run = await runningUnit();
    sandboxEnded('failed', 'x'.repeat(2000));
    await reconcile(run);
    expect((await getRun(run.id))!.failureDetail).toHaveLength(500);
  });

  it('still calls a run that SUCCEEDED with no final message unparseable', async () => {
    const run = await runningUnit();
    sandboxEnded('completed');

    await reconcile(run);

    const after = (await getRun(run.id))!;
    expect(after.status).toBe('failed');
    expect(after.failureCode).toBe('unparseable');
    expect(after.failureDetail).toBeNull();
  });

  it('keeps findings a run wrote before its sandbox reported a failure', async () => {
    const run = await runningUnit();
    sandboxEnded('failed', 'the sandbox stopped after the task');
    fleet.getEvents.mockResolvedValue({
      events: [
        {
          seq: 1,
          at: new Date().toISOString(),
          event: {
            type: 'assistant',
            message: {
              content: [
                { type: 'text', text: `Reviewed.\n${CODE_REVIEW_FINDINGS_SENTINEL}\n\`\`\`json\n{"findings":[]}\n\`\`\`` },
              ],
            },
          },
        },
      ],
    });

    await reconcile(run);

    expect((await getRun(run.id))!.status).toBe('succeeded');
  });
});

describe('moving a unit to the other fleet agent', () => {
  it('re-dispatches on Claude at the workspace model, exactly once', async () => {
    const run = await runningUnit();
    sandboxEnded('failed', INCIDENT);

    await reconcile(run);

    const requeued = (await getRun(run.id))!;
    expect(requeued).toMatchObject({
      status: 'requeued',
      failedOverFrom: 'codex',
      failureCode: 'usage_limit',
      failureDetail: INCIDENT,
      sandboxId: null,
      eventCursor: 0,
      dispatchedAt: null,
    });
    // A requeued unit gives its slot back, so the second dispatch goes through
    // the workspace ceiling like any other.
    expect(await countLiveUnits('ws1')).toBe(0);
    expect(scheduleReviewEvaluation).toHaveBeenCalledWith('rev1', 'poller:unit_failed_over');
    expect(failoverEvents()).toEqual([
      {
        from_agent: 'codex',
        to_agent: 'claude',
        reason: 'usage_limit',
        kind: 'lens',
        lens: 'correctness',
        cycle: 1,
        at: 'failure',
      },
    ]);
    // A rate limit writes no workspace hold.
    expect(await heldBackAgents('ws1')).toEqual({});

    const review = (await getReview('rev1'))!;
    // Two passes see the requeued unit. Only one may dispatch it.
    await Promise.all([dispatchUnit(review, LENS), dispatchUnit(review, LENS)]);
    await dispatchUnit(review, LENS);

    expect(createSandbox).toHaveBeenCalledTimes(1);
    const body = createSandbox.mock.calls[0]![0] as { id: string; task: { model: string } };
    expect(body.task.model).toBe(CLAUDE_MODEL);
    // Not the first run's id: the create is idempotent on it, and the same id
    // would hand back the sandbox that just died.
    expect(body.id).toBe(`talyn-rev-${run.id}-r1`);
    expect(startCodeRun).not.toHaveBeenCalled();

    const moved = (await getRun(run.id))!;
    expect(moved).toMatchObject({
      status: 'running',
      model: CLAUDE_MODEL,
      sandboxId: `talyn-rev-${run.id}-r1`,
      failedOverFrom: 'codex',
      failureCode: null,
      failureDetail: null,
    });
    expect(await eventCodes()).toEqual(['unit_failed_over']);

    // The second agent is limited too. The unit settles and does not move back.
    sandboxEnded('failed', CLAUDE_RATE_LIMIT);
    await reconcile(moved);

    const settled = (await getRun(run.id))!;
    expect(settled).toMatchObject({
      status: 'failed',
      failureCode: 'usage_limit',
      failureDetail: CLAUDE_RATE_LIMIT,
      failedOverFrom: 'codex',
    });
    expect(failoverEvents()).toHaveLength(1);
    await dispatchUnit(review, LENS);
    expect(createSandbox).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['needs a reconnect', async () => connect({ claude: 'reauth', codex: 'connected' })],
    ['is held for the workspace', async () => hold('claude')],
    ['is not connected', async () => connect({ codex: 'connected' })],
  ])('settles the unit failed when Claude %s', async (_label, arrange) => {
    await arrange();
    const run = await runningUnit();
    sandboxEnded('failed', INCIDENT);

    await reconcile(run);

    expect(await getRun(run.id)).toMatchObject({
      status: 'failed',
      failureCode: 'usage_limit',
      failureDetail: INCIDENT,
      failedOverFrom: null,
    });
    expect(failoverEvents()).toEqual([]);
  });

  it('holds an exhausted agent for the workspace and moves the unit to Codex', async () => {
    const run = await runningUnit({ model: 'claude-sonnet-5' });
    sandboxEnded('failed', CLAUDE_SPENT);

    await reconcile(run);

    expect(verifyAgentQuota).toHaveBeenCalledWith('ws1', 'claude');
    expect(Object.keys(await heldBackAgents('ws1'))).toEqual(['claude']);
    expect(await getRun(run.id)).toMatchObject({
      status: 'requeued',
      failedOverFrom: 'claude',
      failureCode: 'quota_exhausted',
    });
    expect(failoverEvents()[0]).toMatchObject({ to_agent: 'codex', reason: 'quota_exhausted' });

    await dispatchUnit((await getReview('rev1'))!, LENS);
    const body = createSandbox.mock.calls[0]![0] as { task: { model: string } };
    expect(body.task.model).toBe(CODEX_MODEL);
  });

  it('writes no hold and tells nobody to add usage when the vendor serves a probe', async () => {
    verifyAgentQuota.mockResolvedValue('available');
    await connect({ claude: 'connected' });
    const run = await runningUnit({ model: 'claude-sonnet-5' });
    sandboxEnded('failed', CLAUDE_SPENT);

    await reconcile(run);

    expect(await heldBackAgents('ws1')).toEqual({});
    expect((await getRun(run.id))!.failureCode).toBe('usage_limit');
  });

  it('does not ask the vendor about a rate limit', async () => {
    const run = await runningUnit();
    sandboxEnded('failed', INCIDENT);
    await reconcile(run);
    expect(verifyAgentQuota).not.toHaveBeenCalled();
  });

  it('moves OFF Codex when the sentence names no vendor', async () => {
    // The text detector answers "claude" for this sentence. The unit ran a
    // Codex model, so Codex is the agent that is limited.
    const run = await runningUnit();
    sandboxEnded('failed', 'usage limit reached');

    await reconcile(run);

    expect((await getRun(run.id))!.failedOverFrom).toBe('codex');
    await dispatchUnit((await getReview('rev1'))!, LENS);
    const body = createSandbox.mock.calls[0]![0] as { task: { model: string } };
    expect(body.task.model).toBe(CLAUDE_MODEL);
  });

  it('never moves a unit to PostHog Code, even when the fleet is full', async () => {
    const run = await runningUnit();
    sandboxEnded('failed', INCIDENT);
    await reconcile(run);
    createSandbox.mockRejectedValue(new FleetCapacityError('all hosts busy'));

    await dispatchUnit((await getReview('rev1'))!, LENS);

    expect(startCodeRun).not.toHaveBeenCalled();
    expect(await getRun(run.id)).toMatchObject({
      status: 'failed',
      failureCode: 'usage_limit',
      failureDetail: INCIDENT,
      provider: 'selfhosted',
    });
  });

  it('settles a requeued unit when the other agent stopped being eligible', async () => {
    const run = await runningUnit();
    sandboxEnded('failed', INCIDENT);
    await reconcile(run);
    await hold('claude');

    await dispatchUnit((await getReview('rev1'))!, LENS);

    expect(createSandbox).not.toHaveBeenCalled();
    expect(await getRun(run.id)).toMatchObject({ status: 'failed', failureCode: 'usage_limit' });
  });

  it('does not move a unit of a review that is no longer running', async () => {
    await db.update(prCodeReviews).set({ phase: 'cancelled' }).where(eq(prCodeReviews.id, 'rev1'));
    const run = await runningUnit();
    sandboxEnded('failed', INCIDENT);
    await reconcile(run);
    expect((await getRun(run.id))!.status).toBe('failed');
  });
});

describe('not learning a limit once per unit', () => {
  const SECURITY = { kind: 'lens' as const, lens: 'security', chunkIndex: 0 };

  const dispatchedModel = () =>
    (createSandbox.mock.calls[0]![0] as { task: { model: string } }).task.model;

  const securityRun = async () =>
    (
      await db
        .select()
        .from(prCodeReviewRuns)
        .where(eq(prCodeReviewRuns.lens, 'security'))
    )[0]!;

  it('sends the next unit of the cycle to Claude without trying Codex first', async () => {
    await runningUnit({ status: 'failed', failureCode: 'usage_limit', failureDetail: INCIDENT });

    await dispatchUnit((await getReview('rev1'))!, SECURITY);

    expect(createSandbox).toHaveBeenCalledTimes(1);
    expect(dispatchedModel()).toBe(CLAUDE_MODEL);
    expect(await securityRun()).toMatchObject({ status: 'running', failedOverFrom: 'codex' });
    expect(await eventCodes()).toEqual(['unit_failed_over']);
    expect(failoverEvents()).toEqual([
      expect.objectContaining({
        from_agent: 'codex',
        to_agent: 'claude',
        reason: 'usage_limit',
        lens: 'security',
        at: 'dispatch',
      }),
    ]);
  });

  it('counts a unit that already moved as evidence, after it succeeded on Claude', async () => {
    await runningUnit({ status: 'succeeded', model: CLAUDE_MODEL, failedOverFrom: 'codex' });
    await dispatchUnit((await getReview('rev1'))!, SECURITY);
    expect(dispatchedModel()).toBe(CLAUDE_MODEL);
  });

  it('ignores a limit an EARLIER cycle hit', async () => {
    await runningUnit({ cycle: 0, status: 'failed', failureCode: 'usage_limit' });
    await dispatchUnit((await getReview('rev1'))!, SECURITY);
    expect(dispatchedModel()).toBe(CODEX_MODEL);
    expect((await securityRun()).failedOverFrom).toBeNull();
  });

  it('avoids an agent held for the workspace on a fresh cycle', async () => {
    await hold('codex');

    await dispatchUnit((await getReview('rev1'))!, SECURITY);

    expect(dispatchedModel()).toBe(CLAUDE_MODEL);
    expect((await securityRun()).failedOverFrom).toBe('codex');
    expect(failoverEvents()).toEqual([
      expect.objectContaining({ reason: 'quota_exhausted', at: 'dispatch' }),
    ]);
  });

  it.each([
    ['is not connected', async () => connect({ codex: 'connected' })],
    ['needs a reconnect', async () => connect({ claude: 'reauth', codex: 'connected' })],
  ])('dispatches as before when Claude %s', async (_label, arrange) => {
    await arrange();
    await runningUnit({ status: 'failed', failureCode: 'usage_limit', failureDetail: INCIDENT });

    await dispatchUnit((await getReview('rev1'))!, SECURITY);

    expect(dispatchedModel()).toBe(CODEX_MODEL);
    expect((await securityRun()).failedOverFrom).toBeNull();
    expect(failoverEvents()).toEqual([]);
  });

  it('dispatches as before when both agents are limited in this cycle', async () => {
    await runningUnit({ status: 'failed', failureCode: 'usage_limit' });
    await runningUnit({
      lens: 'reliability',
      status: 'failed',
      failureCode: 'usage_limit',
      model: CLAUDE_MODEL,
    });
    await dispatchUnit((await getReview('rev1'))!, SECURITY);
    expect(dispatchedModel()).toBe(CODEX_MODEL);
  });

  it('still spills a first dispatch to the fall-back provider when the fleet is full', async () => {
    // The bounded spill is a rule about capacity, and it is unchanged.
    createSandbox.mockRejectedValue(new FleetCapacityError('all hosts busy'));
    startCodeRun.mockResolvedValue({ ok: true, model: 'm', remoteTaskId: 't', remoteRunId: 'r' });
    await dispatchUnit((await getReview('rev1'))!, SECURITY);
    expect(startCodeRun).toHaveBeenCalledTimes(1);
  });
});

describe('the sandbox dispatch seam, told which agents to avoid', () => {
  const spec = {
    runId: 'talyn-rev-x',
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    taskType: 'code_writing',
    prompt: 'p',
    systemPrompt: 's',
  };
  const model = () => (createSandbox.mock.calls[0]![0] as { task: { model: string } }).task.model;

  it('applies the unit tier to the model of the agent it swaps onto', async () => {
    const { dispatchSandboxRun } = await import('../services/selfHosted/sandboxRun.js');
    const { topFleetModelForModel } = await import('@talyn/shared');

    const result = await dispatchSandboxRun({ ...spec, modelTier: 'top', avoidAgents: ['codex'] });

    // The top tier of the vendor moved ONTO, not the workspace model as stored.
    expect(model()).toBe(topFleetModelForModel(CLAUDE_MODEL));
    expect(result.ok && result.handle.quotaSwap).toEqual({ from: 'codex', to: 'claude' });
  });

  it.each([
    ['the other agent is not connected', async () => connect({ codex: 'connected' }), ['codex']],
    ['the other agent is avoided too', async () => undefined, ['codex', 'claude']],
    ['the avoided agent is not the one the ladder picks', async () => undefined, ['claude']],
  ] as const)('runs where it was going when %s', async (_label, arrange, avoidAgents) => {
    const { dispatchSandboxRun } = await import('../services/selfHosted/sandboxRun.js');
    await arrange();

    const result = await dispatchSandboxRun({ ...spec, avoidAgents: [...avoidAgents] });

    expect(model()).toBe(CODEX_MODEL);
    expect(result.ok && result.handle.quotaSwap).toBeNull();
  });

  it('still refuses a HELD agent as capacity when nothing else can run', async () => {
    const { dispatchSandboxRun } = await import('../services/selfHosted/sandboxRun.js');
    await connect({ codex: 'connected' });
    await hold('codex');

    const result = await dispatchSandboxRun({ ...spec, avoidAgents: ['codex'] });

    expect(result).toMatchObject({ ok: false, capacity: true });
    expect(createSandbox).not.toHaveBeenCalled();
  });
});

describe('what the review says when a usage limit stopped it', () => {
  const settledAt = new Date('2026-10-07T10:00:00Z');
  const now = new Date('2026-10-07T10:02:00Z');

  async function threeFailed(detail: string | null): Promise<void> {
    for (const lens of ['correctness', 'security', 'reliability']) {
      await runningUnit({
        lens,
        status: 'failed',
        failureCode: 'usage_limit',
        failureDetail: detail,
        settledAt,
      });
    }
  }

  it.each([
    [
      'the other agent is not connected',
      { codex: 'connected' } as const,
      INCIDENT,
      'Codex reported a usage limit and no other agent is connected to run the review. ' +
        'Try again in about 5 days, or connect Claude.',
    ],
    [
      'the other agent needs a reconnect',
      { codex: 'connected', claude: 'reauth' } as const,
      INCIDENT,
      'Codex reported a usage limit and Claude needs to be reconnected. ' +
        'Try again in about 5 days, or reconnect Claude in Settings.',
    ],
    [
      'the other agent is connected and could not help',
      { codex: 'connected', claude: 'connected' } as const,
      INCIDENT,
      'Codex reported a usage limit and Claude could not take the review. ' +
        'Try again in about 5 days.',
    ],
    [
      'the vendor named no reset time',
      { codex: 'connected' } as const,
      'usage limit reached',
      'Codex reported a usage limit and no other agent is connected to run the review. ' +
        'Try again later, or connect Claude.',
    ],
  ])('names the agent and the fix when %s', async (_label, agents, detail, expected) => {
    await connect(agents);
    await threeFailed(detail);
    const message = await cycleFailureMessage(
      (await getReview('rev1'))!,
      'usage_limit',
      'fallback',
      now
    );
    expect(message).toBe(expected);
  });

  it('keeps the generic message and adds the reason when a limit stopped most units', async () => {
    await connect({ codex: 'connected' });
    await threeFailed(INCIDENT);
    await db
      .update(prCodeReviewRuns)
      .set({ failureCode: 'timeout', failureDetail: null })
      .where(eq(prCodeReviewRuns.lens, 'reliability'));
    const message = await cycleFailureMessage(
      (await getReview('rev1'))!,
      'no_reviewer_finished',
      'No reviewer finished, so there is nothing to show yet. Try again.',
      now
    );
    expect(message).toBe(
      'No reviewer finished, so there is nothing to show yet. Codex reported a usage limit ' +
        'and no other agent is connected to run the review. Try again in about 5 days, or ' +
        'connect Claude.'
    );
  });

  it.each([
    ['a limit stopped only a minority', 'no_reviewer_finished', 1],
    ['the cycle failed for another reason', 'timeout', 3],
  ])('returns the fallback unchanged when %s', async (_label, code, limited) => {
    await threeFailed(INCIDENT);
    const lenses = ['correctness', 'security', 'reliability'].slice(limited);
    for (const lens of lenses) {
      await db
        .update(prCodeReviewRuns)
        .set({ failureCode: 'run_failed' })
        .where(eq(prCodeReviewRuns.lens, lens));
    }
    expect(await cycleFailureMessage((await getReview('rev1'))!, code, 'fallback', now)).toBe(
      'fallback'
    );
  });
});

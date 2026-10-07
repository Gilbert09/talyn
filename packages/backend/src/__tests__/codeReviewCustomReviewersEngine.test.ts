import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import {
  CODE_REVIEW_FINDINGS_SENTINEL,
  CODE_REVIEW_REVIEWER_SKILL_MAX_BYTES,
  SKILL_MAX_BYTES,
  type CodeReviewSettings,
} from '@talyn/shared';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import type { Database } from '../db/client.js';
import {
  integrations,
  prCodeReviewEvents,
  prCodeReviewFindings,
  prCodeReviews,
  pullRequests,
  repositories,
  skills,
  workspaces,
} from '../db/schema.js';

/**
 * A team's own reviewers, through the real engine.
 *
 * The settings route, the cycle start, the planner, the dispatch and the
 * findings store all run against pglite. Only the fleet's HTTP client and
 * GitHub are faked, and GitHub is faked at the service the skills module calls,
 * so the skills module itself (its cache, and which ref it asks for) is real.
 */

const { createSandbox, scheduleReviewEvaluation, startCodeRun, capture, github } = vi.hoisted(
  () => ({
    createSandbox: vi.fn(),
    scheduleReviewEvaluation: vi.fn(),
    startCodeRun: vi.fn(),
    capture: vi.fn(),
    github: {
      getVerifiedAccessToken: vi.fn(async () => 'gho_token'),
      getPRFiles: vi.fn(),
      getDirectoryListingResolved: vi.fn(),
      getDirectoryListing: vi.fn(),
      getTreeRecursive: vi.fn(),
      getFileContent: vi.fn(),
    },
  })
);

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
vi.mock('../services/selfHosted/quotaProbe.js', () => ({ verifyAgentQuota: vi.fn() }));
vi.mock('../services/github.js', () => ({ githubService: github }));
vi.mock('../services/codeReview/evaluator.js', () => ({ scheduleReviewEvaluation }));
vi.mock('../services/codeReviewAccess.js', () => ({
  workspaceMayUseCodeReview: vi.fn(async () => true),
}));
vi.mock('../services/prCloudFix.js', () => ({
  resolveCloudEnvChain: vi.fn(async () => [{ provider: 'selfhosted', envId: 'env-fleet' }]),
}));
vi.mock('../services/posthogCode/codeRun.js', () => ({ startCodeRun }));
vi.mock('../services/analytics.js', async () => {
  const actual = await vi.importActual<typeof import('../services/analytics.js')>(
    '../services/analytics.js'
  );
  return { ...actual, captureWorkspaceEvent: capture };
});

const { startReviewCycle } = await import('../services/codeReview/cycle.js');
const { dispatchUnit, ingestUnitOutput, prepareCycle } = await import(
  '../services/codeReview/executor.js'
);
const { getReview, getRun, runsForCycle } = await import('../services/codeReview/store.js');
const { decide } = await import('../services/codeReview/decide.js');
const { toPublicReview } = await import('../services/codeReview/public.js');
const { codeReviewCycleShape } = await import('../services/codeReview/analytics.js');
const { lensEffectiveness } = await import('../services/codeReview/findings.js');
const { clearRepoSkillCache } = await import('../services/skills.js');
const { workspaceRoutes } = await import('../routes/workspaces.js');
type ReviewRow = import('../services/codeReview/store.js').ReviewRow;

const REPO_KEY = 'repo:acme/api:house-rules';
const OTHER_REPO_KEY = 'repo:acme/web:ui-rules';
const PLATFORM_KEY = 'platform:skill-1';
const REPO_LENS = `skill:${REPO_KEY}`;
const PLATFORM_LENS = `skill:${PLATFORM_KEY}`;
const HEAD_BRANCH = 'feat/rewrites-the-review-skill';

const REPO_SKILL = '---\nname: house-rules\ndescription: Our rules\n---\nEvery handler writes an audit row.';
const PLATFORM_SKILL = 'Flag any query that is built from a string.';

let db: Database;
let cleanup: () => Promise<void>;
let priorTokenKey: string | undefined;

async function setReviewSettings(codeReview: CodeReviewSettings): Promise<void> {
  await db
    .update(workspaces)
    .set({ settings: { fleetModel: 'claude-opus-5', codeReview } })
    .where(eq(workspaces.id, 'ws1'));
}

/** What the repository's DEFAULT branch holds under `.claude/skills`. */
function repoHasSkill(content: string | null, size = content ? Buffer.byteLength(content) : 0): void {
  github.getDirectoryListingResolved.mockResolvedValue({
    path: '.claude/skills',
    entries: [{ type: 'dir', name: 'house-rules', path: '.claude/skills/house-rules' }],
  });
  github.getTreeRecursive.mockResolvedValue({
    truncated: false,
    entries: [{ path: 'house-rules/SKILL.md', type: 'blob', mode: '100644', sha: `sha-${size}`, size }],
  });
  github.getFileContent.mockResolvedValue(content === null ? null : { content, size });
}

async function start(preset?: 'quick' | 'standard' | 'deep') {
  return startReviewCycle({ pullRequestId: 'pr1', userId: TEST_USER_ID, ...(preset ? { preset } : {}) });
}

/** Start and plan a cycle, as two evaluation passes would. */
async function startAndPlan(preset?: 'quick' | 'standard' | 'deep'): Promise<ReviewRow> {
  const outcome = await start(preset);
  if (!outcome.ok) throw new Error(`start refused: ${outcome.code}`);
  await db.update(prCodeReviews).set({ phase: 'preparing' }).where(eq(prCodeReviews.id, outcome.review.id));
  await prepareCycle((await getReview(outcome.review.id))!);
  return (await getReview(outcome.review.id))!;
}

const lensUnit = (lens: string, chunkIndex = 0) => ({ kind: 'lens' as const, lens, chunkIndex });

const events = async () =>
  db
    .select({ code: prCodeReviewEvents.code, message: prCodeReviewEvents.message })
    .from(prCodeReviewEvents)
    .orderBy(prCodeReviewEvents.id);

const sentPrompt = (call = 0) =>
  (createSandbox.mock.calls[call]![0] as { task: { prompt: string } }).task.prompt;

const answer = (findings: unknown[]) =>
  `Done.\n${CODE_REVIEW_FINDINGS_SENTINEL}\n\`\`\`json\n${JSON.stringify({ schema: 1, findings })}\n\`\`\``;

beforeEach(async () => {
  priorTokenKey = process.env.TALYN_TOKEN_KEY;
  process.env.TALYN_TOKEN_KEY = randomBytes(32).toString('base64');
  process.env.FLEET_API_TOKEN = 'fleet-token';
  process.env.FLEET_PINNED_ENDPOINT = 'https://fleet.test';
  ({ db, cleanup } = await createTestDb());
  const { encryptString } = await import('../services/tokenCrypto.js');
  vi.clearAllMocks();
  clearRepoSkillCache();
  createSandbox.mockImplementation(async (input: { id: string }) => ({
    sandbox: { id: input.id, status: 'running' },
    host: 'host-1',
  }));
  github.getPRFiles.mockResolvedValue([
    { filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+const x = 1;' },
  ]);
  repoHasSkill(REPO_SKILL);

  await seedUser(db, { id: TEST_USER_ID, email: 'tom@example.com' });
  await seedUser(db, { id: 'someone-else' });
  await db.insert(workspaces).values([
    { id: 'ws1', ownerId: TEST_USER_ID, name: 'ws', settings: { fleetModel: 'claude-opus-5' } },
    { id: 'ws2', ownerId: 'someone-else', name: 'other' },
  ]);
  await db.insert(repositories).values([
    { id: 'repo1', workspaceId: 'ws1', name: 'acme/api', url: 'https://github.com/acme/api', defaultBranch: 'main' },
    { id: 'repo2', workspaceId: 'ws1', name: 'acme/web', url: 'https://github.com/acme/web', defaultBranch: 'main' },
    { id: 'repo9', workspaceId: 'ws2', name: 'other/secret', url: 'https://github.com/other/secret', defaultBranch: 'main' },
  ]);
  await db.insert(skills).values([
    { id: 'skill-1', workspaceId: 'ws1', name: 'Security rules', description: '', content: PLATFORM_SKILL },
    { id: 'skill-foreign', workspaceId: 'ws2', name: 'Theirs', description: '', content: 'x' },
  ]);
  await db.insert(pullRequests).values({
    id: 'pr1',
    workspaceId: 'ws1',
    repositoryId: 'repo1',
    owner: 'acme',
    repo: 'api',
    number: 1,
    state: 'open',
    lastSummary: { title: 'T', headSha: 'abc1234', headBranch: HEAD_BRANCH, baseBranch: 'main' },
  });
  await db.insert(integrations).values({
    id: 'int1',
    workspaceId: 'ws1',
    type: 'selfhosted',
    enabled: true,
    config: { anthropicKeyEnc: encryptString('sk-ant-api-test') },
  });
});

afterEach(async () => {
  await cleanup();
  if (priorTokenKey === undefined) delete process.env.TALYN_TOKEN_KEY;
  else process.env.TALYN_TOKEN_KEY = priorTokenKey;
  delete process.env.FLEET_API_TOKEN;
  delete process.env.FLEET_PINNED_ENDPOINT;
});

describe('saving reviewers (PATCH /workspaces/:id)', () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { user: { id: string; email: string } }).user = {
        id: TEST_USER_ID,
        email: 'tom@example.com',
      };
      next();
    });
    app.use('/workspaces', workspaceRoutes());
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function patch(codeReview: unknown) {
    const res = await fetch(`${base}/workspaces/ws1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { codeReview } }),
    });
    return { status: res.status, body: (await res.json()) as { error?: string; data?: { settings?: { codeReview?: CodeReviewSettings } } } };
  }

  const stored = async () =>
    ((await db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, 'ws1')))[0]!
      .settings as { codeReview?: CodeReviewSettings }).codeReview;

  it('round-trips a valid list, with the stored name of a Talyn skill', async () => {
    const res = await patch({
      customReviewers: [
        { skillKey: REPO_KEY, name: 'whatever the client said' },
        { skillKey: PLATFORM_KEY, name: 'a label the client made up' },
      ],
    });
    expect(res.status).toBe(200);
    const expected = [
      { skillKey: REPO_KEY, name: 'house-rules' },
      { skillKey: PLATFORM_KEY, name: 'Security rules' },
    ];
    expect((await stored())?.customReviewers).toEqual(expected);
    expect(res.body.data?.settings?.codeReview?.customReviewers).toEqual(expected);
    // Saving the list does not read the repository.
    expect(github.getFileContent).not.toHaveBeenCalled();
  });

  it('removes duplicates before storing', async () => {
    await patch({
      customReviewers: [
        { skillKey: PLATFORM_KEY, name: 'a' },
        { skillKey: PLATFORM_KEY, name: 'b' },
        { skillKey: REPO_KEY, name: '' },
        { skillKey: 'repo:ACME/Api:house-rules', name: '' },
      ],
    });
    expect((await stored())?.customReviewers?.map((r) => r.skillKey)).toEqual([PLATFORM_KEY, REPO_KEY]);
  });

  it('keeps the other code review settings when it saves reviewers', async () => {
    await patch({ preset: 'deep', autoFix: true });
    await patch({ customReviewers: [{ skillKey: PLATFORM_KEY, name: '' }] });
    await patch({ builtInReviewers: false });
    expect(await stored()).toMatchObject({
      preset: 'deep',
      autoFix: true,
      builtInReviewers: false,
      customReviewers: [{ skillKey: PLATFORM_KEY, name: 'Security rules' }],
    });
  });

  it.each([
    ['a skill on the machine', [{ skillKey: 'local:mine', name: 'mine' }], /on your machine/],
    [
      'a skill of a repository that is not in this workspace',
      [{ skillKey: 'repo:other/secret:rules', name: 'rules' }],
      /other\/secret, which is not a repository of this workspace/,
    ],
    [
      'a Talyn skill of another workspace',
      [{ skillKey: 'platform:skill-foreign', name: 'Theirs' }],
      /is not saved to this workspace/,
    ],
    ['a Talyn skill that does not exist', [{ skillKey: 'platform:nope', name: 'Gone' }], /"Gone" is not saved/],
    ['a key in no format', [{ skillKey: 'house-rules', name: 'x' }], /not a skill Talyn can run/],
    ['something that is not a list', 'house-rules', /has to be a list/],
  ])('refuses %s with a 400 and stores nothing', async (_label, customReviewers, message) => {
    const res = await patch({ customReviewers, preset: 'deep' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    // The whole patch is refused, the valid key with it.
    expect(await stored()).toBeUndefined();
  });

  it('refuses a Talyn skill that is too large to run as a reviewer', async () => {
    await db
      .update(skills)
      .set({ content: 'r'.repeat(CODE_REVIEW_REVIEWER_SKILL_MAX_BYTES + 1) })
      .where(eq(skills.id, 'skill-1'));
    const res = await patch({ customReviewers: [{ skillKey: PLATFORM_KEY, name: '' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('The review skill "Security rules" is too large to run as a reviewer.');
  });

  describe("turning Talyn's reviewers off", () => {
    const problem = "Turn on Talyn's reviewers or add at least one of your own.";

    it('is refused with no reviewer of your own', async () => {
      const res = await patch({ builtInReviewers: false });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(problem);
      expect(await stored()).toBeUndefined();
    });

    it('is refused in one patch that also empties the list', async () => {
      await patch({ customReviewers: [{ skillKey: PLATFORM_KEY, name: '' }] });
      const res = await patch({ builtInReviewers: false, customReviewers: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(problem);
    });

    it('is allowed with a reviewer saved earlier', async () => {
      await patch({ customReviewers: [{ skillKey: PLATFORM_KEY, name: '' }] });
      expect((await patch({ builtInReviewers: false })).status).toBe(200);
      expect((await stored())?.builtInReviewers).toBe(false);
    });

    it('is allowed in one patch that also adds a reviewer', async () => {
      const res = await patch({
        builtInReviewers: false,
        customReviewers: [{ skillKey: REPO_KEY, name: '' }],
      });
      expect(res.status).toBe(200);
    });

    it('then refuses removing the last reviewer, and allows it once they are back on', async () => {
      await patch({ builtInReviewers: false, customReviewers: [{ skillKey: REPO_KEY, name: '' }] });
      const refused = await patch({ customReviewers: [] });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe(problem);
      expect((await stored())?.customReviewers).toHaveLength(1);

      expect((await patch({ builtInReviewers: true, customReviewers: [] })).status).toBe(200);
      expect(await stored()).toMatchObject({ builtInReviewers: true, customReviewers: [] });
    });
  });
});

describe('which reviewers a cycle runs', () => {
  it("runs Talyn's reviewers and the team's own, and freezes both on the row", async () => {
    await setReviewSettings({
      customReviewers: [
        { skillKey: REPO_KEY, name: 'house-rules' },
        { skillKey: PLATFORM_KEY, name: 'Security rules' },
      ],
    });

    const outcome = await start();
    expect(outcome.ok && outcome.started).toBe(true);
    const queued = (await getReview(outcome.ok ? outcome.review.id : ''))!;
    expect(queued.customReviewers).toEqual([
      { lensKey: REPO_LENS, skillKey: REPO_KEY, name: 'house-rules' },
      { lensKey: PLATFORM_LENS, skillKey: PLATFORM_KEY, name: 'Security rules' },
    ]);
    // Nothing but keys and names. The skill text is not on the row.
    expect(JSON.stringify(queued.customReviewers)).not.toContain('audit row');

    const review = await startAndPlanFrom(queued);
    expect(review.lensKeys).toEqual(['correctness', 'security', 'reliability', REPO_LENS, PLATFORM_LENS]);
    // Standard, one chunk: five reviewers, the sweep, the judge.
    expect(review.runsTotal).toBe(7);

    const publicReview = await toPublicReview(review);
    expect(publicReview.runsTotal).toBe(7);
    expect(publicReview.lensesRun).toEqual(review.lensKeys);
    expect(publicReview.customReviewers).toEqual([
      { lensKey: REPO_LENS, name: 'house-rules' },
      { lensKey: PLATFORM_LENS, name: 'Security rules' },
    ]);
  });

  it("runs only the team's own when Talyn's reviewers are off", async () => {
    await setReviewSettings({
      builtInReviewers: false,
      customReviewers: [{ skillKey: PLATFORM_KEY, name: 'Security rules' }],
    });
    const review = await startAndPlan('quick');
    expect(review.lensKeys).toEqual([PLATFORM_LENS]);
    expect(review.runsTotal).toBe(1);

    // The planner asks for exactly that unit.
    const actions = decide({
      phase: 'reviewing',
      cycle: review.cycle,
      preset: 'quick',
      lensKeys: review.lensKeys as string[],
      sweep: review.sweep,
      validate: review.validate,
      chunkTotal: review.chunkTotal,
      runs: [],
      unitsAllowed: 3,
      prOpen: true,
    });
    expect(actions).toEqual([{ type: 'dispatch', unit: lensUnit(PLATFORM_LENS) }]);
  });

  it('skips a repo skill of another repository, without an error', async () => {
    await setReviewSettings({
      customReviewers: [
        { skillKey: OTHER_REPO_KEY, name: 'ui-rules' },
        { skillKey: REPO_KEY, name: 'house-rules' },
      ],
    });
    const review = await startAndPlan();
    expect(review.customReviewers?.map((r) => r.skillKey)).toEqual([REPO_KEY]);
    expect(review.lensKeys).toEqual(['correctness', 'security', 'reliability', REPO_LENS]);
    expect(review.runsTotal).toBe(6);
  });

  it.each([
    [
      'only reviewers of another repository',
      [{ skillKey: OTHER_REPO_KEY, name: 'ui-rules' }],
      /none of your reviewers runs on pull requests in acme\/api/,
    ],
    ['no reviewers at all', [], /you have none of your own/],
  ])('refuses to start with %s and Talyn turned off', async (_label, customReviewers, message) => {
    await setReviewSettings({ builtInReviewers: false, customReviewers });

    const outcome = await start();

    expect(outcome).toMatchObject({ ok: false, code: 'no_reviewers' });
    expect(!outcome.ok && outcome.message).toMatch(message);
    // No row, no cycle, nothing scheduled: there is nothing to fail later.
    expect(await db.select().from(prCodeReviews)).toHaveLength(0);
    expect(scheduleReviewEvaluation).not.toHaveBeenCalled();
  });

  it("drops Talyn's lenses a docs-only change does not need, and still runs the team's own", async () => {
    github.getPRFiles.mockResolvedValue([
      { filename: 'README.md', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+hello' },
    ]);
    await setReviewSettings({ customReviewers: [{ skillKey: PLATFORM_KEY, name: 'Security rules' }] });
    const review = await startAndPlan();
    expect(review.lensKeys).toEqual(['correctness', PLATFORM_LENS]);
    expect(review.runsTotal).toBe(4);
  });

  it('runs a custom reviewer once per chunk on a large pull request', async () => {
    github.getPRFiles.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => ({
        filename: `src/f${i}.ts`,
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1 +1 @@\n+x',
      }))
    );
    await setReviewSettings({
      builtInReviewers: false,
      customReviewers: [{ skillKey: PLATFORM_KEY, name: 'Security rules' }],
    });
    const review = await startAndPlan('deep');
    expect(review.chunkTotal).toBe(2);
    // Per chunk: the reviewer and the sweep. Then one judge.
    expect(review.runsTotal).toBe(5);
  });

  it('does not change a running cycle when the settings change', async () => {
    await setReviewSettings({ customReviewers: [{ skillKey: PLATFORM_KEY, name: 'Security rules' }] });
    const outcome = await start();
    const id = outcome.ok ? outcome.review.id : '';

    // Between the start and the plan: every reviewer is swapped.
    await setReviewSettings({
      builtInReviewers: false,
      customReviewers: [{ skillKey: REPO_KEY, name: 'house-rules' }],
    });
    const review = await startAndPlanFrom((await getReview(id))!);
    expect(review.lensKeys).toEqual(['correctness', 'security', 'reliability', PLATFORM_LENS]);

    // And after the plan: the cycle in flight is handed back as it is.
    const again = await start();
    expect(again).toMatchObject({ ok: true, started: false });
    expect((await getReview(id))!.lensKeys).toEqual(review.lensKeys);

    // The unit dispatched now is the one the cycle froze.
    await dispatchUnit(review, lensUnit(PLATFORM_LENS));
    expect(sentPrompt()).toContain(PLATFORM_SKILL);
  });

  it('plans a cycle that started before reviewers were frozen as the preset', async () => {
    // What an older replica leaves behind: queued, with the last cycle's lens
    // keys and no frozen list.
    await db.insert(prCodeReviews).values({
      id: 'rev-old',
      workspaceId: 'ws1',
      repositoryId: 'repo1',
      pullRequestId: 'pr1',
      cycle: 2,
      preset: 'standard',
      phase: 'preparing',
      lensKeys: ['correctness'],
    });
    await prepareCycle((await getReview('rev-old'))!);
    const review = (await getReview('rev-old'))!;
    expect(review.customReviewers).toBeNull();
    expect(review.lensKeys).toEqual(['correctness', 'security', 'reliability']);
  });

  it('reports the reviewers to analytics as a count and a boolean', async () => {
    await setReviewSettings({
      builtInReviewers: false,
      customReviewers: [
        { skillKey: REPO_KEY, name: 'house-rules' },
        { skillKey: PLATFORM_KEY, name: 'Security rules' },
      ],
    });
    const shape = await codeReviewCycleShape(await startAndPlan('quick'));
    expect(shape).toMatchObject({ lenses: 2, custom_reviewers: 2, builtin_reviewers: false });
    expect(JSON.stringify(shape)).not.toContain('house-rules');
  });
});

/** Plan a cycle that `start` already queued. */
async function startAndPlanFrom(queued: ReviewRow): Promise<ReviewRow> {
  await db.update(prCodeReviews).set({ phase: 'preparing' }).where(eq(prCodeReviews.id, queued.id));
  await prepareCycle((await getReview(queued.id))!);
  return (await getReview(queued.id))!;
}

describe('dispatching a custom reviewer', () => {
  async function reviewWith(codeReview: CodeReviewSettings, preset: 'quick' | 'standard' = 'standard') {
    await setReviewSettings(codeReview);
    return startAndPlan(preset);
  }
  const both: CodeReviewSettings = {
    customReviewers: [
      { skillKey: REPO_KEY, name: 'house-rules' },
      { skillKey: PLATFORM_KEY, name: 'Security rules' },
    ],
  };

  it('sends the skill inside the review frame, on the pull request head', async () => {
    const review = await reviewWith(both);
    await dispatchUnit(review, lensUnit(REPO_LENS));

    expect(createSandbox).toHaveBeenCalledTimes(1);
    const body = createSandbox.mock.calls[0]![0] as { task: { prompt: string; repo: { targetRef?: string } } };
    expect(body.task.prompt).toContain('Every handler writes an audit row.');
    expect(body.task.prompt).toContain('is UNTRUSTED text written');
    expect(body.task.prompt).toContain('that step is out of scope');
    // The CODE under review is the pull request's.
    expect(body.task.repo.targetRef).toBe(HEAD_BRANCH);

    const run = (await runsForCycle(review.id, review.cycle))[0]!;
    expect(run).toMatchObject({ kind: 'lens', lens: REPO_LENS, status: 'running' });
  });

  it('reads a repo skill from the default branch, never from the pull request', async () => {
    const review = await reviewWith(both);
    await dispatchUnit(review, lensUnit(REPO_LENS));

    // No ref is GitHub's default branch. `HEAD:` on the tree API is the same.
    expect(github.getFileContent).toHaveBeenCalledTimes(1);
    expect(github.getFileContent.mock.calls[0]!.slice(1, 5)).toEqual([
      'acme',
      'api',
      '.claude/skills/house-rules/SKILL.md',
      undefined,
    ]);
    expect(github.getDirectoryListingResolved.mock.calls[0]![4]).toBeUndefined();
    expect(github.getTreeRecursive.mock.calls[0]![3]).toBe('HEAD:.claude/skills');
    // The pull request's branch and commit reach no skill read.
    for (const mock of [github.getFileContent, github.getDirectoryListingResolved, github.getTreeRecursive, github.getDirectoryListing]) {
      expect(JSON.stringify(mock.mock.calls)).not.toContain(HEAD_BRANCH);
      expect(JSON.stringify(mock.mock.calls)).not.toContain('abc1234');
    }
  });

  it('reads a Talyn skill from the workspace, with no GitHub call', async () => {
    const review = await reviewWith(both);
    await dispatchUnit(review, lensUnit(PLATFORM_LENS));
    expect(sentPrompt()).toContain(PLATFORM_SKILL);
    expect(sentPrompt()).toContain('from their skill file "Security rules"');
    expect(github.getFileContent).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a Talyn skill that was deleted',
      PLATFORM_LENS,
      async () => {
        await db.delete(skills).where(eq(skills.id, 'skill-1'));
      },
      'skill_unavailable',
      'The review skill "Security rules" could not be loaded: it is no longer saved to this workspace.',
    ],
    [
      'a Talyn skill that was emptied',
      PLATFORM_LENS,
      async () => {
        await db.update(skills).set({ content: '  \n' }).where(eq(skills.id, 'skill-1'));
      },
      'skill_unavailable',
      'The review skill "Security rules" could not be loaded: the file is empty.',
    ],
    [
      'a repo skill that was removed or renamed',
      REPO_LENS,
      async () => {
        github.getTreeRecursive.mockResolvedValue({ truncated: false, entries: [] });
      },
      'skill_unavailable',
      'The review skill "house-rules" could not be loaded: acme/api has no skill with that name on its default branch.',
    ],
    [
      'a repository with no skills directory any more',
      REPO_LENS,
      async () => {
        github.getDirectoryListingResolved.mockResolvedValue(null);
      },
      'skill_unavailable',
      'The review skill "house-rules" could not be loaded: acme/api has no skill with that name on its default branch.',
    ],
    [
      'a GitHub error',
      REPO_LENS,
      async () => {
        github.getDirectoryListingResolved.mockRejectedValue(new Error('rate limited for 40s'));
      },
      'skill_unavailable',
      "The review skill \"house-rules\" could not be loaded: GitHub did not return the repository's skills (rate limited for 40s).",
    ],
    [
      'a repo skill over the size the skills service reads',
      REPO_LENS,
      async () => {
        repoHasSkill(null, SKILL_MAX_BYTES + 1);
      },
      'skill_too_large',
      'The review skill "house-rules" is too large to run as a reviewer.',
    ],
    [
      'a repo skill that loads and is over the reviewer limit',
      REPO_LENS,
      async () => {
        repoHasSkill('r'.repeat(CODE_REVIEW_REVIEWER_SKILL_MAX_BYTES + 1));
      },
      'skill_too_large',
      'The review skill "house-rules" is too large to run as a reviewer.',
    ],
    [
      'a Talyn skill that grew past the reviewer limit',
      PLATFORM_LENS,
      async () => {
        await db
          .update(skills)
          .set({ content: 'r'.repeat(CODE_REVIEW_REVIEWER_SKILL_MAX_BYTES + 1) })
          .where(eq(skills.id, 'skill-1'));
      },
      'skill_too_large',
      'The review skill "Security rules" is too large to run as a reviewer.',
    ],
  ])('fails the unit for %s, and boots nothing', async (_label, lens, arrange, code, message) => {
    const review = await reviewWith(both);
    await arrange();

    await dispatchUnit(review, lensUnit(lens));

    expect(createSandbox).not.toHaveBeenCalled();
    const run = (await runsForCycle(review.id, review.cycle))[0]!;
    // FAILED. Not skipped, and not a success with zero findings.
    expect(run).toMatchObject({ lens, status: 'failed', failureCode: code, findingCount: 0 });
    const last = (await events()).at(-1)!;
    expect(last.code).toBe(code);
    expect(last.message).toBe(message);
  });

  it('carries on with the other reviewers when one skill cannot be loaded', async () => {
    const review = await reviewWith(both);
    await db.delete(skills).where(eq(skills.id, 'skill-1'));

    await Promise.all(
      (review.lensKeys as string[]).map((lens) => dispatchUnit(review, lensUnit(lens)))
    );

    const runs = await runsForCycle(review.id, review.cycle);
    const byLens = Object.fromEntries(runs.map((r) => [r.lens, r.status]));
    expect(byLens).toEqual({
      correctness: 'running',
      security: 'running',
      reliability: 'running',
      [REPO_LENS]: 'running',
      [PLATFORM_LENS]: 'failed',
    });

    // The four that ran settle. The phase moves on with what it has.
    for (const run of runs.filter((r) => r.status === 'running')) {
      await ingestUnitOutput(review, run, answer([]));
    }
    const state = {
      phase: 'reviewing' as const,
      cycle: review.cycle,
      preset: 'standard' as const,
      lensKeys: review.lensKeys as string[],
      sweep: review.sweep,
      validate: review.validate,
      chunkTotal: review.chunkTotal,
      runs: await runsForCycle(review.id, review.cycle),
      unitsAllowed: 3,
      prOpen: true,
    };
    expect(decide(state)).toEqual([{ type: 'phase', to: 'sweeping', code: 'reviewing_done' }]);
  });

  it.each([
    ['skill_unavailable', /None of your review skills could be loaded/],
    ['skill_too_large', /too large to run as reviewers/],
  ] as const)('fails the cycle with its own message when the only reviewer is %s', async (code, message) => {
    const review = await reviewWith(
      { builtInReviewers: false, customReviewers: [{ skillKey: PLATFORM_KEY, name: 'Security rules' }] },
      'quick'
    );
    if (code === 'skill_unavailable') await db.delete(skills).where(eq(skills.id, 'skill-1'));
    else {
      await db
        .update(skills)
        .set({ content: 'r'.repeat(CODE_REVIEW_REVIEWER_SKILL_MAX_BYTES + 1) })
        .where(eq(skills.id, 'skill-1'));
    }
    await dispatchUnit(review, lensUnit(PLATFORM_LENS));

    const actions = decide({
      phase: 'reviewing',
      cycle: review.cycle,
      preset: 'quick',
      lensKeys: review.lensKeys as string[],
      sweep: false,
      validate: false,
      chunkTotal: 1,
      runs: await runsForCycle(review.id, review.cycle),
      unitsAllowed: 3,
      prOpen: true,
    });
    // Never a finish: a reviewer that could not read its instructions has not
    // given the change a clean bill of health.
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'fail', code });
    expect(actions[0]!.type === 'fail' && actions[0]!.message).toMatch(message);
  });

  it('names the reviewers, not their keys, to the second pass', async () => {
    const review = await reviewWith(both);
    await db.update(prCodeReviews).set({ phase: 'sweeping' }).where(eq(prCodeReviews.id, review.id));
    await dispatchUnit((await getReview(review.id))!, { kind: 'sweep', lens: '', chunkIndex: 0 });
    const prompt = sentPrompt();
    expect(prompt).toContain('- Logic\n- Security\n- Reliability\n- house-rules\n- Security rules');
    expect(prompt).not.toContain(REPO_LENS);
  });
});

describe('findings from a custom reviewer', () => {
  const finding = {
    severity: 'major',
    category: 'audit',
    file: 'src/a.ts',
    lineStart: 1,
    lineEnd: 1,
    anchor: 'const x = 1;',
    title: 'Handler writes no audit row',
    body: 'If the request succeeds, nothing records it.',
    suggestion: null,
    confidence: 80,
  };

  async function settledRun(review: ReviewRow, lens: string) {
    await dispatchUnit(review, lensUnit(lens));
    const run = (await runsForCycle(review.id, review.cycle)).find((r) => r.lens === lens)!;
    return (await getRun(run.id))!;
  }

  it('carry its lens key, and merge with a built-in lens that agrees', async () => {
    await setReviewSettings({ customReviewers: [{ skillKey: PLATFORM_KEY, name: 'Security rules' }] });
    const review = await startAndPlan();

    await ingestUnitOutput(review, await settledRun(review, PLATFORM_LENS), answer([finding]));
    let rows = await db.select().from(prCodeReviewFindings);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lenses: [PLATFORM_LENS], seenCount: 1, anchorVerified: true });

    // The same problem, raised by Talyn's own lens with a different severity.
    await ingestUnitOutput(
      review,
      await settledRun(review, 'correctness'),
      answer([{ ...finding, severity: 'blocker', body: 'Another way to say it.' }])
    );
    rows = await db.select().from(prCodeReviewFindings);
    expect(rows).toHaveLength(1);
    expect([...(rows[0]!.lenses as string[])].sort()).toEqual(['correctness', PLATFORM_LENS].sort());
    expect(rows[0]).toMatchObject({ seenCount: 2, severity: 'blocker' });

    // The per-reviewer history counts it under both.
    expect(await lensEffectiveness('ws1')).toEqual([
      { lens: 'correctness', raised: 1, kept: 0 },
      { lens: PLATFORM_LENS, raised: 1, kept: 0 },
    ]);
  });

  it('records an answer with no findings block as a failed unit', async () => {
    await setReviewSettings({ customReviewers: [{ skillKey: PLATFORM_KEY, name: 'Security rules' }] });
    const review = await startAndPlan();
    const run = await settledRun(review, PLATFORM_LENS);

    // A skill written as a task, obeyed: prose and no block.
    const result = await ingestUnitOutput(review, run, 'I posted my review as a comment on the PR.');

    expect(result).toEqual({ parsed: false, findings: 0 });
    expect(await getRun(run.id)).toMatchObject({ status: 'failed', failureCode: 'unparseable' });
  });
});

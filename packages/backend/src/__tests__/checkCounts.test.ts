import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

// The required-ness recheck fires the authoritative by-number refresh
// (prCache.forceFetchAndUpsert); the settle refresh goes through the monitor.
// Mock both so we can assert they are invoked without a real GraphQL fetch.
const { mockForceFetch, mockRefreshAcross, mockTargets, lockCalls } = vi.hoisted(() => ({
  mockForceFetch: vi.fn(),
  mockRefreshAcross: vi.fn(),
  mockTargets: vi.fn(),
  lockCalls: [] as string[],
}));
vi.mock('../services/prCache.js', () => ({ forceFetchAndUpsert: mockForceFetch }));
vi.mock('../services/prMonitor.js', () => ({
  prMonitorService: { refreshPrAcrossWorkspaces: mockRefreshAcross },
}));
vi.mock('../services/webhookIndex.js', () => ({ targetsForRepo: mockTargets }));
vi.mock('../services/advisoryLock.js', () => ({
  withBlockingAdvisoryLock: async (_db: unknown, name: string, fn: () => Promise<unknown>) => {
    lockCalls.push(name);
    return fn();
  },
}));

import {
  checkCountCoalescer,
  ingestCheckRun,
  parseCheckRunPayload,
  parseStatusPayload,
  pruneChecksForSha,
  reseedCheckLedger,
  runSettleRefresh,
  verdictFor,
  _armedSettleRefreshes,
  _flushRequirednessRecheckTrailing,
  _resetRequirednessRecheck,
  type CheckEventInput,
  type LedgerSnapshot,
} from '../services/checkCounts.js';
import { createTestDb, seedUser, TEST_USER_ID } from './helpers/testDb.js';
import * as dbClient from '../db/client.js';
import type { Database } from '../db/client.js';
import {
  workspaces as workspacesTable,
  repositories as repositoriesTable,
  pullRequests as pullRequestsTable,
  prCheckStates,
} from '../db/schema.js';

describe('checkCounts', () => {
  let db: Database;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const t = await createTestDb();
    db = t.db;
    cleanup = t.cleanup;
    mockForceFetch.mockReset();
    mockForceFetch.mockResolvedValue({
      summary: { blockingReason: 'checks_failed', checks: {} },
      delta: null,
      cacheMiss: true,
      rowId: 'pr-7',
    });
    mockRefreshAcross.mockReset();
    mockRefreshAcross.mockResolvedValue(undefined);
    mockTargets.mockReset();
    mockTargets.mockResolvedValue([
      { workspaceId: 'ws1', repositoryId: 'r1', owner: 'acme', repo: 'widget' },
    ]);
    lockCalls.length = 0;
    _resetRequirednessRecheck();
    checkCountCoalescer._reset();
    await seedUser(db, { id: TEST_USER_ID });
    await db.insert(workspacesTable).values({ id: 'ws1', ownerId: TEST_USER_ID, name: 'A', settings: {} });
    await db.insert(repositoriesTable).values({
      id: 'r1',
      workspaceId: 'ws1',
      name: 'acme/widget',
      url: 'https://github.com/acme/widget',
      defaultBranch: 'main',
      createdAt: new Date(),
    });
  });
  afterEach(async () => {
    checkCountCoalescer._reset();
    vi.restoreAllMocks();
    await cleanup();
  });

  const ZERO = { total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 };
  // What every posthog/posthog PR looks like to GitHub: the Trunk ruleset makes
  // it BLOCKED, and a required review is outstanding.
  const POSTHOG_FACTS = {
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED',
    reviewDecision: 'REVIEW_REQUIRED',
  };

  async function seedPr(
    number: number,
    headSha: string,
    summaryExtra: Record<string, unknown> = {},
  ) {
    await db.insert(pullRequestsTable).values({
      id: `pr-${number}`,
      workspaceId: 'ws1',
      repositoryId: 'r1',
      owner: 'acme',
      repo: 'widget',
      number,
      state: 'open',
      lastSummary: { headSha, checks: { ...ZERO }, ...summaryExtra },
    });
  }
  type Summary = {
    checks: Record<string, number>;
    blockingReason?: string;
    ciStatus?: string;
    humanGates?: Array<{ name: string }>;
  };
  async function summaryOf(number: number): Promise<Summary> {
    const rows = await db
      .select({ ls: pullRequestsTable.lastSummary })
      .from(pullRequestsTable)
      .where(eq(pullRequestsTable.id, `pr-${number}`));
    return rows[0].ls as Summary;
  }
  const checksOf = async (number: number) => (await summaryOf(number)).checks;
  const targets = [{ workspaceId: 'ws1', repositoryId: 'r1' }];
  const tracked = (nums: number[]) => new Map([['r1', new Set(nums)]]);
  const at = (minute: number) => new Date(Date.UTC(2026, 5, 16, 10, minute));
  const ev = (over: Partial<CheckEventInput> = {}): CheckEventInput => ({
    repoFullName: 'acme/widget',
    owner: 'acme',
    repo: 'widget',
    headSha: 'sha-A',
    name: 'lint',
    source: 'check_run',
    externalId: '1',
    state: 'success',
    ts: at(0),
    ...over,
  });
  const ingest = (over: Partial<CheckEventInput>, number = 7) =>
    ingestCheckRun(ev(over), targets, [number], tracked([number]));
  const ctx = (
    name: string,
    state: LedgerSnapshot[number]['state'],
    required: boolean | null = true,
    over: Partial<LedgerSnapshot[number]> = {},
  ): LedgerSnapshot[number] => ({ name, state, url: null, required, ts: at(1).getTime(), ...over });
  const reseed = (contexts: LedgerSnapshot, fetchStartedAt = new Date(), headSha = 'sha-A') =>
    reseedCheckLedger({ owner: 'acme', repo: 'widget', headSha, contexts, fetchStartedAt, repositoryId: 'r1' });
  const ledger = async () =>
    db
      .select({
        name: prCheckStates.name,
        state: prCheckStates.state,
        required: prCheckStates.required,
      })
      .from(prCheckStates)
      .where(and(eq(prCheckStates.repoFullName, 'acme/widget'), eq(prCheckStates.headSha, 'sha-A')));

  describe('parseCheckRunPayload', () => {
    it('extracts + normalizes a completed check_run', () => {
      const parsed = parseCheckRunPayload(
        {
          check_run: {
            id: 42,
            name: 'Build',
            status: 'completed',
            conclusion: 'timed_out',
            head_sha: 'abc',
            details_url: 'https://ci/42',
            completed_at: '2026-06-16T10:00:00Z',
          },
          repository: { owner: { login: 'Acme' }, name: 'Widget' },
        },
        'Acme/Widget',
      );
      expect(parsed).toMatchObject({
        repoFullName: 'acme/widget',
        name: 'Build',
        headSha: 'abc',
        state: 'failure',
        rawState: 'TIMED_OUT',
        url: 'https://ci/42',
        externalId: '42',
        ts: new Date('2026-06-16T10:00:00Z'),
      });
    });

    it('returns null without a name or head sha', () => {
      expect(parseCheckRunPayload({ check_run: { status: 'queued' } }, 'a/b')).toBeNull();
    });

    it.each([
      [{ status: 'in_progress' }, 'in_progress'],
      [{ status: 'queued' }, 'pending'],
      [{ status: 'completed', conclusion: 'failure' }, 'failure'],
      [{ status: 'completed', conclusion: 'timed_out' }, 'failure'],
      [{ status: 'completed', conclusion: 'cancelled' }, 'failure'],
      [{ status: 'completed', conclusion: 'action_required' }, 'failure'],
      [{ status: 'completed', conclusion: 'skipped' }, 'skipped'],
      [{ status: 'completed', conclusion: 'success' }, 'success'],
    ])('maps %o → %s', (cr, want) => {
      const parsed = parseCheckRunPayload({ check_run: { name: 'x', head_sha: 's', ...cr } }, 'a/b');
      expect(parsed?.state).toBe(want);
    });

    // A processing-time stamp outranked every real GitHub time, so a queued
    // event with no times beat the completion that followed it and wedged the
    // row `pending`. The epoch loses to any real event instead.
    it('stamps an event with no times at the epoch, never at processing time', () => {
      const parsed = parseCheckRunPayload({ check_run: { name: 'x', head_sha: 's', status: 'queued' } }, 'a/b');
      expect(parsed?.ts.getTime()).toBe(0);
    });
  });

  describe('parseStatusPayload', () => {
    it('reads a Visual Review commit status', () => {
      const parsed = parseStatusPayload(
        {
          id: 9,
          sha: 'sha-A',
          context: 'PostHog Visual Review / storybook',
          state: 'failure',
          target_url: 'https://us.posthog.com/vr/1',
          updated_at: '2026-06-16T10:03:00Z',
          repository: { owner: { login: 'acme' }, name: 'widget' },
        },
        'acme/widget',
      );
      expect(parsed).toMatchObject({
        headSha: 'sha-A',
        name: 'PostHog Visual Review / storybook',
        source: 'status',
        state: 'failure',
        rawState: 'FAILURE',
        url: 'https://us.posthog.com/vr/1',
        ts: new Date('2026-06-16T10:03:00Z'),
      });
    });

    it.each([
      ['pending', 'pending'],
      ['success', 'success'],
      ['error', 'failure'],
    ])('maps state %s → %s', (state, want) => {
      expect(parseStatusPayload({ sha: 's', context: 'c', state }, 'a/b')?.state).toBe(want);
    });

    it.each([[{ context: 'c', state: 'success' }], [{ sha: 's', state: 'success' }], [{ sha: 's', context: 'c' }]])(
      'returns null when a field is missing (%o)',
      (payload) => {
        expect(parseStatusPayload(payload, 'a/b')).toBeNull();
      },
    );
  });

  describe('ingestCheckRun', () => {
    it('builds counts from check events for a tracked PR on the head commit', async () => {
      await seedPr(7, 'sha-A');
      expect(await ingest({ name: 'lint', state: 'success' })).toBe(1);
      expect(await checksOf(7)).toEqual({ total: 1, passed: 1, failed: 0, inProgress: 0, skipped: 0 });
      await ingest({ name: 'test', state: 'success' });
      await ingest({ name: 'e2e', state: 'in_progress' });
      expect(await checksOf(7)).toEqual({ total: 3, passed: 2, failed: 0, inProgress: 1, skipped: 0 });
    });

    it('dedupes a re-run by name (latest state wins, total unchanged)', async () => {
      await seedPr(7, 'sha-A');
      await ingest({ name: 'lint', state: 'success', ts: at(0) });
      await ingest({ name: 'lint', state: 'failure', ts: at(5) });
      expect(await checksOf(7)).toEqual({ total: 1, passed: 0, failed: 1, inProgress: 0, skipped: 0 });
      expect(await db.select().from(prCheckStates)).toHaveLength(1);
    });

    it('ignores an out-of-order older event (does not regress a check)', async () => {
      await seedPr(7, 'sha-A');
      await ingest({ name: 'lint', state: 'failure', ts: at(5) });
      await ingest({ name: 'lint', state: 'pending', ts: at(0) });
      expect(await checksOf(7)).toEqual({ total: 1, passed: 0, failed: 1, inProgress: 0, skipped: 0 });
    });

    it('does not count — or store — checks on a superseded commit', async () => {
      await seedPr(7, 'sha-A');
      expect(await ingest({ headSha: 'sha-OLD' })).toBe(0);
      expect(await checksOf(7)).toEqual(ZERO);
      expect(await db.select().from(prCheckStates)).toHaveLength(0);
    });

    it('ignores — and does not store — a check for an untracked PR', async () => {
      expect(await ingestCheckRun(ev(), targets, [8], tracked([]))).toBe(0);
      expect(await db.select().from(prCheckStates)).toHaveLength(0);
    });

    it('counts a CANCELLED check as failing, not as an uncounted extra (posthog#84477)', async () => {
      await seedPr(7, 'sha-A');
      await ingest({ name: 'a', state: 'success' });
      const cancelled = parseCheckRunPayload(
        {
          check_run: { id: 9, name: 'shellcheck', status: 'completed', conclusion: 'cancelled', head_sha: 'sha-A' },
          repository: { owner: { login: 'acme' }, name: 'widget' },
        },
        'acme/widget',
      );
      await ingestCheckRun(cancelled!, targets, [7], tracked([7]));
      const counts = await checksOf(7);
      expect(counts).toEqual({ total: 2, passed: 1, failed: 1, inProgress: 0, skipped: 0 });
      expect(counts.passed + counts.failed + counts.inProgress + counts.skipped).toBe(counts.total);
    });

    it('takes the commit lock around every ledger write + recompute', async () => {
      vi.spyOn(dbClient, 'isRealPostgres').mockReturnValue(true);
      await seedPr(7, 'sha-A');
      await ingest({ name: 'lint' });
      await reseed([ctx('lint', 'success')]);
      expect(lockCalls).toEqual(['checks:acme/widget:sha-A', 'checks:acme/widget:sha-A']);
    });
  });

  // The recompute re-derives the WHOLE verdict from the ledger plus the facts on
  // the row. It used to patch `checks` and keep whatever verdict it found, which
  // is how a held `'blocked'` survived a required check going red.
  describe('verdict re-derivation', () => {
    it('turns a held "blocked" red when the required Semgrep gate fails after its optional job', async () => {
      await seedPr(7, 'sha-A', { ...POSTHOG_FACTS, blockingReason: 'blocked' });
      await reseed([
        ctx('semgrep-devex', 'in_progress', false),
        ctx('Semgrep Checks Pass', 'pending', true),
        ctx('shellcheck', 'success', true),
      ]);
      expect((await summaryOf(7)).ciStatus).toBe('running');

      await ingest({ name: 'semgrep-devex', state: 'failure', rawState: 'TIMED_OUT', ts: at(20) });
      let s = await summaryOf(7);
      expect(s.ciStatus).toBe('running');
      expect(s.blockingReason).toBe('blocked');

      await ingest({ name: 'Semgrep Checks Pass', state: 'failure', rawState: 'FAILURE', ts: at(21) });
      s = await summaryOf(7);
      expect(s.checks.failed).toBe(2);
      expect(s.ciStatus).toBe('failing_required');
      expect(s.blockingReason).toBe('checks_failed');
    });

    it.each([
      // UNSTABLE was read before this failure existed, so it vouches for nothing.
      ['mergeable + UNSTABLE', { mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE', blockingReason: 'mergeable' }, 'checks_failed', 'failing_required'],
      ['mergeable + BLOCKED', { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', blockingReason: 'mergeable' }, 'checks_failed', 'failing_required'],
      ['posthog blocked-on-review', { ...POSTHOG_FACTS, blockingReason: 'blocked' }, 'checks_failed', 'failing_required'],
    ])('an unknown-required failure under %s → %s', async (_l, facts, want, ci) => {
      await seedPr(7, 'sha-A', facts);
      await ingest({ name: 'gate', state: 'failure' });
      const s = await summaryOf(7);
      expect(s.blockingReason).toBe(want);
      expect(s.ciStatus).toBe(ci);
    });

    it('clears a check-derived verdict once the failure goes green', async () => {
      await seedPr(7, 'sha-A', { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', blockingReason: 'checks_failed' });
      await ingest({ name: 'gate', state: 'success' });
      const s = await summaryOf(7);
      expect(s.blockingReason).toBe('mergeable');
      expect(s.ciStatus).toBe('passing');
    });

    it('raises needs_human from a Visual Review status webhook, and clears it on approval', async () => {
      await seedPr(7, 'sha-A', { ...POSTHOG_FACTS, blockingReason: 'blocked' });
      await reseed([
        ctx('Visual regression tests pass', 'failure', true),
        ctx('Complete Visual Review run', 'failure', false),
        ctx('Django Tests Pass', 'success', true),
      ]);
      const vr = parseStatusPayload(
        { sha: 'sha-A', context: 'PostHog Visual Review / storybook', state: 'failure', updated_at: at(30).toISOString() },
        'acme/widget',
      )!;
      await ingestCheckRun(vr, targets, [7], tracked([7]));
      let s = await summaryOf(7);
      expect(s.blockingReason).toBe('needs_human');
      expect(s.ciStatus).toBe('needs_human');
      expect(s.humanGates?.map((g) => g.name)).toEqual(['PostHog Visual Review / storybook']);

      // Approved: the status goes green, and CI re-runs the required gate.
      await ingestCheckRun({ ...vr, state: 'success', rawState: 'SUCCESS', ts: at(40) }, targets, [7], tracked([7]));
      await ingest({ name: 'Visual regression tests pass', state: 'success', ts: at(45) });
      await ingest({ name: 'Complete Visual Review run', state: 'success', ts: at(45) });
      s = await summaryOf(7);
      expect(s.humanGates).toEqual([]);
      expect(s.ciStatus).toBe('passing');
      expect(s.blockingReason).toBe('blocked');
    });

    it('does not rewrite the row when nothing it derives has changed', async () => {
      await seedPr(7, 'sha-A', { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', blockingReason: 'mergeable' });
      await ingest({ name: 'lint', state: 'success', ts: at(1) });
      const [{ updatedAt: first }] = await db
        .select({ updatedAt: pullRequestsTable.updatedAt })
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, 'pr-7'));
      await ingest({ name: 'lint', state: 'success', ts: at(2) });
      const [{ updatedAt: second }] = await db
        .select({ updatedAt: pullRequestsTable.updatedAt })
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, 'pr-7'));
      expect(second).toEqual(first);
    });
  });

  describe('verdictFor', () => {
    const counts = { total: 1, passed: 1, failed: 0, inProgress: 0, skipped: 0 };
    const ci = { ciStatus: 'passing' as const, blockingFailing: 0, unknownFailing: 0, optionalFailing: 0, humanGates: [] };
    it.each([
      ['blocked', 'blocked'],
      ['behind', 'behind'],
      ['changes_requested', 'changes_requested'],
      ['checks_failed', 'unknown'],
      ['checks_failed_optional', 'unknown'],
      ['needs_human', 'unknown'],
      [null, 'unknown'],
    ])('with mergeable UNKNOWN, a held %s → %s', (held, want) => {
      expect(
        verdictFor(
          { blockingReason: held, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', reviewDecision: null, labels: [] },
          counts,
          ci,
        ),
      ).toBe(want);
    });
  });

  // Nothing corrected the ledger, so the next check webhook after a full fetch
  // recounted from a stale row and put "1/232 running" back (#104122).
  describe('reseedCheckLedger', () => {
    it('keeps a full fetch correct through the NEXT webhook (the case ab6fe35b83 missed)', async () => {
      await seedPr(7, 'sha-A', { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
      // The completion of `e2e` was lost: the ledger is stuck on in_progress.
      await ingest({ name: 'lint', state: 'success', ts: at(1) });
      await ingest({ name: 'e2e', state: 'in_progress', ts: at(2) });
      expect((await checksOf(7)).inProgress).toBe(1);

      await reseed([ctx('lint', 'success', true), ctx('e2e', 'success', true, { ts: at(9).getTime() })]);
      expect((await checksOf(7)).inProgress).toBe(0);

      // A review-triggered workflow reports on the same commit much later.
      await ingest({ name: 'notify-reviewed', state: 'success', ts: at(30) });
      expect(await checksOf(7)).toEqual({ total: 3, passed: 3, failed: 0, inProgress: 0, skipped: 0 });
      expect((await summaryOf(7)).ciStatus).toBe('passing');
    });

    it('overwrites a row nothing touched since the fetch began, whatever its ts claims', async () => {
      await seedPr(7, 'sha-A');
      await ingest({ name: 'e2e', state: 'pending', ts: new Date('2099-01-01T00:00:00Z') });
      await reseed([ctx('e2e', 'success', true, { ts: at(1).getTime() })], new Date(Date.now() + 1000));
      expect(await ledger()).toEqual([{ name: 'e2e', state: 'success', required: true }]);
    });

    it('does not roll back a completion that landed during the fetch', async () => {
      await seedPr(7, 'sha-A');
      const fetchStartedAt = new Date(Date.now() - 60_000);
      await ingest({ name: 'e2e', state: 'failure', ts: at(10) });
      await reseed([ctx('e2e', 'in_progress', true, { ts: at(5).getTime() })], fetchStartedAt);
      expect((await ledger())[0]).toMatchObject({ name: 'e2e', state: 'failure' });
    });

    it('deletes rows GitHub no longer lists, but not ones a webhook wrote during the fetch', async () => {
      await seedPr(7, 'sha-A');
      await ingest({ name: 'gone', state: 'pending', ts: at(1) });
      const fetchStartedAt = new Date(Date.now() + 1000);
      await reseed([ctx('lint', 'success')], fetchStartedAt);
      expect((await ledger()).map((r) => r.name)).toEqual(['lint']);

      const earlier = new Date(Date.now() - 60_000);
      await ingest({ name: 'fresh', state: 'pending', ts: at(2) });
      await reseed([ctx('lint', 'success')], earlier);
      expect((await ledger()).map((r) => r.name).sort()).toEqual(['fresh', 'lint']);
    });

    it('keeps a known required-ness when the snapshot cannot say (by-branch fetch)', async () => {
      await seedPr(7, 'sha-A');
      await reseed([ctx('Semgrep Checks Pass', 'success', true)]);
      await reseed([ctx('Semgrep Checks Pass', 'success', null)], new Date(Date.now() + 1000));
      expect((await ledger())[0].required).toBe(true);
    });

    it('corrects every workspace tracking the PR, not only the one that fetched', async () => {
      await db.insert(workspacesTable).values({ id: 'ws2', ownerId: TEST_USER_ID, name: 'B', settings: {} });
      await db.insert(repositoriesTable).values({
        id: 'r2',
        workspaceId: 'ws2',
        name: 'acme/widget',
        url: 'https://github.com/acme/widget',
        defaultBranch: 'main',
        createdAt: new Date(),
      });
      mockTargets.mockResolvedValue([
        { workspaceId: 'ws1', repositoryId: 'r1' },
        { workspaceId: 'ws2', repositoryId: 'r2' },
      ]);
      await seedPr(7, 'sha-A');
      await db.insert(pullRequestsTable).values({
        id: 'pr-7b',
        workspaceId: 'ws2',
        repositoryId: 'r2',
        owner: 'acme',
        repo: 'widget',
        number: 7,
        state: 'open',
        lastSummary: { headSha: 'sha-A', checks: { ...ZERO, total: 1, inProgress: 1 } },
      });
      await reseed([ctx('lint', 'success')]);
      const [other] = await db
        .select({ ls: pullRequestsTable.lastSummary })
        .from(pullRequestsTable)
        .where(eq(pullRequestsTable.id, 'pr-7b'));
      expect((other.ls as Summary).checks).toEqual({ total: 1, passed: 1, failed: 0, inProgress: 0, skipped: 0 });
    });

    it('leaves PRs on another head alone', async () => {
      await seedPr(7, 'sha-B');
      await reseed([ctx('lint', 'failure')]);
      expect(await checksOf(7)).toEqual(ZERO);
    });
  });

  // A webhook cannot say whether a check is required. A failing row the last
  // full fetch did not describe reads as blocking — and we ask.
  describe('required-ness recheck', () => {
    it.each([
      ['checks_failed_optional', { mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE' }],
      ['blocked', POSTHOG_FACTS],
      ['mergeable', { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }],
    ])('asks when an unknown-required check fails under a held %s verdict', async (held, facts) => {
      await seedPr(7, 'sha-A', { ...facts, blockingReason: held });
      await ingest({ name: 'Visual regression tests pass', state: 'failure' });
      expect(mockForceFetch).toHaveBeenCalledTimes(1);
      expect(mockForceFetch).toHaveBeenCalledWith(expect.objectContaining({ owner: 'acme', repo: 'widget', number: 7 }));
    });

    it('does not ask when the ledger already knows the failing check is required', async () => {
      await seedPr(7, 'sha-A', POSTHOG_FACTS);
      await reseed([ctx('gate', 'pending', true)]);
      await ingest({ name: 'gate', state: 'failure', ts: at(30) });
      expect((await summaryOf(7)).blockingReason).toBe('checks_failed');
      expect(mockForceFetch).not.toHaveBeenCalled();
    });

    it('does not ask about a passing check', async () => {
      await seedPr(7, 'sha-A', { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
      await ingest({ name: 'lint', state: 'success' });
      expect(mockForceFetch).not.toHaveBeenCalled();
    });

    it('debounces repeat rechecks for the same PR, and still rechecks the settled set', async () => {
      await seedPr(7, 'sha-A', POSTHOG_FACTS);
      await ingest({ name: 'a', state: 'failure' });
      await ingest({ name: 'b', state: 'failure' });
      expect(mockForceFetch).toHaveBeenCalledTimes(1); // leading only; trailing parked
      _flushRequirednessRecheckTrailing();
      expect(mockForceFetch).toHaveBeenCalledTimes(2);
    });
  });

  // However the webhook path loses a completion, one authoritative fetch after
  // CI goes quiet reseeds the ledger.
  describe('settle refresh', () => {
    it('arms a refresh for the commit on every buffered event', () => {
      checkCountCoalescer.enqueue(ev({ name: 'a' }));
      checkCountCoalescer.enqueue(ev({ name: 'b' }));
      checkCountCoalescer.enqueue(ev({ headSha: 'sha-B' }));
      expect(_armedSettleRefreshes().sort()).toEqual(['acme/widget sha-A', 'acme/widget sha-B']);
    });

    it('refreshes each PR on the head once, across every workspace tracking it', async () => {
      await seedPr(7, 'sha-A');
      await seedPr(8, 'sha-OTHER');
      await runSettleRefresh('acme/widget', 'sha-A');
      expect(mockRefreshAcross).toHaveBeenCalledTimes(1);
      expect(mockRefreshAcross).toHaveBeenCalledWith(
        [{ workspaceId: 'ws1', owner: 'acme', repo: 'widget', repositoryId: 'r1' }],
        7,
      );
    });

    it('does nothing when no tracked PR is on the head', async () => {
      await seedPr(7, 'sha-B');
      await runSettleRefresh('acme/widget', 'sha-A');
      expect(mockRefreshAcross).not.toHaveBeenCalled();
    });

    it('swallows a failed refresh (the sweep is still behind it)', async () => {
      await seedPr(7, 'sha-A');
      mockRefreshAcross.mockRejectedValueOnce(new Error('rate limited'));
      await expect(runSettleRefresh('acme/widget', 'sha-A')).resolves.toBeUndefined();
    });
  });

  describe('coalescer', () => {
    it('applies a buffered burst in one flush, and drops nothing when a flush fails', async () => {
      await seedPr(7, 'sha-A');
      checkCountCoalescer.enqueue(ev({ name: 'a', state: 'success' }));
      checkCountCoalescer.enqueue(ev({ name: 'b', state: 'failure' }));
      await checkCountCoalescer.flushAllNow();
      expect(await checksOf(7)).toMatchObject({ total: 2, passed: 1, failed: 1 });

      mockTargets.mockRejectedValueOnce(new Error('index unavailable'));
      checkCountCoalescer.enqueue(ev({ name: 'c', state: 'success' }));
      await expect(checkCountCoalescer.flushAllNow()).resolves.toBeUndefined();
      // The flush failed, but the commit still has a settle refresh armed.
      expect(_armedSettleRefreshes()).toEqual(['acme/widget sha-A']);
    });
  });

  describe('pruneChecksForSha', () => {
    it('deletes all check state for a commit', async () => {
      await seedPr(7, 'sha-A');
      await ingest({ name: 'lint' });
      await ingest({ name: 'test' });
      expect(await db.select().from(prCheckStates)).toHaveLength(2);
      await pruneChecksForSha('acme/widget', 'sha-A');
      expect(await db.select().from(prCheckStates)).toHaveLength(0);
    });
  });
});

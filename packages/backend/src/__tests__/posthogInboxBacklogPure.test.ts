import { describe, expect, it } from 'vitest';
import type {
  PostHogInboxBacklogStateInput,
  PostHogInboxFacts,
  PostHogInboxRunResult,
  WorkflowConditions,
  WorkflowRun,
} from '@talyn/shared';
import {
  DEFAULT_POSTHOG_INBOX_BACKLOG_DAYS,
  MAX_POSTHOG_INBOX_RUN_REPORTS,
  POSTHOG_INBOX_BACKLOG_DAYS,
  POSTHOG_INBOX_BACKLOG_STATE_LABELS,
  posthogInboxBacklogDays,
  posthogInboxBacklogState,
  posthogInboxContentMatches,
  posthogInboxRunSummary,
} from '@talyn/shared';
import {
  BACKLOG_PAGE_SIZE,
  backlogQuery,
  claimedInPostHog,
  manualOutcomeResult,
  manualRunRefusal,
  parseRunReportIds,
} from '../services/posthogInbox/backlog.js';
import type { ManualRunOutcome } from '../services/workflows/engine.js';
import { stableJson } from '../routes/workflows.js';

/**
 * The pure parts of the PostHog Inbox backlog: the PostHog list query, the
 * claim reading, the row state, the time range, the run request ids, the
 * manual run answers and summary, the content matcher and the stable JSON
 * that tells unsaved conditions apart.
 */

const NOW = new Date('2026-11-16T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;

describe('backlogQuery', () => {
  it('asks for ready and safety-held reports, newest created first, with source metadata', () => {
    expect(backlogQuery({}, 7, 0, NOW)).toEqual({
      status: 'ready,suppressed',
      actionability: 'immediately_actionable',
      priority: undefined,
      source_product: undefined,
      scout: undefined,
      search: undefined,
      created_after: new Date(NOW.getTime() - 7 * DAY).toISOString(),
      ordering: '-created_at',
      include_source_metadata: true,
      limit: BACKLOG_PAGE_SIZE,
      offset: 0,
    });
    expect(BACKLOG_PAGE_SIZE).toBe(25);
  });

  it.each([
    [7, '2026-11-09T12:00:00.000Z'],
    [30, '2026-10-17T12:00:00.000Z'],
    [90, '2026-08-18T12:00:00.000Z'],
  ] as const)('sends created_after %s days before now', (days, expected) => {
    expect(backlogQuery({}, days, 0, NOW).created_after).toBe(expected);
  });

  it('uses the current time when no now is given', () => {
    const before = Date.now();
    const at = Date.parse(backlogQuery({}, 7, 0).created_after!);
    expect(at).toBeGreaterThanOrEqual(before - 7 * DAY);
    expect(at).toBeLessThanOrEqual(Date.now() - 7 * DAY);
  });

  it.each<[string, WorkflowConditions, Partial<ReturnType<typeof backlogQuery>>]>([
    ['default actionability', {}, { actionability: 'immediately_actionable' }],
    ['empty actionability list', { actionability: [] }, { actionability: undefined }],
    [
      'actionability, sorted and de-duplicated',
      { actionability: ['requires_human_input', 'immediately_actionable', 'requires_human_input'] },
      { actionability: 'immediately_actionable,requires_human_input' },
    ],
    ['priorities', { priorities: ['P2', 'P0', ' P1 '] }, { priority: 'P0,P1,P2' }],
    ['empty priorities', { priorities: [] }, { priority: undefined }],
    ['blank priorities only', { priorities: [' ', ''] }, { priority: undefined }],
    ['source products', { sourceProducts: ['session_replay', 'error_tracking', 'error_tracking'] }, { source_product: 'error_tracking,session_replay' }],
    ['scouts include', { scouts: { include: ['b-scout', 'a-scout'] } }, { scout: 'a-scout,b-scout' }],
    ['scouts exclude only', { scouts: { exclude: ['noisy'] } }, { scout: undefined }],
    ['title search', { titleContains: '  checkout ' }, { search: 'checkout' }],
    ['summary search', { summaryContains: ' crash ' }, { search: 'crash' }],
    ['title wins over summary', { titleContains: 'checkout', summaryContains: 'crash' }, { search: 'checkout' }],
    ['blank title falls back to summary', { titleContains: '   ', summaryContains: 'crash' }, { search: 'crash' }],
    ['blank title and summary', { titleContains: ' ', summaryContains: '' }, { search: undefined }],
  ])('maps %s', (_name, conditions, expected) => {
    expect(backlogQuery(conditions, 7, 0, NOW)).toMatchObject(expected);
  });

  it.each<[WorkflowConditions]>([
    [{ repositories: ['acme/web-app'] }],
    [{ minSignalCount: 5 }],
    [{ suggestedReviewers: ['tom'] }],
  ])('leaves %j to Talyn, not to PostHog', (conditions) => {
    expect(backlogQuery(conditions, 7, 0, NOW)).toEqual(backlogQuery({}, 7, 0, NOW));
  });

  it.each([
    [0, 0],
    [25, 25],
    [25.9, 25],
    [3.2, 3],
    [-1, 0],
    [-50.5, 0],
  ])('floors offset %s to %s', (offset, expected) => {
    expect(backlogQuery({}, 7, offset, NOW).offset).toBe(expected);
  });
});

describe('claimedInPostHog', () => {
  it.each<[string, Parameters<typeof claimedInPostHog>[0], boolean]>([
    ['nothing', {}, false],
    ['a null assignee', { assignee: null }, false],
    ['an empty assignee', { assignee: {} }, false],
    ['an assignee with nulls', { assignee: { claim_id: null, kind: null } }, false],
    ['an agent', { assignee: { kind: 'agent' } }, true],
    ['a user', { assignee: { kind: 'user' } }, true],
    ['an internal task', { assignee: { kind: 'task' } }, true],
    ['a claim id only', { assignee: { claim_id: 'c1' } }, true],
    ['a claim id and kind', { assignee: { claim_id: 'c1', kind: 'agent' } }, true],
    ['a PR in an unknown state (no state)', { implementation_pr_url: 'https://x/pr/1' }, true],
    ['a PR with a null state', { implementation_pr_url: 'https://x/pr/1', implementation_pr_state: null }, true],
    ['a PR with state unknown', { implementation_pr_url: 'https://x/pr/1', implementation_pr_state: 'unknown' }, true],
    ['a draft PR', { implementation_pr_url: 'https://x/pr/1', implementation_pr_state: 'draft' }, true],
    ['an open PR', { implementation_pr_url: 'https://x/pr/1', implementation_pr_state: 'open' }, true],
    ['an OPEN PR (case)', { implementation_pr_url: 'https://x/pr/1', implementation_pr_state: 'OPEN' }, true],
    ['a closed PR', { implementation_pr_url: 'https://x/pr/1', implementation_pr_state: 'closed' }, false],
    ['a merged PR', { implementation_pr_url: 'https://x/pr/1', implementation_pr_state: 'merged' }, false],
    ['a state with no PR url', { implementation_pr_url: null, implementation_pr_state: 'open' }, false],
    ['an empty PR url', { implementation_pr_url: '', implementation_pr_state: 'open' }, false],
    ['a merged PR with an assignee', { assignee: { kind: 'agent' }, implementation_pr_url: 'https://x/pr/1', implementation_pr_state: 'merged' }, true],
  ])('reads %s as %s', (_name, report, expected) => {
    expect(claimedInPostHog(report)).toBe(expected);
  });
});

describe('posthogInboxBacklogState', () => {
  const base: PostHogInboxBacklogStateInput = {
    suppressionSource: null,
    alreadyAddressed: false,
    workspaceRepositoryId: 'r-web',
    claimedInPostHog: false,
    claimIsTalyns: false,
    talynActive: false,
    ranThisVersion: false,
  };

  it.each<[string, Partial<PostHogInboxBacklogStateInput>, string]>([
    ['a plain report', {}, 'not_run'],
    ['unknown already addressed', { alreadyAddressed: null }, 'not_run'],
    ['safety judge', { suppressionSource: 'safety_judge' }, 'held_back'],
    ['SAFETY_JUDGE with spaces', { suppressionSource: '  SAFETY_JUDGE ' }, 'held_back'],
    ['a dismissed suppression', { suppressionSource: 'dismissed' }, 'not_run'],
    ['Talyn works on it', { talynActive: true }, 'running'],
    ['claimed by somebody else', { claimedInPostHog: true }, 'claimed_elsewhere'],
    ['ran this version', { ranThisVersion: true }, 'already_run'],
    ['already addressed', { alreadyAddressed: true }, 'already_addressed'],
    ['no repository (null)', { workspaceRepositoryId: null }, 'repository_not_connected'],
    ['no repository (undefined)', { workspaceRepositoryId: undefined }, 'repository_not_connected'],
    ["Talyn's own stale claim", { claimedInPostHog: true, claimIsTalyns: true }, 'already_run'],
    // The overlaps, in precedence order.
    ['held back beats running', { suppressionSource: 'safety_judge', talynActive: true }, 'held_back'],
    ['held back beats everything', { suppressionSource: 'safety_judge', talynActive: true, claimedInPostHog: true, ranThisVersion: true, alreadyAddressed: true, workspaceRepositoryId: null }, 'held_back'],
    ['running beats claimed elsewhere', { talynActive: true, claimedInPostHog: true }, 'running'],
    ['running beats already addressed', { talynActive: true, alreadyAddressed: true }, 'running'],
    ['running beats no repository', { talynActive: true, workspaceRepositoryId: null }, 'running'],
    ['claimed elsewhere beats already run', { claimedInPostHog: true, ranThisVersion: true }, 'claimed_elsewhere'],
    ['claimed elsewhere beats already addressed', { claimedInPostHog: true, alreadyAddressed: true }, 'claimed_elsewhere'],
    ['claimed elsewhere beats no repository', { claimedInPostHog: true, workspaceRepositoryId: null }, 'claimed_elsewhere'],
    ['already run beats already addressed', { ranThisVersion: true, alreadyAddressed: true }, 'already_run'],
    ['already run beats no repository', { ranThisVersion: true, workspaceRepositoryId: null }, 'already_run'],
    ['own claim and ran: already run', { claimedInPostHog: true, claimIsTalyns: true, ranThisVersion: true }, 'already_run'],
    ['already addressed beats no repository', { alreadyAddressed: true, workspaceRepositoryId: null }, 'already_addressed'],
    ['already addressed beats own stale claim', { alreadyAddressed: true, claimedInPostHog: true, claimIsTalyns: true }, 'already_addressed'],
    ['no repository beats own stale claim', { workspaceRepositoryId: null, claimedInPostHog: true, claimIsTalyns: true }, 'repository_not_connected'],
    ["Talyn's claim flag without a claim", { claimIsTalyns: true }, 'not_run'],
  ])('%s → %s', (_name, overrides, expected) => {
    expect(posthogInboxBacklogState({ ...base, ...overrides })).toBe(expected);
  });

  it('has a label for every state', () => {
    expect(Object.keys(POSTHOG_INBOX_BACKLOG_STATE_LABELS).sort()).toEqual(
      ['already_addressed', 'already_run', 'claimed_elsewhere', 'held_back', 'not_run', 'repository_not_connected', 'running'].sort()
    );
    expect(POSTHOG_INBOX_BACKLOG_STATE_LABELS.held_back).toBe('Held back for safety');
    expect(POSTHOG_INBOX_BACKLOG_STATE_LABELS.running).toBe('Running / PR open');
  });
});

describe('posthogInboxBacklogDays', () => {
  it('offers 7, 30 and 90 days, 7 by default, and at most 20 reports a run', () => {
    expect([...POSTHOG_INBOX_BACKLOG_DAYS]).toEqual([7, 30, 90]);
    expect(DEFAULT_POSTHOG_INBOX_BACKLOG_DAYS).toBe(7);
    expect(MAX_POSTHOG_INBOX_RUN_REPORTS).toBe(20);
  });

  it.each<[unknown, number]>([
    [7, 7],
    [30, 30],
    [90, 90],
    ['7', 7],
    ['30', 30],
    ['90', 90],
    [undefined, 7],
    [null, 7],
    [0, 7],
    [14, 7],
    [-30, 7],
    [30.5, 7],
    ['30 ', 30],
    ['', 7],
    ['abc', 7],
    [[30], 7],
    [{}, 7],
    [true, 7],
    [Number.NaN, 7],
  ])('reads %j as %s', (raw, expected) => {
    expect(posthogInboxBacklogDays(raw)).toBe(expected);
  });
});

describe('parseRunReportIds', () => {
  it.each<[unknown, string[] | null]>([
    [undefined, null],
    [null, null],
    ['rep-1', null],
    [42, null],
    [{ 0: 'rep-1' }, null],
    [['rep-1', 2], null],
    [['rep-1', null], null],
    [['rep-1', ['rep-2']], null],
    [[], []],
    [['', '  '], []],
    [['rep-1'], ['rep-1']],
    [[' rep-1 ', 'rep-2'], ['rep-1', 'rep-2']],
    [['rep-2', 'rep-1', 'rep-2', ' rep-1'], ['rep-2', 'rep-1']],
    [['rep-1', '', 'rep-3'], ['rep-1', 'rep-3']],
  ])('parses %j as %j', (raw, expected) => {
    expect(parseRunReportIds(raw)).toEqual(expected);
  });

  it('keeps the order and does not cap the count (the route does)', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `rep-${i}`);
    expect(parseRunReportIds(ids)).toEqual(ids);
  });
});

describe('manualRunRefusal', () => {
  it.each<[string, { enabled: boolean } | null, string | null]>([
    ['an unsaved rule', null, 'Save the automation first. Then you can run reports.'],
    ['a disabled rule', { enabled: false }, 'Turn the automation on first. Then you can run reports.'],
    ['an enabled rule', { enabled: true }, null],
  ])('%s', (_name, workflow, expected) => {
    expect(manualRunRefusal(workflow)).toBe(expected);
  });
});

describe('manualOutcomeResult', () => {
  const run = { id: 'run-1' } as WorkflowRun;
  const acted = (over: Partial<Extract<ManualRunOutcome, { kind: 'acted' }>>): ManualRunOutcome => ({
    kind: 'acted',
    run,
    status: 'succeeded',
    outcomes: [{ type: 'start_session', ok: true }],
    workbenchId: 'wb-1',
    ...over,
  });

  it.each<[string, ManualRunOutcome, number | null, Partial<PostHogInboxRunResult>]>([
    ['unavailable', { kind: 'unavailable' }, 10, { outcome: 'failed', message: 'PostHog Inbox automations are not available for this workspace now.' }],
    ['no target', { kind: 'no_target' }, 10, { outcome: 'failed', message: 'The report does not belong to this workspace.' }],
    ['not matching', { kind: 'not_matching' }, 10, { outcome: 'not_eligible', message: 'The report no longer matches this automation.' }],
    ['daily capped', { kind: 'daily_capped' }, 10, { outcome: 'daily_cap', message: 'The daily cap of 10 is reached.' }],
    ['daily capped without a cap', { kind: 'daily_capped' }, null, { outcome: 'daily_cap', message: 'The daily cap of this automation is reached.' }],
    ['rate capped', { kind: 'rate_capped' }, 10, { outcome: 'failed', message: expect.stringMatching(/too often in the last hour/) }],
    ['duplicate', { kind: 'duplicate' }, 10, { outcome: 'already_run', message: 'This automation already ran on this version of the report.' }],
    ['acted: session started', acted({}), 10, { outcome: 'started', message: 'Talyn started a session.', runId: 'run-1', workbenchId: 'wb-1' }],
    ['acted: succeeded without a session', acted({ workbenchId: null }), 10, { outcome: 'started', message: 'Talyn started the run.', runId: 'run-1', workbenchId: null }],
    [
      'acted: pending retry with an error',
      acted({ status: 'pending_retry', workbenchId: null, outcomes: [{ type: 'start_session', ok: false, code: 'box_limit_reached', error: 'All boxes are busy.' }] }),
      10,
      { outcome: 'parked', message: 'All boxes are busy.', runId: 'run-1' },
    ],
    [
      'acted: pending retry without an error',
      acted({ status: 'pending_retry', workbenchId: null, outcomes: [] }),
      10,
      { outcome: 'parked', message: 'Talyn tries again later.' },
    ],
    [
      'acted: skipped, claimed elsewhere',
      acted({ status: 'skipped', workbenchId: null, outcomes: [{ type: 'start_session', ok: false, code: 'report_claimed_elsewhere', error: 'x' }] }),
      10,
      { outcome: 'claimed_elsewhere', message: 'Another person or agent claimed this report in PostHog first.', runId: 'run-1' },
    ],
    [
      'acted: failed with an error',
      acted({ status: 'failed', workbenchId: null, outcomes: [{ type: 'start_session', ok: true }, { type: 'start_session', ok: false, error: 'No sandbox.' }] }),
      10,
      { outcome: 'failed', message: 'No sandbox.' },
    ],
    [
      'acted: failed without an error',
      acted({ status: 'failed', workbenchId: null, outcomes: [] }),
      10,
      { outcome: 'failed', message: 'The run failed.' },
    ],
    [
      'acted: skipped for another reason',
      acted({ status: 'skipped', workbenchId: null, outcomes: [{ type: 'start_session', ok: false, code: 'session_active', error: 'A session is live.' }] }),
      10,
      { outcome: 'failed', message: 'A session is live.' },
    ],
    ['acted: no run row', acted({ run: null }), 10, { outcome: 'started', runId: null, workbenchId: 'wb-1' }],
  ])('%s', (_name, outcome, cap, expected) => {
    const res = manualOutcomeResult('rep-1', outcome, cap);
    const ids = outcome.kind === 'acted' ? { runId: 'run-1', workbenchId: outcome.workbenchId } : { runId: null, workbenchId: null };
    expect(res).toEqual({ reportId: 'rep-1', message: expect.any(String), ...ids, ...expected });
  });
});

describe('posthogInboxRunSummary', () => {
  const r = (outcome: PostHogInboxRunResult['outcome']): PostHogInboxRunResult => ({
    reportId: 'x',
    outcome,
    message: '',
    runId: null,
    workbenchId: null,
  });

  it.each<[string, PostHogInboxRunResult['outcome'][], number | null, string]>([
    ['nothing', [], null, '0 of 0 started.'],
    ['all started', ['started', 'started'], 10, '2 of 2 started.'],
    ['the cap', ['started', 'started', 'started', 'daily_cap', 'daily_cap'], 10, '3 of 5 started; the daily cap of 10 is reached.'],
    ['a cap outcome with no cap', ['started', 'daily_cap'], null, '1 of 2 started.'],
    ['one parked', ['started', 'parked'], null, '1 of 2 started; 1 waits for a retry.'],
    ['two parked', ['parked', 'parked', 'failed'], 5, '0 of 3 started; 2 wait for a retry.'],
    ['cap and parked', ['parked', 'daily_cap'], 3, '0 of 2 started; the daily cap of 3 is reached; 1 waits for a retry.'],
    ['other outcomes', ['claimed_elsewhere', 'already_run', 'not_eligible', 'not_found', 'unreadable', 'failed'], 10, '0 of 6 started.'],
  ])('%s', (_name, outcomes, cap, expected) => {
    expect(posthogInboxRunSummary(outcomes.map(r), cap)).toBe(expected);
  });
});

describe('posthogInboxContentMatches', () => {
  const facts = (over: Partial<PostHogInboxFacts> = {}): PostHogInboxFacts => ({
    integration: 'posthog_inbox',
    event: 'report_ready',
    connectionId: 'int-1',
    projectId: '2',
    reportId: 'rep-1',
    updatedAt: '2026-11-14T00:00:00.000001Z',
    title: 'Checkout crashes',
    summary: 'The pay button throws.',
    url: 'https://us.posthog.com/project/2/inbox/rep-1',
    status: 'ready',
    priority: 'P1',
    actionability: 'immediately_actionable',
    alreadyAddressed: false,
    suppressionSource: null,
    sourceProducts: ['error_tracking'],
    scout: 'crash-scout',
    repository: 'acme/web-app',
    suggestedReviewers: ['tom'],
    signalCount: 3,
    workspaceRepositoryId: 'r-web',
    unknownFields: [],
    ...over,
  });

  it.each<[string, WorkflowConditions, Partial<PostHogInboxFacts>, boolean]>([
    ['no conditions', {}, {}, true],
    ['repository match (case)', { repositories: ['ACME/web-app'] }, {}, true],
    ['repository mismatch', { repositories: ['acme/api'] }, {}, false],
    ['priority match', { priorities: ['P0', 'P1'] }, {}, true],
    ['priority mismatch', { priorities: ['P0'] }, {}, false],
    ['priority not judged', { priorities: ['P1'] }, { priority: null }, false],
    ['default actionability mismatch', {}, { actionability: 'requires_human_input' }, false],
    ['actionability listed', { actionability: ['requires_human_input'] }, { actionability: 'requires_human_input' }, true],
    ['actionability not judged', {}, { actionability: null }, false],
    ['source product match', { sourceProducts: ['error_tracking'] }, {}, true],
    ['source product mismatch', { sourceProducts: ['session_replay'] }, {}, false],
    ['source product unknown', { sourceProducts: ['error_tracking'] }, { unknownFields: ['sourceProducts'] }, false],
    ['scout include match', { scouts: { include: ['crash-scout'] } }, {}, true],
    ['scout include mismatch', { scouts: { include: ['other'] } }, {}, false],
    ['scout exclude', { scouts: { exclude: ['crash-scout'] } }, {}, false],
    ['scout unknown', { scouts: { include: ['crash-scout'] } }, { unknownFields: ['scout'] }, false],
    ['reviewer match', { suggestedReviewers: ['tom'] }, {}, true],
    ['reviewer mismatch', { suggestedReviewers: ['ann'] }, {}, false],
    ['reviewer unknown', { suggestedReviewers: ['tom'] }, { unknownFields: ['suggestedReviewers'] }, false],
    ['title contains', { titleContains: 'CHECKOUT' }, {}, true],
    ['title does not contain', { titleContains: 'login' }, {}, false],
    ['summary contains', { summaryContains: 'pay button' }, {}, true],
    ['summary does not contain', { summaryContains: 'login' }, {}, false],
    ['min signals met', { minSignalCount: 3 }, {}, true],
    ['min signals not met', { minSignalCount: 4 }, {}, false],
    // The shared gates are the row's state, not a reason to hide it.
    ['held back by the safety judge', {}, { suppressionSource: 'safety_judge', status: 'suppressed' }, true],
    ['not ready', {}, { status: 'in_progress' }, true],
    ['already addressed', {}, { alreadyAddressed: true }, true],
    ['repository not connected', {}, { workspaceRepositoryId: null }, true],
    ['repository not connected, with a matching repositories condition', { repositories: ['acme/web-app'] }, { workspaceRepositoryId: null }, true],
    ['no repository, no repositories condition', {}, { repository: null, workspaceRepositoryId: null }, true],
    ['no repository, with a repositories condition', { repositories: ['acme/web-app'] }, { repository: null, workspaceRepositoryId: null }, false],
    ['gates still apply the content conditions', { priorities: ['P0'] }, { suppressionSource: 'safety_judge', alreadyAddressed: true }, false],
  ])('%s → %s', (_name, conditions, over, expected) => {
    expect(posthogInboxContentMatches(conditions, facts(over))).toBe(expected);
  });
});

describe('stableJson', () => {
  it.each<[string, unknown, unknown]>([
    ['key order', { a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }],
    ['undefined keys', { a: 1, b: undefined }, { a: 1 }],
    ['nested undefined', { a: { b: undefined, c: [1] } }, { a: { c: [1] } }],
    ['arrays of objects', [{ b: 1, a: 2 }], [{ a: 2, b: 1 }]],
  ])('treats %s as equal', (_name, a, b) => {
    expect(stableJson(a)).toBe(stableJson(b));
  });

  it.each<[string, unknown, unknown]>([
    ['array order', { a: [1, 2] }, { a: [2, 1] }],
    ['null and missing', { a: null }, {}],
    ['a value', { a: 1 }, { a: 2 }],
    ['a string and a number', { a: '1' }, { a: 1 }],
    ['an empty list and missing', { priorities: [] }, {}],
  ])('tells %s apart', (_name, a, b) => {
    expect(stableJson(a)).not.toBe(stableJson(b));
  });

  it.each<[unknown, string]>([
    [null, 'null'],
    [1, '1'],
    ['x', '"x"'],
    [true, 'true'],
    [[], '[]'],
    [{}, '{}'],
    [{ b: [1, { d: 1, c: 'x' }], a: null }, '{"a":null,"b":[1,{"c":"x","d":1}]}'],
  ])('writes %j as %s', (value, expected) => {
    expect(stableJson(value)).toBe(expected);
  });
});

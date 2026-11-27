import type { Workbench } from '@talyn/shared';

import { codeCompleteInput, reviewCard, reviewStatusLabel, sessionCodeComplete, type CodeCompleteFacts } from '../features/sessions/codeComplete';
import { chat, pr, review, session } from './workflowFixtures';

const queued = { id: 'q1', text: 'Next step', queuedAt: '2026-11-08T11:00:00Z' };
const facts = (patch: Partial<CodeCompleteFacts> = {}): CodeCompleteFacts => ({ item: session(), row: pr(), runningJobs: 0, ...patch });
const withItem = (patch: Partial<Workbench>) => facts({ item: session(patch) });

describe('code complete', () => {
  it.each<[string, CodeCompleteFacts, boolean]>([
    ['an idle session with an open PR', facts(), true],
    ['jobs not known yet', facts({ runningJobs: null }), true],
    ['uncommitted and unpushed not known', withItem({ uncommittedStats: null, unpushedCommits: null }), true],
    ['a clean branch', withItem({ uncommittedStats: { added: 0, removed: 0, files: 0 }, unpushedCommits: 0 }), true],
    ['a PR state from the session before the row loads', facts({ row: null, item: session({ pr: { number: 42, url: '', state: 'open', mergeable: 'unknown', ciStatus: 'none' } }) }), true],
    ['a closed chat that ran', withItem({ chats: [chat(), chat({ id: 'old', status: 'running', closedAt: '2026-11-08T11:00:00Z' } as never)] }), true],
    ['a turn that runs', withItem({ chats: [chat({ status: 'running' })] }), false],
    ['a queued message', withItem({ chats: [chat({ queuedMessages: [queued] as never })] }), false],
    ['a chat that failed', withItem({ chats: [chat({ status: 'error' })] }), false],
    ['no chat', withItem({ chats: [] }), false],
    ['a closed PR', facts({ row: pr({ state: 'closed' }) }), false],
    ['a merged PR', facts({ row: pr({ state: 'merged' }) }), false],
    ['no PR', facts({ row: null, item: session({ pullRequestId: null }) }), false],
    ['a PR that has not loaded', facts({ row: null }), false],
    ['a background job that runs', facts({ runningJobs: 1 }), false],
    ['uncommitted files', withItem({ uncommittedStats: { added: 3, removed: 1, files: 2 } }), false],
    ['unpushed commits', withItem({ unpushedCommits: 1 }), false],
    ['an archived session', withItem({ archivedAt: '2026-11-09T10:00:00Z' }), false],
    ['a thread', withItem({ kind: 'thread' }), false],
  ])('%s: %s', (_name, input, expected) => expect(sessionCodeComplete(input)).toBe(expected));

  it('reads scripts as not running, because mobile has no script state', () => {
    expect(codeCompleteInput(facts()).runningScripts).toBe(0);
  });
});

describe('end-of-chat review card', () => {
  const base = { progress: null, sent: null, start: null, viewFindings: false, text: null, findings: null };
  it.each([
    ['no review', null, { ...base, state: 'none', title: 'Ready for review', text: 'The work is pushed and the pull request is open.',
      start: 'Run code review', tone: 'primary' }],
    ['a cancelled review', review({ phase: 'cancelled' }), { ...base, state: 'none', title: 'Ready for review',
      text: 'The work is pushed and the pull request is open.', start: 'Run code review', tone: 'primary' }],
    ['findings for an older commit', review({ staleForHead: true }), { ...base, state: 'none', title: 'Ready for review',
      text: 'The work is pushed and the pull request is open.', start: 'Run code review', tone: 'primary' }],
    ['a running review', review({ phase: 'reviewing', runsDone: 1, runsTotal: 4 }), { ...base, state: 'running', title: 'Code review running',
      text: 'Looking for problems (2 of 4)', progress: expect.any(Number), tone: 'information' }],
    ['a review waiting for a runner', review({ phase: 'queued', runsDone: 0, deferredSince: '2026-11-08T10:00:00Z' }), { ...base, state: 'waiting',
      title: 'Code review is waiting for a runner', text: 'The review starts when a runner is free.', tone: 'warning' }],
    ['a failed review', review({ phase: 'failed', openCount: 0, failureReason: 'The runner stopped.' }), { ...base, state: 'failed',
      title: 'The code review did not finish.', text: 'The runner stopped.', start: 'Run again', viewFindings: true, tone: 'destructive' }],
    ['a done review with findings', review(), { ...base, state: 'done', title: 'Code review done', findings: 'Must fix 1 · Should fix 1',
      viewFindings: true, tone: 'warning' }],
    ['a clean review', review({ counts: { blocker: 0, major: 0, minor: 0, nit: 1 }, openCount: 0 }), { ...base, state: 'done',
      title: 'Code review done', findings: 'No open findings', viewFindings: true, tone: 'success' }],
    ['findings sent to this session', review({ sessionReport: { workbenchId: 'session-one', sentAt: '2026-11-23T10:00:00Z', findingCount: 2 } }),
      { ...base, state: 'done', title: 'Code review done', findings: 'Must fix 1 · Should fix 1', viewFindings: true, tone: 'warning',
        sent: 'Talyn sent 2 findings to this session.' }],
    ['sent findings the session handled on an older commit', review({ staleForHead: true, counts: { blocker: 0, major: 0, minor: 0, nit: 0 }, openCount: 0,
      sessionReport: { workbenchId: 'session-one', sentAt: '2026-11-23T10:00:00Z', findingCount: 1 } }),
      { ...base, state: 'done', title: 'Code review done', findings: 'No open findings. The session fixed or dismissed each finding.',
        start: 'Review again', viewFindings: true, tone: 'success', sent: 'Talyn sent 1 finding to this session.' }],
    ['a sent finding still open on an older commit', review({ staleForHead: true, counts: { blocker: 0, major: 0, minor: 1, nit: 0 }, openCount: 1,
      sessionReport: { workbenchId: 'session-one', sentAt: '2026-11-23T10:00:00Z', findingCount: 1 } }),
      { ...base, state: 'none', title: 'Ready for review', text: 'The work is pushed and the pull request is open.', start: 'Run code review', tone: 'primary' }],
  ] as const)('%s', (_name, codeReview, expected) => expect(reviewCard(facts({ row: pr({ codeReview }) }))).toEqual(expected));

  it.each([
    ['a turn runs', withItem({ chats: [chat({ status: 'running' })] })],
    ['a turn runs during a review', facts({ item: session({ chats: [chat({ status: 'running' })] }), row: pr({ codeReview: review({ phase: 'reviewing' }) }) })],
    ['the PR is closed', facts({ row: pr({ state: 'closed', codeReview: review() }) })],
    ['the session is archived during a review', facts({ item: session({ archivedAt: '2026-11-09T10:00:00Z' }), row: pr({ codeReview: review({ phase: 'reviewing' }) }) })],
    ['a thread', facts({ item: session({ kind: 'thread' }), row: pr({ codeReview: review({ phase: 'reviewing' }) }) })],
    ['no review and a background job runs', facts({ runningJobs: 2 })],
    ['findings for an older commit and unpushed commits', facts({ item: session({ unpushedCommits: 1 }), row: pr({ codeReview: review({ staleForHead: true }) }) })],
  ])('is hidden when %s', (_name, input) => expect(reviewCard(input)).toBeNull());

  const notComplete = {
    'a background job runs': { runningJobs: 2 },
    'files are uncommitted': { item: session({ uncommittedStats: { added: 1, removed: 0, files: 1 } }) },
    'commits are not pushed': { item: session({ unpushedCommits: 1 }) },
    'a message is queued': { item: session({ chats: [chat({ queuedMessages: [queued] as never })] }) },
  } satisfies Record<string, Partial<CodeCompleteFacts>>;

  it.each(Object.entries(notComplete).flatMap(([name, patch]) => [
    [name, 'running', review({ phase: 'reviewing', runsDone: 1, runsTotal: 4 }), patch, null],
    [name, 'waiting', review({ phase: 'queued', runsDone: 0, deferredSince: '2026-11-08T10:00:00Z' }), patch, null],
    [name, 'failed', review({ phase: 'failed', openCount: 0 }), patch, 'Run again'],
    [name, 'done', review(), patch, null],
  ] as const))('%s: shows the %s review, without a start button', (_name, state, codeReview, patch, completeStart) => {
    const card = reviewCard(facts({ ...patch, row: pr({ codeReview }) }));
    expect(card).toMatchObject({ state, start: null });
    // The same review offers a start once the session is code complete.
    expect(reviewCard(facts({ row: pr({ codeReview }) }))?.start ?? null).toBe(completeStart);
  });
});

describe('session menu review status', () => {
  it.each([
    ['code complete with no review', facts(), 'Ready for review'],
    ['running', facts({ row: pr({ codeReview: review({ phase: 'reviewing' }) }) }), 'Reviewing'],
    ['waiting', facts({ row: pr({ codeReview: review({ phase: 'queued', deferredSince: '2026-11-08T10:00:00Z' }) }) }), 'Waiting for a runner'],
    ['with two findings', facts({ row: pr({ codeReview: review() }) }), '2 findings'],
    ['with one finding', facts({ row: pr({ codeReview: review({ openCount: 1 }) }) }), '1 finding'],
    ['clean', facts({ row: pr({ codeReview: review({ openCount: 0 }) }) }), 'No findings'],
    ['sent findings the session handled', facts({ row: pr({ codeReview: review({ staleForHead: true, counts: { blocker: 0, major: 0, minor: 0, nit: 0 },
      openCount: 0, sessionReport: { workbenchId: 'session-one', sentAt: '2026-11-23T10:00:00Z', findingCount: 1 } }) }) }), 'No open findings'],
    ['failed', facts({ row: pr({ codeReview: review({ phase: 'failed' }) }) }), 'Review failed'],
    ['a review while a turn runs', facts({ item: session({ chats: [chat({ status: 'running' })] }), row: pr({ codeReview: review() }) }), '2 findings'],
  ] as const)('shows %s', (_name, input, expected) => expect(reviewStatusLabel(input)).toBe(expected));

  it.each([
    ['not code complete with no review', facts({ runningJobs: 1 })],
    ['an older review that is not code complete', facts({ runningJobs: 1, row: pr({ codeReview: review({ staleForHead: true }) }) })],
    ['no PR row', facts({ row: null })],
    ['a thread', withItem({ kind: 'thread' })],
  ])('shows nothing for %s', (_name, input) => expect(reviewStatusLabel(input)).toBeNull());
});

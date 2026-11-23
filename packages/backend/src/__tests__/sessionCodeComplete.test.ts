import { describe, expect, it } from 'vitest';
import {
  codeCompleteBlockers,
  isSessionCodeComplete,
  reviewCoversHead,
  sessionReviewState,
  type CodeCompleteInput,
  type CodeReviewPhase,
} from '@talyn/shared';

// packages/shared has no test runner, so its pure helpers are tested here.

const COMPLETE: CodeCompleteInput = {
  kind: 'session',
  archived: false,
  chats: [{ status: 'idle', queuedMessages: [] }],
  pullRequestState: 'open',
  runningBackgroundJobs: 0,
  runningScripts: 0,
  uncommittedFiles: 0,
  unpushedCommits: 0,
};

describe('codeCompleteBlockers', () => {
  it('is code complete when every condition holds', () => {
    expect(codeCompleteBlockers(COMPLETE)).toEqual([]);
    expect(isSessionCodeComplete(COMPLETE)).toBe(true);
  });

  it.each<[string, Partial<CodeCompleteInput>, string]>([
    ['a thread', { kind: 'thread' }, 'thread'],
    ['an archived session', { archived: true }, 'archived'],
    ['no chats', { chats: [] }, 'no_chat'],
    ['null chats', { chats: null }, 'no_chat'],
    ['only closed chats', { chats: [{ status: 'idle', closedAt: '2026-11-23T10:00:00Z' }] }, 'no_chat'],
    ['a running turn', { chats: [{ status: 'running', queuedMessages: [] }] }, 'turn_running'],
    ['a running turn in a second chat', { chats: [{ status: 'idle' }, { status: 'running' }] }, 'turn_running'],
    ['a queued message', { chats: [{ status: 'idle', queuedMessages: [{ id: 'm1' }] }] }, 'turn_queued'],
    ['an open question', { chats: [{ status: 'awaiting_input' }] }, 'chat_not_idle'],
    ['a failed turn', { chats: [{ status: 'error' }] }, 'chat_not_idle'],
    ['no pull request', { pullRequestState: null }, 'no_pull_request'],
    ['an absent pull request', { pullRequestState: undefined }, 'no_pull_request'],
    ['a closed pull request', { pullRequestState: 'closed' }, 'pull_request_not_open'],
    ['a merged pull request', { pullRequestState: 'merged' }, 'pull_request_not_open'],
    ['a running background job', { runningBackgroundJobs: 1 }, 'background_job_running'],
    ['a running session script', { runningScripts: 2 }, 'script_running'],
    ['uncommitted changes', { uncommittedFiles: 3 }, 'uncommitted_changes'],
    ['unpushed commits', { unpushedCommits: 1 }, 'unpushed_commits'],
  ])('is not code complete with %s', (_name, patch, blocker) => {
    const input = { ...COMPLETE, ...patch };
    expect(codeCompleteBlockers(input)).toEqual([blocker]);
    expect(isSessionCodeComplete(input)).toBe(false);
  });

  it.each<[string, Partial<CodeCompleteInput>]>([
    ['unknown uncommitted files', { uncommittedFiles: null }],
    ['absent uncommitted files', { uncommittedFiles: undefined }],
    ['unknown unpushed commits', { unpushedCommits: null }],
    ['absent kind', { kind: undefined }],
    ['a closed chat beside an idle one', { chats: [{ status: 'idle' }, { status: 'running', closedAt: '2026-11-23T10:00:00Z' }] }],
    ['chats with no queue field', { chats: [{ status: 'idle' }] }],
  ])('treats %s as no blocker', (_name, patch) => {
    expect(codeCompleteBlockers({ ...COMPLETE, ...patch })).toEqual([]);
  });

  it('lists every blocker at once', () => {
    expect(
      codeCompleteBlockers({
        ...COMPLETE,
        chats: [{ status: 'running', queuedMessages: [{}] }],
        pullRequestState: 'closed',
        runningBackgroundJobs: 1,
        runningScripts: 1,
        uncommittedFiles: 1,
        unpushedCommits: 1,
      }),
    ).toEqual([
      'turn_running',
      'turn_queued',
      'pull_request_not_open',
      'background_job_running',
      'script_running',
      'uncommitted_changes',
      'unpushed_commits',
    ]);
  });
});

describe('sessionReviewState', () => {
  it.each<[string, Parameters<typeof sessionReviewState>[0], ReturnType<typeof sessionReviewState>]>([
    ['no review', null, 'none'],
    ['an absent review', undefined, 'none'],
    ['a review that never ran', { phase: 'idle', staleForHead: false }, 'none'],
    ['a cancelled review', { phase: 'cancelled', staleForHead: false }, 'none'],
    ['a finished review of an older head', { phase: 'ready', staleForHead: true }, 'none'],
    ['a failed review of an older head', { phase: 'failed', staleForHead: true }, 'none'],
    ['a queued review', { phase: 'queued', staleForHead: false }, 'running'],
    ['a running review while the old findings are stale', { phase: 'reviewing', staleForHead: true }, 'running'],
    ['a review that waits for a runner', { phase: 'preparing', staleForHead: false, deferredSince: '2026-11-23T10:00:00Z' }, 'waiting'],
    ['a fixing review', { phase: 'fixing', staleForHead: false }, 'running'],
    ['a finished review', { phase: 'ready', staleForHead: false }, 'done'],
    ['a fixed review', { phase: 'fixed', staleForHead: false }, 'done'],
    ['a deferral on a review at rest', { phase: 'ready', staleForHead: false, deferredSince: '2026-11-23T10:00:00Z' }, 'done'],
    ['a failed review', { phase: 'failed', staleForHead: false }, 'failed'],
  ])('%s is %s', (_name, review, state) => {
    expect(sessionReviewState(review)).toBe(state);
  });
});

describe('reviewCoversHead', () => {
  const HEAD = 'a'.repeat(40);
  const OLD = 'b'.repeat(40);
  const review = (phase: CodeReviewPhase, reviewedHeadSha: string, targetHeadSha: string) => ({
    phase,
    reviewedHeadSha,
    targetHeadSha,
  });

  it.each<[string, Parameters<typeof reviewCoversHead>[0], string, boolean]>([
    ['no review', null, HEAD, false],
    ['an empty head', review('ready', '', ''), '', false],
    ['a never-run review', review('idle', '', ''), HEAD, false],
    ['a review of the head', review('ready', HEAD, HEAD), HEAD, true],
    ['a review of an older head', review('ready', OLD, OLD), HEAD, false],
    ['a cycle in flight on an older head', review('reviewing', OLD, OLD), HEAD, true],
    ['a failed cycle that targeted the head', review('failed', OLD, HEAD), HEAD, true],
    ['a cancelled cycle that targeted the head', review('cancelled', OLD, HEAD), HEAD, true],
    ['a cancelled cycle on an older head', review('cancelled', OLD, OLD), HEAD, false],
    ['an idle row that names the head', review('idle', '', HEAD), HEAD, false],
  ])('%s', (_name, value, head, covered) => {
    expect(reviewCoversHead(value, head)).toBe(covered);
  });
});

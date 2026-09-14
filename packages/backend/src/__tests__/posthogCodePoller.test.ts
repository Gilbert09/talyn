import { describe, it, expect } from 'vitest';
import { findPullRequestUrl, lastFlowEventIsTurnComplete } from '../services/posthogCode/poller.js';
import type { PostHogRun } from '../services/posthogCode/client.js';
import type { AcpLogEntry } from '../services/posthogCode/acpConverter.js';

const note = (method: string, update?: Record<string, unknown>): AcpLogEntry => ({
  type: 'notification',
  notification: { method, params: update ? { update } : {} },
});
const su = (sessionUpdate: string): AcpLogEntry => note('session/update', { sessionUpdate });

describe('lastFlowEventIsTurnComplete', () => {
  it('returns true when the tail ends on turn_complete (skipping trailing keepalives)', () => {
    // Mirrors a real idle tail: agent_message → usage → turn_complete →
    // later lone console heartbeats.
    const entries = [
      su('agent_message'),
      su('usage_update'),
      note('_posthog/usage_update'),
      note('_posthog/turn_complete'),
      note('_posthog/console'),
      note('_posthog/console'),
    ];
    expect(lastFlowEventIsTurnComplete(entries)).toBe(true);
  });

  it('returns true for task_complete', () => {
    expect(lastFlowEventIsTurnComplete([su('agent_message'), note('_posthog/task_complete')])).toBe(true);
  });

  it('returns false when the last real event is an in-flight tool call', () => {
    // A long silent tool: tool_call then streaming rawInput updates, no end.
    const entries = [
      note('_posthog/turn_complete'), // an earlier turn ended…
      su('tool_call'),
      su('tool_call_update'), // …but a new tool is mid-flight
      note('_posthog/console'),
    ];
    expect(lastFlowEventIsTurnComplete(entries)).toBe(false);
  });

  it('returns false when the agent stalled mid-message (no turn_complete)', () => {
    expect(lastFlowEventIsTurnComplete([su('tool_call_update'), su('agent_message')])).toBe(false);
  });

  it('returns false when the tail errored', () => {
    expect(lastFlowEventIsTurnComplete([note('_posthog/turn_complete'), su('tool_call'), note('_posthog/error')])).toBe(false);
  });

  it('returns false for an empty or marker-less tail', () => {
    expect(lastFlowEventIsTurnComplete([])).toBe(false);
    expect(lastFlowEventIsTurnComplete([note('_posthog/console'), note('_posthog/progress')])).toBe(false);
  });
});

/**
 * Which PR a cloud run opened.
 *
 * The fixtures here are trimmed copies of real `tasks-runs-retrieve` responses,
 * because the bug this replaced was a disagreement about what the API actually
 * returns. The shape that matters: `output.pr_url` states authorship,
 * `output.final_message` is prose that cites other people's PRs, and the two
 * routinely disagree.
 */
describe('findPullRequestUrl', () => {
  const run = (output: unknown, over: Partial<PostHogRun> = {}): PostHogRun =>
    ({ id: 'run-1', status: 'completed', branch: 'posthog/some-branch', output, ...over }) as PostHogRun;

  it('reads the PR the runner recorded', () => {
    expect(
      findPullRequestUrl(
        run({
          pr_url: 'https://github.com/PostHog/posthog/pull/100303',
          pr_urls: ['https://github.com/PostHog/posthog/pull/100303'],
          pr_state: 'draft',
          head_branch: 'posthog/keep-inbox-triage-button-in-place',
        })
      )
    ).toBe('https://github.com/PostHog/posthog/pull/100303');
  });

  it('prefers it over a PR the agent merely wrote about', () => {
    // Real shape: the closing message cites the PR that removed the thing AND
    // the PR this run opened. Only one of them is a claim about authorship.
    expect(
      findPullRequestUrl(
        run({
          pr_url: 'https://github.com/PostHog/posthog/pull/100303',
          final_message:
            'Triage mode was never fully removed — see [#98441](https://github.com/PostHog/posthog/pull/98441). ' +
            'Restored in [#100303](https://github.com/PostHog/posthog/pull/100303).',
        })
      )
    ).toBe('https://github.com/PostHog/posthog/pull/100303');
  });

  it('links NOTHING for a run that only talked about a PR', () => {
    // The regression. A "Daily PR" loop reviews pull requests for a living, so
    // its closing message names one every single time; the old scan took the
    // first match anywhere in the run and filed the run against a PR the user
    // had opened the day before and already merged.
    expect(
      findPullRequestUrl(
        run({
          head_branch: 'main',
          final_message:
            'I reviewed https://github.com/PostHog/posthog/pull/99835 and left no comments.',
        })
      )
    ).toBeNull();
  });

  it('ignores a PR URL sitting in the run state', () => {
    // `state` is the run's configuration, which carries the prompt's context.
    expect(
      findPullRequestUrl(
        run(
          { head_branch: 'main' },
          {
            state: {
              mode: 'background',
              slack_thread_url: 'https://github.com/PostHog/posthog/pull/99835',
            },
          } as Partial<PostHogRun>
        )
      )
    ).toBeNull();
  });

  it('falls back to the list when only it is populated', () => {
    expect(findPullRequestUrl(run({ pr_urls: ['https://github.com/PostHog/posthog/pull/1'] }))).toBe(
      'https://github.com/PostHog/posthog/pull/1'
    );
  });

  it('links nothing for a run that pushed nothing', () => {
    // A Codex run that opened no PR, verbatim. Note `branch: 'main'` — which is
    // why the run's branch is not a usable stand-in for a PR head.
    expect(findPullRequestUrl(run({ head_branch: 'main' }, { branch: 'main' }))).toBeNull();
  });

  it.each([
    ['no output', undefined],
    ['null output', null],
    ['a bare string', 'opened https://github.com/PostHog/posthog/pull/7'],
    ['an explicit null pr_url', { pr_url: null }],
    ['a non-PR url', { pr_url: 'https://github.com/PostHog/posthog/issues/7' }],
    ['a sentence around the url', { pr_url: 'see https://github.com/PostHog/posthog/pull/7 now' }],
    ['a non-string in the list', { pr_urls: [42, null] }],
  ])('links nothing for %s', (_label, output) => {
    expect(findPullRequestUrl(run(output))).toBeNull();
  });

  it('links nothing for no run at all', () => {
    expect(findPullRequestUrl(null)).toBeNull();
  });
});

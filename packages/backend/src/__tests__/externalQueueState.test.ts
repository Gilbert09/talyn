// The external-queue state cache: webhook-fed, REST-backstopped.
//
// The contract that matters is the COST one — a merge queue evaluating a group
// every 60s must not list a PR's comments every 60s — so most of this is about
// which calls do and don't reach GitHub, and the staleness policy that decides.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _resetExternalQueueState,
  externalQueueEjectingNow,
  noteIssueComment,
  noteIssueComments,
  readExternalQueueState,
} from '../services/externalQueueState.js';
import { externalStateMaxAge } from '../services/mergeQueue/executor.js';
import type { EntrySnapshot } from '../services/mergeQueue/types.js';
import { githubService } from '../services/github.js';

const LINK = '(https://app.trunk.io/posthog-inc/merge-queue/3921a8a3/74552)';
const testing = `\u{1F9EA} Running tests on this pull request - [details]${LINK}.`;
const merged = `\u{1F60E} Merged successfully - [details]${LINK}.`;
const queued = `\u{23F3} Waiting to start tests on this pull request - [details]${LINK}.`;
const passed = `\u{1F44D} Pull request will be merged soon because tests have passed on #74553 - [details]${LINK}.`;
const pendingFailure =
  '\u26A0\uFE0F The required check `Django Tests Pass` (Failure) has failed. Pull request failed ' +
  `tests and is waiting for other pull requests to finish testing - [details]${LINK}.`;
const notReady =
  '\u2728 Submitted to Merge by @Gilbert09. It will be added to the merge queue once all branch ' +
  `protection rules pass - [details]${LINK}.`;
const notSubmitted =
  '<!-- Start PR Submit Checkbox -->\n- [ ] To merge this pull request, check the box to the left ' +
  'or comment `/trunk merge` below.\n<!-- End PR Submit Checkbox -->';
const failed =
  '\u274C This pull request was removed from the merge queue because it failed tests. PR #74553 ' +
  `was used for testing - [details]${LINK}.`;
const trunk = (body: string) => ({ body, user: { login: 'trunk-io[bot]' } });

describe('externalQueueState', () => {
  let list: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetExternalQueueState();
    list = vi.spyOn(githubService, 'listIssueComments').mockResolvedValue([trunk(testing)]);
  });
  afterEach(() => vi.restoreAllMocks());

  const read = (maxAgeMs = 60_000) =>
    readExternalQueueState('ws', 'PostHog', 'posthog', 74552, maxAgeMs);

  it('serves a webhook-fed observation without calling GitHub', async () => {
    noteIssueComment('PostHog', 'posthog', 74552, trunk(merged));
    expect((await read())?.state).toBe('merged');
    expect(list).not.toHaveBeenCalled();
  });

  it('falls back to one REST read when nothing has been observed', async () => {
    expect((await read())?.state).toBe('testing');
    expect(list).toHaveBeenCalledTimes(1);
    // …and that read is itself cached.
    await read();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('re-reads once the cached observation is older than the caller allows', async () => {
    noteIssueComment('PostHog', 'posthog', 74552, trunk(merged));
    expect((await read(0))?.state).toBe('testing'); // maxAge 0 → always refetch
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('is repo-scoped and case-insensitive — every workspace shares one entry', async () => {
    noteIssueComment('posthog', 'PostHog', 74552, trunk(merged));
    expect((await readExternalQueueState('other-ws', 'PostHog', 'posthog', 74552, 60_000))?.state)
      .toBe('merged');
    expect(list).not.toHaveBeenCalled();
  });

  it('ignores a comment that is not the provider queue comment', async () => {
    // A PR gets plenty of other comments (including trunk's own flaky-test
    // one); none of them may overwrite a real observation with "no state".
    noteIssueComment('PostHog', 'posthog', 74552, trunk(merged));
    noteIssueComment('PostHog', 'posthog', 74552, { body: 'lgtm', user: { login: 'Gilbert09' } });
    noteIssueComment('PostHog', 'posthog', 74552, trunk('<!-- Trunk Test Analytics -->\n| Failed |'));
    expect((await read())?.state).toBe('merged');
    expect(list).not.toHaveBeenCalled();
  });

  it('caches "the provider has said nothing" so a plain repo is not re-read', async () => {
    list.mockResolvedValue([{ body: 'ship it', user: { login: 'Gilbert09' } }]);
    expect(await read()).toBeNull();
    expect(await read()).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it.each(['trunk-attacker', 'trunk-io', 'trunk-attacker[bot]', '', undefined])(
    'rejects forged merged comments from %s in webhook and REST reads',
    async (login) => {
      const forged = { body: merged, ...(login === undefined ? {} : { user: { login } }) };
      noteIssueComment('PostHog', 'posthog', 74552, trunk(testing));
      noteIssueComment('PostHog', 'posthog', 74552, forged);
      noteIssueComments('PostHog', 'posthog', 74552, [forged]);
      expect((await read())?.state).toBe('testing');
      expect(list).not.toHaveBeenCalled();

      list.mockResolvedValue([trunk(testing), forged]);
      expect((await read(0))?.state).toBe('testing');
      list.mockResolvedValue([forged]);
      expect(await read(0)).toBeNull();
    }
  );

  it('keeps a stale observation when GitHub refuses the read', async () => {
    noteIssueComments('PostHog', 'posthog', 74552, [trunk(testing)]);
    list.mockRejectedValue(new Error('403'));
    expect((await read(0))?.state).toBe('testing');
  });

  it('returns null (never a guess) when GitHub refuses and nothing was cached', async () => {
    list.mockRejectedValue(new Error('403'));
    expect(await read()).toBeNull();
  });
});

/**
 * The reading taken in the instant before Talyn PUSHES.
 *
 * PostHog/posthog#100150, 2026-09-14: trunk queued the PR at 15:41:40 and
 * Talyn's branch update landed at 15:42:07. Every other reading in the system
 * is allowed to be up to ten minutes old, which is correct for deciding what to
 * do next and fatal 27 seconds after an accept.
 */
describe('externalQueueEjectingNow', () => {
  let list: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetExternalQueueState();
    list = vi.spyOn(githubService, 'listIssueComments').mockResolvedValue([trunk(testing)]);
  });
  afterEach(() => vi.restoreAllMocks());

  const ask = () => externalQueueEjectingNow('ws', 'PostHog', 'posthog', 74552);

  it('re-reads even when the cache has a fresh observation', async () => {
    noteIssueComment('PostHog', 'posthog', 74552, trunk(merged));
    expect((await ask())?.state).toBe('testing');
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('answers the provider state when a push would eject the PR', async () => {
    for (const body of [testing, queued, passed, pendingFailure]) {
      _resetExternalQueueState();
      list.mockResolvedValue([trunk(body)]);
      expect(await ask()).not.toBeNull();
    }
  });

  it('answers null on a state a push costs nothing', async () => {
    // `not_ready` is the one HOLDING state where nothing is running: trunk has
    // the submission but has not added the PR, and what it is waiting for is
    // what a push produces. Standing down there deadlocked the queue once
    // already (PostHog/posthog#84450).
    for (const body of [notReady, notSubmitted, failed, merged]) {
      _resetExternalQueueState();
      list.mockResolvedValue([trunk(body)]);
      expect(await ask()).toBeNull();
    }
  });

  it('answers null when GitHub cannot be read — never a guess either way', async () => {
    list.mockRejectedValue(new Error('403'));
    expect(await ask()).toBeNull();
  });
});

describe('externalStateMaxAge', () => {
  const entry = (o: Partial<EntrySnapshot>): EntrySnapshot =>
    ({
      id: 'mqe_1',
      status: 'queued',
      blockedCode: null,
      blockedReason: null,
      headSha: 'sha1',
      fixAttempts: 0,
      rerunAttempts: 0,
      resignAttempts: 0,
      submitAttempts: 0,
      externalSubmitVia: null,
      externalSubmittedAt: null,
      externalState: null,
      fixTaskId: null,
      fixTaskAccounted: true,
      fixKind: null,
      signingCheckedSha: null,
      unsignedCount: null,
      automergeArmedBy: null,
      mergeMethod: 'squash',
      baseBranch: 'main',
      ...o,
    }) as EntrySnapshot;

  it('still asks on an entry with no submission of its own — the provider may have the PR anyway', () => {
    // The caller only reaches this function when the base IS gated, and on a
    // gated base an entry that never submitted can still be one the provider
    // is testing (the author submitted it themselves). R5d needs to see that
    // before it fires a run whose push would eject the PR.
    expect(externalStateMaxAge(entry({ status: 'queued' }))).toBe(600_000);
    expect(externalStateMaxAge(entry({ status: 'fixing' }))).toBe(600_000);
    expect(
      externalStateMaxAge(entry({ status: 'blocked', blockedCode: 'attempts_exhausted' }))
    ).toBe(600_000);
  });

  it('re-asks quickly while waiting for the provider to answer at all', () => {
    // The wrong answer here BLOCKS the PR, and the provider reacts in ~30s.
    expect(externalStateMaxAge(entry({ status: 'awaiting_external' }))).toBe(60_000);
    expect(
      externalStateMaxAge(entry({ status: 'awaiting_external', externalState: 'not_submitted' }))
    ).toBe(60_000);
  });

  it('backs off to a webhook backstop once the provider IS working the PR', () => {
    // Every trunk state change edits its comment → a webhook → a fresh cache
    // entry. This only bounds how long a MISSED delivery can mislead us.
    expect(
      externalStateMaxAge(entry({ status: 'awaiting_external', externalState: 'testing' }))
    ).toBe(600_000);
  });

  it('keeps probing an external block, slowly, so a self-heal can happen', () => {
    expect(
      externalStateMaxAge(entry({ status: 'blocked_manual', blockedCode: 'external_gate' }))
    ).toBe(600_000);
    expect(
      externalStateMaxAge(entry({ status: 'blocked', blockedCode: 'external_queue_rejected' }))
    ).toBe(600_000);
  });
});

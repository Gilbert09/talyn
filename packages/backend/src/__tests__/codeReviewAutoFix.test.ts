import { describe, it, expect } from 'vitest';
import {
  findingsEligibleForAutoFix,
  resolveCodeReviewSettings,
  type CodeReviewSettings,
} from '@talyn/shared';

/**
 * What auto-fix is allowed to touch.
 *
 * This is the only path in the review pipeline that pushes a commit with no
 * human in the loop, and the design deliberately excluded it: every other guard
 * assumes a person chose the findings. It exists because it was asked for, so
 * the bounds are the whole safety story and each one comes from something that
 * actually happened on the first real review — where the judge rejected five of
 * six candidates, and the single finding that survived quoted code that was not
 * at the line it named, and was wrong.
 */

const settingsWith = (over: CodeReviewSettings) =>
  resolveCodeReviewSettings({ autoFix: true, ...over });

const finding = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'f1',
  severity: 'blocker',
  verdict: 'confirmed',
  disposition: 'open',
  anchorVerified: true,
  ...over,
});

describe('findingsEligibleForAutoFix', () => {
  it('is empty when auto-fix is off, so no caller needs a second check', () => {
    expect(findingsEligibleForAutoFix([finding()], resolveCodeReviewSettings({}))).toEqual([]);
  });

  it('defaults to blockers only', () => {
    // The narrow end has to be the default: this decides what gets committed
    // unattended.
    const settings = settingsWith({});
    expect(settings.autoFixSeverity).toBe('blocker');
    expect(findingsEligibleForAutoFix([finding({ severity: 'major' })], settings)).toEqual([]);
    expect(findingsEligibleForAutoFix([finding()], settings)).toHaveLength(1);
  });

  it('honours a widened floor', () => {
    const settings = settingsWith({ autoFixSeverity: 'minor' });
    const list = [
      finding({ id: 'b', severity: 'blocker' }),
      finding({ id: 'm', severity: 'major' }),
      finding({ id: 'n', severity: 'minor' }),
      finding({ id: 'nit', severity: 'nit' }),
    ];
    expect(findingsEligibleForAutoFix(list, settings).map((f) => f.id)).toEqual(['b', 'm', 'n']);
  });

  it.each([
    ['unvalidated', 'it has not been through the checking pass, which rejects most candidates'],
    ['rejected', 'the checking pass already threw it out'],
    ['uncertain', 'the judge would not commit to it, so neither should we'],
  ])('refuses a %s finding — %s', (verdict) => {
    expect(findingsEligibleForAutoFix([finding({ verdict })], settingsWith({}))).toEqual([]);
  });

  it('refuses a finding whose location was not confirmed', () => {
    // anchorVerified false means the agent quoted code that is not at the line it
    // named — the hallucination signal. A person can weigh that against the diff
    // in a second; an unattended fix run cannot.
    expect(findingsEligibleForAutoFix([finding({ anchorVerified: false })], settingsWith({}))).toEqual(
      []
    );
  });

  it.each(['dismissed', 'fixed', 'stale', 'selected'])(
    'refuses a finding that is %s rather than open',
    (disposition) => {
      expect(findingsEligibleForAutoFix([finding({ disposition })], settingsWith({}))).toEqual([]);
    }
  );

  it('refuses a severity this build has never heard of', () => {
    // A row written by a newer build must fail the floor check rather than be
    // cast into passing it.
    expect(findingsEligibleForAutoFix([finding({ severity: 'catastrophic' })], settingsWith({}))).toEqual(
      []
    );
  });

  it('requires every condition at once, not any of them', () => {
    const list = [
      finding({ id: 'ok' }),
      finding({ id: 'unverified', anchorVerified: false }),
      finding({ id: 'unjudged', verdict: 'unvalidated' }),
      finding({ id: 'toosmall', severity: 'minor' }),
    ];
    expect(findingsEligibleForAutoFix(list, settingsWith({})).map((f) => f.id)).toEqual(['ok']);
  });
});

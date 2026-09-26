/**
 * The once-ever introduction's guards.
 *
 * Every case here is a way of showing the modal to the wrong person, and each has
 * a cheaper cost to get right than to discover: showing it to somebody outside the
 * flag's audience, showing it to somebody who saw the wizard step ninety seconds
 * ago, showing it twice, or showing it with no pull request to offer.
 */
import { describe, expect, it } from 'vitest';
import { shouldShowCodeReviewIntro } from '../hooks/useCodeReviewIntro';

const base = {
  offered: true,
  onboardingComplete: true,
  justOnboarded: false,
  openPrCount: 3,
  seen: null as string | null,
};

describe('shouldShowCodeReviewIntro', () => {
  it('shows it to an existing user who has never seen it', () => {
    expect(shouldShowCodeReviewIntro(base)).toBe(true);
  });

  it('never shows it when the feature is not offered', () => {
    // Includes the three-state `null` case, which `codeReviewOffered` resolves to
    // false: showing this and then discovering the account is outside the audience
    // is the worst version of it.
    expect(shouldShowCodeReviewIntro({ ...base, offered: false })).toBe(false);
  });

  it('waits until onboarding is done', () => {
    expect(shouldShowCodeReviewIntro({ ...base, onboardingComplete: false })).toBe(false);
  });

  it('does not follow the wizard step it duplicates', () => {
    // Somebody who just finished the wizard has already been offered this once.
    // `useWhatsNew` reads `justOnboarded` for exactly the same reason.
    expect(shouldShowCodeReviewIntro({ ...base, justOnboarded: true })).toBe(false);
  });

  it('needs a pull request of their own to offer', () => {
    // The introduction names one. An offer to review nothing is not an offer.
    expect(shouldShowCodeReviewIntro({ ...base, openPrCount: 0 })).toBe(false);
  });

  it('shows it once ever, not once per day', () => {
    // Unlike the deferred-runs announcement next door, which repeats because the
    // degradation it reports is ongoing. This has nothing new to say the second
    // time, and re-nagging is how people learn to dismiss modals unread.
    expect(shouldShowCodeReviewIntro({ ...base, seen: '1' })).toBe(false);
  });

  it('shows it again if the introduction itself is versioned forward', () => {
    // A stamp from an older version is not the current introduction, so somebody
    // who saw the old one is eligible for a materially different new one.
    expect(shouldShowCodeReviewIntro({ ...base, seen: '0' })).toBe(true);
  });
});

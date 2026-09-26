import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { v4 as uuid } from 'uuid';
import { createTestDb } from './helpers/testDb.js';
import { users as usersTable, workspaces as workspacesTable } from '../db/schema.js';

/**
 * The code review gate.
 *
 * The polarity is what is under test, and it matches `loops` rather than the
 * `workflows` gate sitting next to it in the nav: absent means OFF. A review
 * spends the workspace's own agent subscription across several sandboxes per
 * pull request, and the fix run it leads to pushes commits to a branch that may
 * not belong to whoever pressed the button. "We could not reach PostHog, so let
 * everybody review and fix" is the expensive kind of outage.
 *
 * Three gates with two different fallbacks living beside each other is why this
 * file exists: a change that collapsed them to one shared default would silently
 * flip this one on.
 */

let answer: (key: string) => boolean | undefined = () => undefined;

vi.mock('posthog-node', () => ({
  PostHog: class {
    async isFeatureEnabled(key: string) {
      return answer(key);
    }
    async shutdown() {
      /* no-op */
    }
  },
}));

const {
  codeReviewKillSwitchPulled,
  codeReviewRefusalReason,
  userMayUseCodeReview,
  workspaceMayUseCodeReview,
} = await import('../services/codeReviewAccess.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');

const SUBJECT = { distinctId: 'user-1', email: 'tom@example.com' };

describe('code review access', () => {
  let cleanup: (() => Promise<void>) | null = null;

  beforeEach(() => {
    delete process.env.CODE_REVIEW_ENABLED;
    delete process.env.TALYN_POSTHOG_KEY;
    answer = () => undefined;
    resetFeatureFlagsForTests();
  });

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
    delete process.env.CODE_REVIEW_ENABLED;
    delete process.env.TALYN_POSTHOG_KEY;
    resetFeatureFlagsForTests();
  });

  async function seed(): Promise<string> {
    const { db, cleanup: teardown } = await createTestDb();
    cleanup = teardown;
    const ownerId = uuid();
    const workspaceId = uuid();
    await db.insert(usersTable).values({ id: ownerId, email: 'tom@example.com' });
    await db.insert(workspacesTable).values({ id: workspaceId, ownerId, name: 'ws' });
    return workspaceId;
  }

  describe('the kill switch', () => {
    it.each([
      [undefined, false],
      ['', false],
      ['true', false],
      ['1', false],
      ['false', true],
      ['FALSE', true],
      [' false ', true],
      ['0', true],
      ['off', true],
      ['no', true],
    ])('CODE_REVIEW_ENABLED=%j → pulled: %s', (value, pulled) => {
      if (value === undefined) delete process.env.CODE_REVIEW_ENABLED;
      else process.env.CODE_REVIEW_ENABLED = value as string;
      expect(codeReviewKillSwitchPulled()).toBe(pulled);
    });
  });

  describe('the fallback is OFF', () => {
    it('refuses when there is no PostHog at all', async () => {
      // An unconfigured deployment must not start booting review sandboxes and
      // pushing fix commits on somebody's subscription.
      expect(await userMayUseCodeReview(SUBJECT)).toBe(false);
    });

    it('refuses when PostHog has never heard of the flag', async () => {
      // A flag nobody created, or one somebody deleted, answers `undefined` —
      // which is the fallback, not `false` by accident.
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      resetFeatureFlagsForTests();
      answer = () => undefined;
      expect(await userMayUseCodeReview(SUBJECT)).toBe(false);
    });

    it('allows an account PostHog includes', async () => {
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      resetFeatureFlagsForTests();
      answer = (key) => key === 'code-review';
      expect(await userMayUseCodeReview(SUBJECT)).toBe(true);
    });

    it('refuses an account PostHog excludes', async () => {
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      resetFeatureFlagsForTests();
      answer = () => false;
      expect(await userMayUseCodeReview(SUBJECT)).toBe(false);
    });
  });

  describe('the env override wins both ways', () => {
    it('CODE_REVIEW_ENABLED=true runs with no PostHog — the local-dev path', async () => {
      // Deliberately unlike `mcpServers`, which has no override at all: a
      // contributor with no PostHog project has to be able to develop this.
      process.env.CODE_REVIEW_ENABLED = 'true';
      expect(await userMayUseCodeReview(SUBJECT)).toBe(true);
    });

    it('CODE_REVIEW_ENABLED=false beats a PostHog yes — the break glass', async () => {
      // The override short-circuits rather than outvotes, because break glass
      // has to work when PostHog is the broken thing.
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      process.env.CODE_REVIEW_ENABLED = 'false';
      resetFeatureFlagsForTests();
      answer = () => true;
      expect(await userMayUseCodeReview(SUBJECT)).toBe(false);
    });
  });

  describe('workspaceMayUseCodeReview', () => {
    it('is keyed on the workspace OWNER, not on a caller', async () => {
      // An automatic review has no caller — it is a webhook or a sweep — so the
      // owner is the one identity every cycle provably has.
      const workspaceId = await seed();
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      resetFeatureFlagsForTests();
      answer = (key) => key === 'code-review';
      expect(await workspaceMayUseCodeReview(workspaceId)).toBe(true);

      resetFeatureFlagsForTests();
      answer = () => false;
      expect(await workspaceMayUseCodeReview(workspaceId)).toBe(false);
    });
  });

  describe('the refusal reason', () => {
    it('names the break glass when it is pulled', () => {
      process.env.CODE_REVIEW_ENABLED = 'false';
      expect(codeReviewRefusalReason()).toContain('CODE_REVIEW_ENABLED=false');
    });

    it('distinguishes "we could not ask" from "you are not in the audience"', () => {
      // A third case `workflows` does not have, because this flag fails closed:
      // an unreachable PostHog genuinely produces a refusal, and telling
      // somebody they are outside the audience sends them to the wrong
      // dashboard.
      expect(codeReviewRefusalReason()).toContain('no PostHog key');
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      expect(codeReviewRefusalReason()).toContain('audience');
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { v4 as uuid } from 'uuid';
import { createTestDb } from './helpers/testDb.js';
import { users as usersTable, workspaces as workspacesTable } from '../db/schema.js';

/**
 * The code review gate.
 *
 * Two things are under test and they are separate claims.
 *
 * THE POLARITY: absent means OFF, matching `loops` and `mcpServers` rather than
 * the `workflows` gate sitting next to it in the nav. A review spends the
 * workspace's own agent subscription across several sandboxes per pull request,
 * and the fix run it leads to pushes commits to a branch that may not belong to
 * whoever pressed the button. "We could not reach PostHog, so let everybody
 * review and fix" is the expensive kind of outage. Four gates with two different
 * fallbacks living beside each other is why this matters: a change that collapsed
 * them to one shared default would silently flip this one on.
 *
 * THERE IS NO ENV OVERRIDE: PostHog's audience is the only way in. That is a
 * stronger claim than the polarity and needs its own cases, because the override
 * on the other three flags SHORT-CIRCUITS PostHog and is read generously — so one
 * variable set in production would have handed this to everybody.
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

const { codeReviewRefusalReason, userMayUseCodeReview, workspaceMayUseCodeReview } =
  await import('../services/codeReviewAccess.js');
const { readFlagOverride } = await import('@talyn/shared');
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

  describe('there is no env override at all', () => {
    // The `mcpServers` posture, and the reason is sharper here: an override is read
    // GENEROUSLY (anything but false/0/off/no reads as on) and it SHORT-CIRCUITS
    // PostHog — so one env var set in production would hand a feature that pushes
    // commits to other people's branches to every account at once.
    it.each(['true', '1', 'yes', 'false', '0', 'off', ''])(
      'CODE_REVIEW_ENABLED=%j is not read at all',
      (value) => {
        process.env.CODE_REVIEW_ENABLED = value;
        expect(readFlagOverride('codeReview', process.env)).toBeUndefined();
      }
    );

    it('proves the assertion can fail: a flag that HAS an override reads it', () => {
      // Guards the cases above. Without this they would pass just as happily if
      // `readFlagOverride` were broken for every flag.
      process.env.LOOPS_ENABLED = 'false';
      expect(readFlagOverride('loops', process.env)).toBe(false);
      delete process.env.LOOPS_ENABLED;
    });

    it('cannot be switched ON by the environment, whatever PostHog says', async () => {
      // The whole point of dropping it: no env var grants access.
      process.env.CODE_REVIEW_ENABLED = 'true';
      expect(await userMayUseCodeReview(SUBJECT)).toBe(false);
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

  describe('PostHog is the only way in', () => {
    it('an env var cannot switch it off either, so PostHog stays authoritative', async () => {
      // The cost of having no break glass, asserted rather than assumed: with
      // PostHog saying yes, nothing in the environment can say no.
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      process.env.CODE_REVIEW_ENABLED = 'false';
      resetFeatureFlagsForTests();
      answer = (key) => key === 'code-review';
      expect(await userMayUseCodeReview(SUBJECT)).toBe(true);
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
    it('distinguishes "we could not ask" from "you are not in the audience"', () => {
      // Telling somebody they are outside the audience when the real answer is
      // "we could not ask PostHog" sends them to the wrong dashboard.
      expect(codeReviewRefusalReason()).toContain('no PostHog key');
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      expect(codeReviewRefusalReason()).toContain('audience');
    });

    it('never offers a switch that does not exist', () => {
      // Its siblings can say "set X=true to use it anyway". This one cannot, so it
      // must not imply one — that is a person sent looking for an env var for an
      // afternoon.
      expect(codeReviewRefusalReason()).not.toContain('CODE_REVIEW_ENABLED');
      expect(codeReviewRefusalReason()).toContain('PostHog alone');
    });
  });
});

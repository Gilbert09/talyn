import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { v4 as uuid } from 'uuid';
import { createTestDb } from './helpers/testDb.js';
import { users as usersTable, workspaces as workspacesTable } from '../db/schema.js';

/**
 * The Loops gate.
 *
 * The polarity is what is under test, and it is the OPPOSITE of the workflows
 * gate sitting next to it: absent means OFF. A loop creates paid cloud tasks on
 * a timer with nobody watching, so "we could not reach PostHog, start every
 * scheduler" is not a safe default — it spends the workspace's money before
 * anybody is awake to see it.
 *
 * The two gates living side by side with opposite fallbacks is exactly why this
 * file exists: a change that collapsed them to one default would silently flip
 * this one on.
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

const { loopsKillSwitchPulled, loopsRefusalReason, userMayUseLoops, workspaceMayUseLoops } =
  await import('../services/loopsAccess.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');

const SUBJECT = { distinctId: 'user-1', email: 'tom@example.com' };

describe('loops access', () => {
  let cleanup: (() => Promise<void>) | null = null;

  beforeEach(() => {
    delete process.env.LOOPS_ENABLED;
    delete process.env.TALYN_POSTHOG_KEY;
    answer = () => undefined;
    resetFeatureFlagsForTests();
  });

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
    delete process.env.LOOPS_ENABLED;
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
    ])('LOOPS_ENABLED=%j → pulled: %s', (value, pulled) => {
      if (value === undefined) delete process.env.LOOPS_ENABLED;
      else process.env.LOOPS_ENABLED = value as string;
      expect(loopsKillSwitchPulled()).toBe(pulled);
    });
  });

  describe('the fallback is OFF', () => {
    it('refuses when there is no PostHog at all', async () => {
      // The difference from workflows, and the whole point. An unconfigured
      // deployment must not start dispatching paid tasks on a schedule.
      expect(await userMayUseLoops(SUBJECT)).toBe(false);
    });

    it('refuses when PostHog has never heard of the flag', async () => {
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      resetFeatureFlagsForTests();
      answer = () => undefined;
      expect(await userMayUseLoops(SUBJECT)).toBe(false);
    });

    it('allows an account PostHog includes', async () => {
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      resetFeatureFlagsForTests();
      answer = (key) => key === 'loops';
      expect(await userMayUseLoops(SUBJECT)).toBe(true);
    });

    it('refuses an account PostHog excludes', async () => {
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      resetFeatureFlagsForTests();
      answer = () => false;
      expect(await userMayUseLoops(SUBJECT)).toBe(false);
    });
  });

  describe('the env override wins both ways', () => {
    it('LOOPS_ENABLED=true runs loops with no PostHog — the local-dev path', async () => {
      process.env.LOOPS_ENABLED = 'true';
      expect(await userMayUseLoops(SUBJECT)).toBe(true);
    });

    it('LOOPS_ENABLED=false beats a PostHog yes — the break glass', async () => {
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      process.env.LOOPS_ENABLED = 'false';
      resetFeatureFlagsForTests();
      answer = () => true;
      expect(await userMayUseLoops(SUBJECT)).toBe(false);
    });
  });

  describe('workspaceMayUseLoops', () => {
    it('is keyed on the workspace OWNER, not on a caller', async () => {
      // A firing has no caller — it is the clock — so the owner is the one
      // identity every run provably has.
      const workspaceId = await seed();
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      resetFeatureFlagsForTests();
      answer = (key) => key === 'loops';
      expect(await workspaceMayUseLoops(workspaceId)).toBe(true);

      resetFeatureFlagsForTests();
      answer = () => false;
      expect(await workspaceMayUseLoops(workspaceId)).toBe(false);
    });
  });

  describe('the refusal reason', () => {
    it('names the break glass when it is pulled', () => {
      process.env.LOOPS_ENABLED = 'false';
      expect(loopsRefusalReason()).toContain('LOOPS_ENABLED=false');
    });

    it('distinguishes "we could not ask" from "you are not in the audience"', () => {
      // A third case workflows does not have, because this flag fails closed:
      // an unreachable PostHog genuinely produces a refusal, and telling
      // somebody they are outside the audience sends them to the wrong place.
      expect(loopsRefusalReason()).toContain('no PostHog key');
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      expect(loopsRefusalReason()).toContain('audience');
    });
  });
});

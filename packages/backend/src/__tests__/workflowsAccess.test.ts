import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { v4 as uuid } from 'uuid';
import { createTestDb } from './helpers/testDb.js';
import { users as usersTable, workspaces as workspacesTable } from '../db/schema.js';

/**
 * The workflows gate, now that its audience is the `workflows` PostHog flag.
 *
 * The polarity is the thing under test and it did NOT change: absent means ON.
 * Workflows is a released feature, so a deployment with no PostHog key, a
 * developer's local backend and a PostHog outage must all keep serving it
 * rather than hiding a page that exists.
 *
 * What PostHog added is the ability to take it away from ONE account — the
 * question the old global boolean could not express, and the reason the gate
 * became per-workspace again.
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

const { workflowsKillSwitchPulled, workflowsRefusalReason, userMayUseWorkflows, workspaceMayUseWorkflows } =
  await import('../services/workflowsAccess.js');
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');

const SUBJECT = { distinctId: 'user-1', email: 'tom@example.com' };

describe('workflows access', () => {
  let cleanup: (() => Promise<void>) | null = null;

  beforeEach(() => {
    delete process.env.WORKFLOWS_ENABLED;
    delete process.env.TALYN_POSTHOG_KEY;
    answer = () => undefined;
    resetFeatureFlagsForTests();
  });

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
    delete process.env.WORKFLOWS_ENABLED;
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
      ['yes', false],
      ['false', true],
      ['FALSE', true],
      [' false ', true],
      ['0', true],
      ['off', true],
      ['no', true],
    ])('WORKFLOWS_ENABLED=%j → pulled: %s', (value, pulled) => {
      if (value === undefined) delete process.env.WORKFLOWS_ENABLED;
      else process.env.WORKFLOWS_ENABLED = value as string;
      expect(workflowsKillSwitchPulled()).toBe(pulled);
    });

    it('reads a typo as NOT pulled', () => {
      // The safer failure for a kill switch: "it stopped working and nobody
      // knows why" is much harder to notice than the thing you were trying to
      // stop.
      process.env.WORKFLOWS_ENABLED = 'flase';
      expect(workflowsKillSwitchPulled()).toBe(false);
    });
  });

  describe('userMayUseWorkflows', () => {
    it('is ON for a deployment with no PostHog at all', async () => {
      // Local development and CI have no project key, and a developer should
      // not have to acquire one to see a page that exists.
      expect(await userMayUseWorkflows(SUBJECT)).toBe(true);
    });

    it('is ON when PostHog has never heard of the flag', async () => {
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      resetFeatureFlagsForTests();
      answer = () => undefined;
      // A deleted flag must not read as an outage for a shipped feature.
      expect(await userMayUseWorkflows(SUBJECT)).toBe(true);
    });

    it('is OFF for an account PostHog excludes from the flag', async () => {
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      resetFeatureFlagsForTests();
      answer = () => false;
      // The case the old global boolean could not express.
      expect(await userMayUseWorkflows(SUBJECT)).toBe(false);
    });

    it('is OFF when the kill switch is pulled, whatever PostHog says', async () => {
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      process.env.WORKFLOWS_ENABLED = 'false';
      resetFeatureFlagsForTests();
      answer = () => true;
      // Break glass has to work when PostHog is the broken thing.
      expect(await userMayUseWorkflows(SUBJECT)).toBe(false);
    });
  });

  describe('workspaceMayUseWorkflows', () => {
    it('is ON by default for a real workspace', async () => {
      const ws = await seed();
      expect(await workspaceMayUseWorkflows(ws)).toBe(true);
    });

    it('is OFF when the kill switch is pulled', async () => {
      const ws = await seed();
      process.env.WORKFLOWS_ENABLED = 'false';
      expect(await workspaceMayUseWorkflows(ws)).toBe(false);
    });

    it('is ON for a workspace that has gone, rather than throwing', async () => {
      await seed();
      // The engine calls this per delivery. A deleted workspace mid-flight must
      // not take out the delivery's PR refresh, and for a released feature the
      // safe answer to "I cannot identify the owner" is the fallback.
      expect(await workspaceMayUseWorkflows(uuid())).toBe(true);
    });

    it('asks per workspace, so one account can be switched off alone', async () => {
      const ws = await seed();
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      resetFeatureFlagsForTests();
      answer = () => false;
      expect(await workspaceMayUseWorkflows(ws)).toBe(false);
    });
  });

  describe('workflowsRefusalReason', () => {
    it('distinguishes "somebody pulled the switch" from "not in the audience"', () => {
      delete process.env.WORKFLOWS_ENABLED;
      const notInAudience = workflowsRefusalReason();

      process.env.WORKFLOWS_ENABLED = 'false';
      const switchPulled = workflowsRefusalReason();

      expect(switchPulled).toMatch(/WORKFLOWS_ENABLED=false/);
      expect(notInAudience).not.toMatch(/WORKFLOWS_ENABLED/);
      expect(notInAudience).not.toBe(switchPulled);
    });
  });
});

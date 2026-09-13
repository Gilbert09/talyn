import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { v4 as uuid } from 'uuid';
import { createTestDb } from './helpers/testDb.js';
import { users as usersTable, workspaces as workspacesTable } from '../db/schema.js';

/**
 * The fleet gate, now that its audience is the `talyn-fleet` PostHog flag.
 *
 * Every test here asserts a REFUSAL as well as an acceptance. A gate that only
 * has a passing case is the shape of the billing `clientGate` bug this codebase
 * already paid for: it read as opt-in, so the CLI, the MCP server and plain
 * curl all bypassed the paywall with no error, no log and no metric. The
 * question is never "does it let the right person through" — it is "can it be
 * seen to stop the wrong one".
 *
 * What moving to PostHog changed is WHERE the wrong answer could come from. It
 * used to be a mis-parsed env string; it is now an unreachable flag service,
 * which is why the failure cases below matter more than the passing one.
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

const { fleetRefusalReason, workspaceMayUseFleet } = await import(
  '../services/cloudProviders/fleetAccess.js'
);
const { resetFeatureFlagsForTests } = await import('../services/featureFlags.js');

describe('fleet access', () => {
  let cleanup: (() => Promise<void>) | null = null;

  beforeEach(() => {
    delete process.env.FLEET_ALLOWED;
    delete process.env.TALYN_POSTHOG_KEY;
    answer = () => undefined;
    resetFeatureFlagsForTests();
  });

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
    delete process.env.FLEET_ALLOWED;
    delete process.env.TALYN_POSTHOG_KEY;
    resetFeatureFlagsForTests();
  });

  async function seed(ownerEmail: string): Promise<string> {
    const { db, cleanup: teardown } = await createTestDb();
    cleanup = teardown;
    const ownerId = uuid();
    const workspaceId = uuid();
    await db.insert(usersTable).values({ id: ownerId, email: ownerEmail });
    await db.insert(workspacesTable).values({ id: workspaceId, ownerId, name: 'ws' });
    return workspaceId;
  }

  describe('workspaceMayUseFleet', () => {
    it('lets NOBODY through when PostHog is not configured', async () => {
      const ws = await seed('tom@example.com');
      // The one that matters. An unconfigured flag service meaning "everyone"
      // is the inverse of this gate's whole purpose, and it is the default a
      // careless implementation lands on.
      expect(await workspaceMayUseFleet(ws)).toBe(false);
    });

    it('lets nobody through when PostHog does not know the flag', async () => {
      const ws = await seed('tom@example.com');
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      resetFeatureFlagsForTests();
      answer = () => undefined; // flag deleted, or never created
      expect(await workspaceMayUseFleet(ws)).toBe(false);
    });

    it('allows a workspace whose owner is in the audience, and refuses one who is not', async () => {
      const ws = await seed('tom@example.com');
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      resetFeatureFlagsForTests();

      answer = () => true;
      expect(await workspaceMayUseFleet(ws)).toBe(true);

      // Same database, same workspace, a flag that now says no.
      answer = () => false;
      resetFeatureFlagsForTests(); // drop the 30s decision cache
      expect(await workspaceMayUseFleet(ws)).toBe(false);
    });

    it('refuses a workspace that does not exist', async () => {
      await seed('tom@example.com');
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      resetFeatureFlagsForTests();
      answer = () => true;
      // An unknown workspace id must not resolve to "allowed" through an empty
      // join result — which is exactly what a truthy check on rows[0] would do
      // if it were written the other way round.
      expect(await workspaceMayUseFleet(uuid())).toBe(false);
    });

    it('FLEET_ALLOWED=false takes it away from everybody, whatever PostHog says', async () => {
      const ws = await seed('tom@example.com');
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      process.env.FLEET_ALLOWED = 'false';
      resetFeatureFlagsForTests();
      answer = () => true;
      // Break glass: the fleet is one box, and taking it away must not wait on
      // a flag save propagating.
      expect(await workspaceMayUseFleet(ws)).toBe(false);
    });

    it('FLEET_ALLOWED=true opens it without PostHog, for local development', async () => {
      const ws = await seed('tom@example.com');
      expect(await workspaceMayUseFleet(ws)).toBe(false); // the baseline this case moves off
      process.env.FLEET_ALLOWED = 'true';
      expect(await workspaceMayUseFleet(ws)).toBe(true);
    });
  });

  describe('fleetRefusalReason', () => {
    it('distinguishes "somebody pulled the switch" from "you are not in the audience"', () => {
      delete process.env.FLEET_ALLOWED;
      const notInAudience = fleetRefusalReason();

      process.env.FLEET_ALLOWED = 'false';
      const switchPulled = fleetRefusalReason();

      expect(switchPulled).toContain('FLEET_ALLOWED');
      expect(notInAudience).not.toContain('FLEET_ALLOWED=false');
      // One is a deployment decision, the other is working as intended.
      // Reading either as the other is an hour of debugging.
      expect(notInAudience).not.toBe(switchPulled);
    });
  });
});

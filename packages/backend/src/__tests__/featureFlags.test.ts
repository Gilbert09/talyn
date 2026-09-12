import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { v4 as uuid } from 'uuid';
import { FEATURE_FLAGS, readFlagOverride, type FeatureFlagKey } from '@talyn/shared';
import { createTestDb } from './helpers/testDb.js';
import { users as usersTable, workspaces as workspacesTable } from '../db/schema.js';

/**
 * Feature flags, now that PostHog owns the audience.
 *
 * The thing under test is the PRECEDENCE, not PostHog. PostHog's own evaluator
 * is not ours to verify; what is ours is the three-layer answer — env override,
 * then PostHog, then the flag's own fallback — and the two places it can go
 * quietly wrong:
 *
 *  - **A shared default.** `workflows` fails OPEN and `fleet` fails CLOSED. One
 *    default for both silently flips whichever it does not describe, and the
 *    one it would flip is the one that spends money on hardware we own.
 *  - **An unknown key reading as `false`.** PostHog answers `undefined` for a
 *    flag nobody has created yet, or one somebody deleted. Treating that as
 *    "disabled" turns a deleted flag into an outage for a released feature —
 *    and, in the other direction, would be the only case where deleting
 *    something makes the fleet MORE available.
 *
 * Every case below asserts a refusal as well as an acceptance, for the reason
 * the fleet gate has always carried: a gate with only a passing case is the
 * shape of the billing `clientGate` bug this codebase already paid for.
 */

// A stand-in for posthog-node. `isFeatureEnabled` is programmable per test, and
// every construction is recorded so the "is it configured for local
// evaluation" question can be asserted rather than assumed.
const posthogCalls: Array<{
  key: string;
  distinctId: string;
  options?: { personProperties?: Record<string, string>; onlyEvaluateLocally?: boolean };
}> = [];
const constructions: Array<{ apiKey: string; options: Record<string, unknown> }> = [];
let answer: (key: string) => boolean | undefined | Promise<boolean | undefined> = () => undefined;

vi.mock('posthog-node', () => ({
  PostHog: class {
    constructor(apiKey: string, options: Record<string, unknown>) {
      constructions.push({ apiKey, options });
    }
    async isFeatureEnabled(key: string, distinctId: string, options?: never) {
      posthogCalls.push({ key, distinctId, options });
      return answer(key);
    }
    async shutdown() {
      /* no-op */
    }
  },
}));

const {
  evaluateFlag,
  featuresForUser,
  isFeatureEnabled,
  featureFlagsEvaluateLocally,
  isFeatureFlagServiceConfigured,
  resetFeatureFlagsForTests,
  workspaceFlagSubject,
  workspaceHasFeature,
} = await import('../services/featureFlags.js');

const SUBJECT = { distinctId: 'user-1', email: 'tom@example.com' };

/** Every env var the service reads, so no case leaks into the next. */
const ENV_KEYS = [
  'TALYN_POSTHOG_KEY',
  'TALYN_POSTHOG_PERSONAL_API_KEY',
  'TALYN_POSTHOG_HOST',
  ...Object.values(FEATURE_FLAGS).map((f) => f.envOverride),
];

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

beforeEach(() => {
  clearEnv();
  posthogCalls.length = 0;
  constructions.length = 0;
  answer = () => undefined;
  resetFeatureFlagsForTests();
});

afterEach(() => {
  clearEnv();
  resetFeatureFlagsForTests();
});

describe('readFlagOverride', () => {
  it.each([
    ['unset', undefined, undefined],
    ['empty', '', undefined],
    ['whitespace only', '   ', undefined],
    ['false', 'false', false],
    ['FALSE', 'FALSE', false],
    [' false ', ' false ', false],
    ['0', '0', false],
    ['off', 'off', false],
    ['no', 'no', false],
    ['true', 'true', true],
    ['1', '1', true],
    ['on', 'on', true],
  ])('%s → %j', (_name, value, expected) => {
    const env: Record<string, string | undefined> = {};
    if (value !== undefined) env[FEATURE_FLAGS.workflows.envOverride] = value;
    expect(readFlagOverride('workflows', env)).toBe(expected);
  });

  it('reads a typo as ON, not as unset and not as off', () => {
    // The asymmetry is the point. These overrides exist to stop a feature in a
    // hurry: a typo that leaves it on is noticed in seconds, while a typo that
    // turns it off looks exactly like the outage being debugged.
    const env = { [FEATURE_FLAGS.workflows.envOverride]: 'flase' };
    expect(readFlagOverride('workflows', env)).toBe(true);
  });

  it('gives each flag its own variable', () => {
    const env = { [FEATURE_FLAGS.fleet.envOverride]: 'false' };
    expect(readFlagOverride('fleet', env)).toBe(false);
    // One flag's switch must not move another's — they have opposite
    // polarities, so a shared variable would be actively misleading.
    expect(readFlagOverride('workflows', env)).toBeUndefined();
  });
});

describe('the fallback layer (no PostHog configured)', () => {
  it('reports itself as unconfigured', () => {
    expect(isFeatureFlagServiceConfigured()).toBe(false);
    expect(featureFlagsEvaluateLocally()).toBe(false);
  });

  it.each([
    ['workflows', true],
    ['fleet', false],
  ] as Array<[FeatureFlagKey, boolean]>)(
    '%s answers its own fallback (%s), not a shared default',
    async (flag, expected) => {
      const decision = await evaluateFlag(flag, SUBJECT);
      expect(decision).toEqual({ enabled: expected, source: 'fallback' });
    }
  );

  it('never asks PostHog', async () => {
    await evaluateFlag('fleet', SUBJECT);
    expect(posthogCalls).toHaveLength(0);
  });
});

describe('the env override layer', () => {
  beforeEach(() => {
    process.env.TALYN_POSTHOG_KEY = 'phc_test';
    resetFeatureFlagsForTests();
    answer = () => true; // PostHog would say yes to everything
  });

  it.each([
    ['workflows', 'false', false],
    ['workflows', 'true', true],
    ['fleet', 'false', false],
    ['fleet', 'true', true],
  ] as Array<[FeatureFlagKey, string, boolean]>)(
    '%s with %s wins over PostHog',
    async (flag, value, expected) => {
      process.env[FEATURE_FLAGS[flag].envOverride] = value;
      const decision = await evaluateFlag(flag, SUBJECT);
      expect(decision).toEqual({ enabled: expected, source: 'env' });
      // The break-glass switch has to work when PostHog is the thing that is
      // broken, so it must short-circuit rather than merely outvote.
      expect(posthogCalls).toHaveLength(0);
    }
  );

  it('turns the fleet off for everybody even while PostHog says yes', async () => {
    process.env.FLEET_ALLOWED = 'false';
    expect(await isFeatureEnabled('fleet', SUBJECT)).toBe(false);
  });
});

describe('the PostHog layer', () => {
  beforeEach(() => {
    process.env.TALYN_POSTHOG_KEY = 'phc_test';
    resetFeatureFlagsForTests();
  });

  it('asks for the flag under its PostHog key, not its TypeScript key', async () => {
    answer = () => true;
    await evaluateFlag('fleet', SUBJECT);
    expect(posthogCalls[0].key).toBe('talyn-fleet');
    expect(posthogCalls[0].key).not.toBe('fleet');
  });

  it('passes the email as a person property', async () => {
    answer = () => true;
    await evaluateFlag('fleet', SUBJECT);
    // This is what lets a release condition say "these five people" — the
    // literal job FLEET_ALLOWED_EMAILS used to do. Local evaluation can only
    // match properties we hand it, so an omitted email silently empties the
    // audience.
    expect(posthogCalls[0].options?.personProperties).toEqual({ email: 'tom@example.com' });
  });

  it('omits person properties entirely when there is no email', async () => {
    answer = () => true;
    await evaluateFlag('fleet', { distinctId: 'user-2' });
    expect(posthogCalls[0].options?.personProperties).toBeUndefined();
  });

  it.each([
    ['workflows', true],
    ['fleet', false],
  ] as Array<[FeatureFlagKey, boolean]>)(
    'an unknown %s flag falls back to %s rather than to false',
    async (flag, expected) => {
      answer = () => undefined; // PostHog does not know this key
      const decision = await evaluateFlag(flag, SUBJECT);
      expect(decision).toEqual({ enabled: expected, source: 'fallback' });
    }
  );

  it.each([
    ['workflows', true],
    ['fleet', false],
  ] as Array<[FeatureFlagKey, boolean]>)(
    'a thrown evaluation leaves %s at %s instead of propagating',
    async (flag, expected) => {
      answer = () => {
        throw new Error('posthog is down');
      };
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      // The caller is the webhook worker. A gate that rejects on a PostHog blip
      // costs the delivery the PR refresh it was really about.
      await expect(evaluateFlag(flag, SUBJECT)).resolves.toEqual({
        enabled: expected,
        source: 'fallback',
      });
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    }
  );

  it('falls back rather than asking PostHog about an empty distinct id', async () => {
    answer = () => true;
    const decision = await evaluateFlag('fleet', { distinctId: '', email: 'tom@example.com' });
    expect(decision).toEqual({ enabled: false, source: 'fallback' });
    expect(posthogCalls).toHaveLength(0);
  });

  it('answers different people differently', async () => {
    answer = () => true;
    const seen: string[] = [];
    answer = (key) => {
      seen.push(key);
      return true;
    };
    await evaluateFlag('fleet', { distinctId: 'a', email: 'a@x.com' });
    await evaluateFlag('fleet', { distinctId: 'b', email: 'b@x.com' });
    // Two distinct ids means two evaluations — the per-account rollout that an
    // env allow-list could never express.
    expect(posthogCalls.map((c) => c.distinctId)).toEqual(['a', 'b']);
  });
});

describe('remote vs local evaluation', () => {
  it('without a personal API key, evaluates remotely and caches the decision', async () => {
    process.env.TALYN_POSTHOG_KEY = 'phc_test';
    resetFeatureFlagsForTests();
    answer = () => true;

    expect(featureFlagsEvaluateLocally()).toBe(false);
    expect(constructions).toHaveLength(0);
    await evaluateFlag('fleet', SUBJECT);
    expect(constructions[0].options.enableLocalEvaluation).toBe(false);
    expect(posthogCalls[0].options?.onlyEvaluateLocally).toBe(false);

    // The cache is the whole reason remote mode is tolerable: the workflows
    // gate runs once per webhook delivery per watching workspace, and one HTTP
    // round trip each would be far worse than the `users` join the engine
    // already dropped from that path.
    await evaluateFlag('fleet', SUBJECT);
    await evaluateFlag('fleet', SUBJECT);
    expect(posthogCalls).toHaveLength(1);
  });

  it('caches the FAILURE too, so an outage is not one round trip per delivery', async () => {
    process.env.TALYN_POSTHOG_KEY = 'phc_test';
    resetFeatureFlagsForTests();
    answer = () => {
      throw new Error('posthog is down');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await evaluateFlag('fleet', SUBJECT)).toEqual({ enabled: false, source: 'fallback' });
    // Without this, a PostHog outage adds a failing round trip — with the SDK's
    // own retries behind it — to every webhook delivery, turning a flag-service
    // problem into a webhook backlog.
    await evaluateFlag('fleet', SUBJECT);
    await evaluateFlag('fleet', SUBJECT);
    expect(posthogCalls).toHaveLength(1);
    warn.mockRestore();
  });

  it('reports a cached failure as a fallback, not as a PostHog answer', async () => {
    process.env.TALYN_POSTHOG_KEY = 'phc_test';
    resetFeatureFlagsForTests();
    answer = () => {
      throw new Error('posthog is down');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await evaluateFlag('fleet', SUBJECT);
    // Assuming the cached source is `posthog` would put the wrong sentence in
    // every refusal message for the whole TTL.
    expect(await evaluateFlag('fleet', SUBJECT)).toEqual({ enabled: false, source: 'fallback' });
    warn.mockRestore();
  });

  it('caches per flag and per person, not globally', async () => {
    process.env.TALYN_POSTHOG_KEY = 'phc_test';
    resetFeatureFlagsForTests();
    answer = (key) => key === 'talyn-fleet';

    expect(await isFeatureEnabled('fleet', SUBJECT)).toBe(true);
    // A cache keyed on the flag alone would hand this person the other flag's
    // answer — here that would turn `workflows` on for somebody PostHog just
    // said no to — and a cache keyed on the person alone would hand the next
    // person this one's.
    expect(await isFeatureEnabled('workflows', SUBJECT)).toBe(false);
    expect(await isFeatureEnabled('fleet', { distinctId: 'other' })).toBe(true);
    expect(posthogCalls).toHaveLength(3);
  });

  it('with a personal API key, evaluates locally and does not cache', async () => {
    process.env.TALYN_POSTHOG_KEY = 'phc_test';
    process.env.TALYN_POSTHOG_PERSONAL_API_KEY = 'phx_test';
    resetFeatureFlagsForTests();
    answer = () => true;

    expect(featureFlagsEvaluateLocally()).toBe(true);
    await evaluateFlag('fleet', SUBJECT);
    expect(constructions[0].options.enableLocalEvaluation).toBe(true);
    expect(constructions[0].options.personalApiKey).toBe('phx_test');
    expect(posthogCalls[0].options?.onlyEvaluateLocally).toBe(true);

    // In-process evaluation is already sub-millisecond, so a cache would only
    // add staleness. Every call is a fresh answer.
    await evaluateFlag('fleet', SUBJECT);
    expect(posthogCalls).toHaveLength(2);
  });
});

describe('workspace subjects', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  async function seed(ownerEmail: string): Promise<{ workspaceId: string; ownerId: string }> {
    const { db, cleanup: teardown } = await createTestDb();
    cleanup = teardown;
    const ownerId = uuid();
    const workspaceId = uuid();
    await db.insert(usersTable).values({ id: ownerId, email: ownerEmail });
    await db.insert(workspacesTable).values({ id: workspaceId, ownerId, name: 'ws' });
    return { workspaceId, ownerId };
  }

  it('resolves a workspace to its OWNER, not to whoever is calling', async () => {
    const { workspaceId, ownerId } = await seed('owner@example.com');
    // A task can be dispatched by a webhook, the poller or a sweep — none of
    // which has a user attached. The owner is the one identity every workspace
    // provably has.
    expect(await workspaceFlagSubject(workspaceId)).toEqual({
      distinctId: ownerId,
      email: 'owner@example.com',
    });
  });

  it('returns null for a workspace that does not exist', async () => {
    await seed('owner@example.com');
    expect(await workspaceFlagSubject(uuid())).toBeNull();
  });

  it('caches the lookup so a poll loop does not re-join per tick', async () => {
    const { workspaceId } = await seed('owner@example.com');
    const first = await workspaceFlagSubject(workspaceId);
    const second = await workspaceFlagSubject(workspaceId);
    expect(second).toBe(first); // identity, so it is the cached object
  });

  it.each([
    ['workflows', true],
    ['fleet', false],
  ] as Array<[FeatureFlagKey, boolean]>)(
    'an unknown workspace leaves %s at its fallback (%s)',
    async (flag, expected) => {
      await seed('owner@example.com');
      process.env.TALYN_POSTHOG_KEY = 'phc_test';
      resetFeatureFlagsForTests();
      answer = () => true;

      // The one that matters for the fleet: an unknown workspace id must not
      // resolve to "allowed" through an empty join result.
      expect(await workspaceHasFeature(flag, uuid())).toEqual({
        enabled: expected,
        source: 'fallback',
      });
      expect(posthogCalls).toHaveLength(0);
    }
  );

  it('lets the env override answer even when the workspace is gone', async () => {
    await seed('owner@example.com');
    process.env.FLEET_ALLOWED = 'true';
    // Break glass has to work in both directions, including for rows that have
    // been deleted underneath a queued task.
    expect(await workspaceHasFeature('fleet', uuid())).toEqual({ enabled: true, source: 'env' });
  });

  it('evaluates the flag against the owner it resolved', async () => {
    const { workspaceId, ownerId } = await seed('owner@example.com');
    process.env.TALYN_POSTHOG_KEY = 'phc_test';
    resetFeatureFlagsForTests();
    answer = () => true;

    expect(await workspaceHasFeature('fleet', workspaceId)).toEqual({
      enabled: true,
      source: 'posthog',
    });
    expect(posthogCalls[0].distinctId).toBe(ownerId);
    expect(posthogCalls[0].options?.personProperties).toEqual({ email: 'owner@example.com' });
  });
});

describe('featuresForUser', () => {
  it('answers only the account-scoped flags', async () => {
    const features = await featuresForUser(SUBJECT);
    // `fleet` is keyed on the workspace OWNER, who is not always the caller, so
    // an account-scoped answer would be wrong for every member of somebody
    // else's workspace.
    expect(Object.keys(features)).toEqual(['workflows']);
  });

  it('reflects the kill switch, so the UI stops drawing what the routes refuse', async () => {
    process.env.WORKFLOWS_ENABLED = 'false';
    expect(await featuresForUser(SUBJECT)).toEqual({ workflows: false });
  });

  it('defaults workflows on for a deployment with no PostHog at all', async () => {
    expect(await featuresForUser(SUBJECT)).toEqual({ workflows: true });
  });
});

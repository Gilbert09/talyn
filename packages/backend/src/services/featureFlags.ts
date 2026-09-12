import type { PostHog } from 'posthog-node';
import {
  ACCOUNT_FEATURE_FLAGS,
  FEATURE_FLAGS,
  readFlagOverride,
  type FeatureFlagKey,
  type Features,
} from '@talyn/shared';
import { eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import { users as usersTable, workspaces as workspacesTable } from '../db/schema.js';
import { debugBus } from './debugBus.js';

/**
 * Feature flag evaluation, backed by PostHog.
 *
 * The register of flags — their keys, their env overrides, their fallbacks and
 * the reasoning for all three — lives in `@talyn/shared`'s `featureFlags.ts`,
 * because both front ends need the same names. This file is the backend half:
 * the PostHog client, the precedence rule, and the subject resolution that
 * turns a workspace id into somebody PostHog can evaluate against.
 *
 * # Precedence, in order
 *
 *  1. **The env override**, if the var is set to anything. Break glass, and the
 *     only answer local development and CI ever get.
 *  2. **PostHog**, when a project key is configured and the flag is known.
 *  3. **The flag's `fallback`**, for everything else — no key, an unreachable
 *     PostHog, or a key PostHog has never heard of.
 *
 * Step 3 is why `fallback` is per-flag rather than a single default: `fleet`
 * fails closed and `workflows` fails open, and one shared default would flip
 * whichever of them it did not describe.
 *
 * # Local evaluation is the point, not an optimisation
 *
 * Set `TALYN_POSTHOG_PERSONAL_API_KEY` and posthog-node polls the flag
 * DEFINITIONS and evaluates them in-process, so a gate costs no network at all.
 * That matters because the workflows gate runs once per webhook delivery per
 * watching workspace — the engine already dropped a `users` join from that path
 * for being too expensive, and a cross-internet round trip is far worse than a
 * join.
 *
 * Without the personal key the SDK asks PostHog per evaluation, so this file
 * caches the decision for `REMOTE_DECISION_TTL_MS`. See that constant for why
 * the number is what it is.
 *
 * # Why posthog-node here, when `analytics.ts` deliberately refused it
 *
 * `analytics.ts` sends a handful of events with a bare `fetch` and says so:
 * it needs none of the SDK's machinery. Flags are the machinery — definition
 * polling, the property-matching evaluator, cohort and rollout bucketing,
 * `$feature_flag_called` de-duplication. Reimplementing PostHog's bucketing
 * hash is how a rollout percentage ends up meaning something different on the
 * server than it does in the PostHog UI.
 *
 * The one thing we keep from that decision is the debug-bus discipline: the
 * SDK is handed our own `fetch`, so every outbound call still lands in the
 * Debug panel's HTTP feed like any other integration.
 */

/**
 * How long a REMOTELY evaluated decision is reused.
 *
 * Matched to posthog-node's own `featureFlagsPollingInterval` default (30s),
 * which is how stale a LOCALLY evaluated decision can be. Keeping the two equal
 * means turning the personal API key on or off changes the cost of a gate but
 * never how fast a flag flip reaches production — so an incident response does
 * not have to know which mode the deployment is in.
 */
const REMOTE_DECISION_TTL_MS = 30_000;

/**
 * How long a workspace's owner identity is reused.
 *
 * Same 30s, for the same reason: this is the other input to a flag decision, so
 * caching it longer would make the owner the stale half. Ownership effectively
 * never changes and an email rarely does — the TTL exists so that when one of
 * them DOES change, the fix is a wait rather than a redeploy.
 */
const SUBJECT_TTL_MS = 30_000;

/** Who a flag is being evaluated for. */
export interface FlagSubject {
  /**
   * The PostHog distinct id. Always the Supabase user id — the same one
   * `analytics.ts` captures against and both renderers identify with, so a flag
   * targeted at a person in PostHog lines up with that person's events instead
   * of creating a second profile nobody can join to.
   */
  distinctId: string;
  /**
   * The user's email, passed as a person property.
   *
   * Not decoration: it is what lets a release condition say "these five
   * people", which is the literal job `FLEET_ALLOWED_EMAILS` used to do. Passed
   * explicitly rather than relied on from the ingested person profile, because
   * local evaluation can only match properties we hand it.
   */
  email?: string | null;
}

/** Where an answer came from. Used to explain a refusal. */
export type FlagSource = 'env' | 'posthog' | 'fallback';

export interface FlagDecision {
  enabled: boolean;
  source: FlagSource;
}

// ---------- The client ----------

/**
 * `undefined` = not built yet, `null` = deliberately absent.
 *
 * A promise rather than the client itself because posthog-node is imported
 * LAZILY: a deployment with no project key — every developer's machine, every
 * CI run — should not pay to load an SDK it will never call, and `fleetAccess`
 * sits in the import graph of the cloud-provider registry, so the cost would
 * land on anything that so much as resolves a provider.
 */
let clientPromise: Promise<PostHog | null> | undefined;

async function buildClient(): Promise<PostHog | null> {
  const key = process.env.TALYN_POSTHOG_KEY || '';
  if (!key) return null;

  const host = (process.env.TALYN_POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/+$/, '');
  const personalApiKey = process.env.TALYN_POSTHOG_PERSONAL_API_KEY || undefined;

  const { PostHog: Client } = await import('posthog-node');
  return new Client(key, {
    host,
    personalApiKey,
    // Explicit rather than inferred from `personalApiKey`, so reading this
    // constructor tells you which mode the process is in.
    enableLocalEvaluation: Boolean(personalApiKey),
    featureFlagsPollingInterval: REMOTE_DECISION_TTL_MS,
    // Every outbound call through the debug bus, per the debug-tooling rules.
    fetch: instrumentedFetch,
  });
}

async function getClient(): Promise<PostHog | null> {
  if (clientPromise === undefined) clientPromise = buildClient();
  return clientPromise;
}

/**
 * True when PostHog can answer at all.
 *
 * Reads the env rather than the client, so the boot log can say which mode the
 * process is in without constructing an SDK (and loading it) to find out.
 */
export function isFeatureFlagServiceConfigured(): boolean {
  return Boolean(process.env.TALYN_POSTHOG_KEY);
}

/** True when gates cost no network. Exposed for the boot log. */
export function featureFlagsEvaluateLocally(): boolean {
  return Boolean(process.env.TALYN_POSTHOG_KEY && process.env.TALYN_POSTHOG_PERSONAL_API_KEY);
}

/**
 * The SDK's HTTP, funnelled through the debug bus.
 *
 * Metadata only, like every other integration: `recordHttp` strips the query
 * string and never sees headers or bodies. That is what keeps the personal API
 * key out of the Debug panel — posthog-node sends it as an `Authorization:
 * Bearer` header on the local-evaluation request.
 */
async function instrumentedFetch(
  url: string,
  options: Parameters<typeof fetch>[1] & { method?: string }
): Promise<Response> {
  const startedAt = Date.now();
  try {
    const res = await fetch(url, options);
    debugBus.recordHttp({
      service: 'posthog_flags',
      method: options?.method ?? 'GET',
      url,
      status: res.status,
      durationMs: Date.now() - startedAt,
      ok: res.ok,
      ...(res.ok ? {} : { error: `flags request failed (${res.status})` }),
    });
    return res;
  } catch (err) {
    debugBus.recordHttp({
      service: 'posthog_flags',
      method: options?.method ?? 'GET',
      url,
      durationMs: Date.now() - startedAt,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// ---------- Remote-decision cache ----------

const decisions = new Map<string, FlagDecision & { expiresAt: number }>();

// ---------- Evaluation ----------

/**
 * Evaluate one flag, reporting where the answer came from.
 *
 * Never throws and never rejects: a gate that blows up on a PostHog blip would
 * take out webhook processing, so an error is the flag's `fallback` and a
 * warning.
 */
export async function evaluateFlag(
  flag: FeatureFlagKey,
  subject: FlagSubject
): Promise<FlagDecision> {
  const override = readFlagOverride(flag, process.env);
  if (override !== undefined) return { enabled: override, source: 'env' };

  const definition = FEATURE_FLAGS[flag];
  // The distinct-id check comes first so an anonymous subject never even builds
  // the client — which, on a deployment with a key, would load the SDK.
  if (!subject.distinctId) return { enabled: definition.fallback, source: 'fallback' };
  const posthog = await getClient();
  if (!posthog) {
    return { enabled: definition.fallback, source: 'fallback' };
  }

  const local = featureFlagsEvaluateLocally();
  const cacheKey = `${flag}:${subject.distinctId}`;
  if (!local) {
    const hit = decisions.get(cacheKey);
    // The cached SOURCE is stored rather than assumed: a cached failure is a
    // `fallback`, and reporting it as `posthog` would put the wrong sentence in
    // a refusal message for the whole TTL.
    if (hit && hit.expiresAt > Date.now()) return { enabled: hit.enabled, source: hit.source };
  }

  try {
    const result = await posthog.isFeatureEnabled(definition.posthogKey, subject.distinctId, {
      ...(subject.email ? { personProperties: { email: subject.email } } : {}),
      // With a personal API key this keeps the gate off the network entirely;
      // without one it would refuse to answer at all, so it is conditional.
      onlyEvaluateLocally: local,
    });

    // `undefined` means PostHog does not know this key — a flag that has not
    // been created yet, or one somebody deleted. That is NOT "disabled": a
    // deleted `workflows` flag must not silently switch off a shipped feature,
    // and a deleted `fleet` flag must not silently open the hardware. Each one
    // falls back to the polarity it declared.
    if (result === undefined) return { enabled: definition.fallback, source: 'fallback' };

    if (!local) {
      decisions.set(cacheKey, {
        enabled: result,
        source: 'posthog',
        expiresAt: Date.now() + REMOTE_DECISION_TTL_MS,
      });
    }
    return { enabled: result, source: 'posthog' };
  } catch (err) {
    console.warn(
      `[flags] "${definition.posthogKey}" evaluation failed, falling back to ${definition.fallback}:`,
      err instanceof Error ? err.message : err
    );
    // Cache the FAILURE too, in remote mode. Otherwise a PostHog outage adds a
    // failing round trip — with the SDK's own retries behind it — to every
    // webhook delivery, which turns a flag-service problem into a webhook
    // backlog. The cost is that recovery takes up to one TTL to be noticed,
    // which is the same lag a flag flip already has.
    if (!local) {
      decisions.set(cacheKey, {
        enabled: definition.fallback,
        source: 'fallback',
        expiresAt: Date.now() + REMOTE_DECISION_TTL_MS,
      });
    }
    return { enabled: definition.fallback, source: 'fallback' };
  }
}

/** The common shape: just the boolean. */
export async function isFeatureEnabled(
  flag: FeatureFlagKey,
  subject: FlagSubject
): Promise<boolean> {
  return (await evaluateFlag(flag, subject)).enabled;
}

// ---------- Subjects ----------

const subjectCache = new Map<string, { subject: FlagSubject | null; expiresAt: number }>();

/**
 * The flag subject for a workspace: its OWNER.
 *
 * Keyed on the owner rather than on whoever triggered the work, because a task
 * can be dispatched by a webhook, the poller, a scheduled sweep or another
 * member — none of which has a user attached — and a gate that passes when it
 * cannot identify a caller is not a gate. The owner is the one identity every
 * workspace provably has.
 *
 * Returns null for a workspace that has been deleted underneath us, which
 * callers must read as "no subject, so the fallback applies".
 */
export async function workspaceFlagSubject(workspaceId: string): Promise<FlagSubject | null> {
  const hit = subjectCache.get(workspaceId);
  if (hit && hit.expiresAt > Date.now()) return hit.subject;
  try {
    const rows = await getDbClient()
      .select({ id: usersTable.id, email: usersTable.email })
      .from(workspacesTable)
      .innerJoin(usersTable, eq(usersTable.id, workspacesTable.ownerId))
      .where(eq(workspacesTable.id, workspaceId))
      .limit(1);
    const row = rows[0];
    const subject: FlagSubject | null = row ? { distinctId: row.id, email: row.email } : null;
    subjectCache.set(workspaceId, { subject, expiresAt: Date.now() + SUBJECT_TTL_MS });
    return subject;
  } catch (err) {
    console.warn(
      `[flags] could not resolve the owner of workspace ${workspaceId.slice(0, 8)}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/** Evaluate a flag for a workspace's owner. Falls back when there is no owner. */
export async function workspaceHasFeature(
  flag: FeatureFlagKey,
  workspaceId: string
): Promise<FlagDecision> {
  const subject = await workspaceFlagSubject(workspaceId);
  if (!subject) {
    const override = readFlagOverride(flag, process.env);
    if (override !== undefined) return { enabled: override, source: 'env' };
    return { enabled: FEATURE_FLAGS[flag].fallback, source: 'fallback' };
  }
  return evaluateFlag(flag, subject);
}

// ---------- The account-level answer ----------

/** Every account-scoped flag for one user — the body of `GET /features`. */
export async function featuresForUser(subject: FlagSubject): Promise<Features> {
  const entries = await Promise.all(
    ACCOUNT_FEATURE_FLAGS.map(
      async (flag) => [flag, await isFeatureEnabled(flag, subject)] as const
    )
  );
  return Object.fromEntries(entries) as Features;
}

// ---------- Lifecycle ----------

/**
 * Flush and stop the SDK. Called from the backend's SIGTERM drain.
 *
 * posthog-node batches the `$feature_flag_called` events that make a flag's
 * usage visible in the PostHog UI; without this they are lost on every deploy,
 * and every deploy is where a flag rollout is most interesting.
 */
export async function shutdownFeatureFlags(): Promise<void> {
  const pending = clientPromise;
  clientPromise = undefined;
  decisions.clear();
  subjectCache.clear();
  if (!pending) return;
  const posthog = await pending.catch(() => null);
  if (!posthog) return;
  await posthog.shutdown(2_000).catch(() => undefined);
}

/** Tests: drop the client and both caches so env changes take effect. */
export function resetFeatureFlagsForTests(): void {
  clientPromise = undefined;
  decisions.clear();
  subjectCache.clear();
}

/**
 * The PostHog project write key baked into every renderer bundle.
 *
 * Committed on purpose. A project write key is public by design — it is the
 * same string any web page ships in its PostHog snippet, it can only write
 * events into one project, and it reads nothing. `packages/mcp-server` already
 * commits this exact key, for this exact reason.
 *
 * It used to default to `''` here, with the real value injected only by
 * publish.yml (`vars.TALYN_POSTHOG_KEY` — a repo VARIABLE, not a secret, which
 * says the team already treated it as public). The cost of that default was
 * not theoretical: a build made outside CI emitted no client analytics at all.
 * Talyn's second-heaviest user runs one alongside his release builds, and it is
 * the one his automation drives — all twelve of his merge-queue enqueues came
 * from it, with no `merge_queue_toggled` and no `paywall_shown` behind any of
 * them, while his browsing on the released app reported normally. Every action
 * that could have met a paywall happened on the client that could not say so.
 *
 * Two things stop those builds from polluting the numbers now that they do
 * report — both in `renderer/lib/analytics.ts`:
 *   - `environment` is derived from whether the build is a RELEASE, not from
 *     NODE_ENV. A locally packaged app is NODE_ENV=production and used to
 *     claim `environment: 'production'`.
 *   - `app_version` carries `dev+<sha>`, so a contributor build names itself.
 */

/** Talyn's "FastOwl" PostHog project (id 459813). */
export const DEFAULT_POSTHOG_KEY = 'phc_n7cmPaZ8BZkgnBV9seBGqaJTtcjd9NYbKTUhcLXTohwX';

/**
 * The opt-out, spelled the same way `packages/mcp-server` spells it.
 *
 * It is a SEPARATE flag rather than "leave the key blank" because those two
 * states are not the same intent and cannot be told apart. `apps/desktop/.env`
 * is loaded into `process.env` before the plugins are built, so a bare
 * `TALYN_POSTHOG_KEY=` line — the shape anyone copying a config leaves behind
 * — reads as an explicit empty value and beat the default silently. That is
 * the same class of bug as the one above: analytics off, nothing said.
 */
function analyticsDisabled(raw: string | undefined): boolean {
  const flag = (raw ?? '').trim().toLowerCase();
  return flag === '1' || flag === 'true';
}

/**
 * The key to bake, given a build environment.
 *
 * Precedence: the disable flag wins outright, then a non-blank
 * `TALYN_POSTHOG_KEY` (CI passes the project key this way, and it is how you
 * point a build at a different project), then the committed default. A BLANK
 * key falls through to the default — see `analyticsDisabled`.
 *
 * An empty return disables the SDK outright (`isAnalyticsConfigured`), and
 * Terser then drops the whole analytics path from the bundle.
 */
export function resolvePostHogKey(env: NodeJS.ProcessEnv = process.env): string {
  if (analyticsDisabled(env.TALYN_ANALYTICS_DISABLED)) return '';
  return (env.TALYN_POSTHOG_KEY ?? '').trim() || DEFAULT_POSTHOG_KEY;
}

export default resolvePostHogKey;

/**
 * PostHog Code is retired, behind the `posthogCodeRetired` flag (fallback ON).
 * With the flag on, a workspace that has not connected it is never offered it,
 * and a workspace that has is told to move. Every front end reads these
 * helpers, so the three apps draw the same thing.
 */

/** The `code` on the 410 a connect route answers when the flag is on. */
export const POSTHOG_CODE_RETIRED_CODE = 'posthog_code_retired';

/** The refusal a connect route sends. */
export const POSTHOG_CODE_RETIRED_ERROR =
  'PostHog Code is no longer available for new connections. Connect Claude or Codex instead.';

/** The notice drawn next to an existing PostHog Code connection or a loop that uses it. */
export const POSTHOG_CODE_RETIRED_NOTICE =
  'PostHog Code is going away. Move your work to Claude or Codex.';

type RetirementFeatures = { posthogCodeRetired?: boolean } | null | undefined;

/**
 * Is the flag on? Features that are not loaded yet read as off, so a client
 * never hides a connection on a guess. The connect routes refuse on their own.
 */
export function posthogCodeRetired(features: RetirementFeatures): boolean {
  return features?.posthogCodeRetired === true;
}

/**
 * May a client draw PostHog Code (its card, its connect button) at all?
 * `hasConnection` means the workspace has a PostHog Code connection in any
 * state, so it can still reconnect or disconnect it.
 */
export function posthogCodeOffered(features: RetirementFeatures, hasConnection: boolean): boolean {
  return hasConnection || !posthogCodeRetired(features);
}

/** Should the move-to-Claude-or-Codex notice show? Only for a connection that exists. */
export function posthogCodeRetiringNotice(features: RetirementFeatures, hasConnection: boolean): boolean {
  return hasConnection && posthogCodeRetired(features);
}

/** A PostHog Code status read as "a connection exists", whatever its state. */
export function posthogCodeConnectionExists(
  status: { connected?: boolean; hostNotAllowed?: boolean } | null | undefined,
): boolean {
  return status?.connected === true || status?.hostNotAllowed === true;
}

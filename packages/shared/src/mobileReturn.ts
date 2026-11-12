/**
 * Return targets for flows the mobile app opens in a browser (GitHub connect,
 * Polar checkout and portal). The app sends its own URL base as `returnTo`
 * (for example `talyn-mobile://`). The backend accepts it only when it is
 * EXACTLY one of the schemes in its `MOBILE_RETURN_SCHEMES` allowlist, and
 * answers 400 `invalid_return_to` for anything else.
 */

/** 400 code when a `returnTo` is not on the backend's allowlist. */
export const INVALID_RETURN_TO_CODE = 'invalid_return_to';

/** The allowlist the backend uses when `MOBILE_RETURN_SCHEMES` is not set. */
export const DEFAULT_MOBILE_RETURN_SCHEMES = [
  'talyn-mobile://',
  'talyn-mobile-preview://',
  'talyn-mobile-development://',
] as const;

/** Path (after `returnTo`) the GitHub App callback finishes on. */
export const MOBILE_GITHUB_RETURN_PATH = 'github/callback';

/** Path (after `returnTo`) a Polar checkout or portal session comes back to. */
export const MOBILE_BILLING_RETURN_PATH = 'billing/return';

/** Path (after `returnTo`) an MCP server sign-in finishes on: `?mcp=connected|error`. */
export const MOBILE_MCP_RETURN_PATH = 'mcp/callback';

/** Path (after `returnTo`) a Slack install or link finishes on: `?slack=installed|linked|error`. */
export const MOBILE_SLACK_RETURN_PATH = 'slack/callback';

/** Path (after `returnTo`) a PostHog Code sign-in finishes on: `?posthog=connected|error`. */
export const MOBILE_POSTHOG_RETURN_PATH = 'posthog/callback';

/** Path (after `returnTo`) a Linear connect finishes on: `?linear=connected|error`. */
export const MOBILE_LINEAR_RETURN_PATH = 'linear/callback';

/**
 * Why a GitHub connect failed, as `?github=error&reason=<code>`.
 * - `access_denied`: the person declined on GitHub.
 * - `provider_error`: GitHub sent another error.
 * - `missing_code`: GitHub came back without a code or state.
 * - `invalid_state`: the state is unknown, expired or for another workspace.
 * - `connect_failed`: the code exchange or the installation lookup failed.
 */
export const GITHUB_CALLBACK_ERROR_REASONS = [
  'access_denied',
  'provider_error',
  'missing_code',
  'invalid_state',
  'connect_failed',
] as const;
export type GitHubCallbackErrorReason = (typeof GITHUB_CALLBACK_ERROR_REASONS)[number];

/** `kind` on a billing return: a plan checkout, a credit-pack checkout, or the portal. */
export const MOBILE_BILLING_RETURN_KINDS = ['checkout', 'credits', 'reset', 'portal'] as const;
export type MobileBillingReturnKind = (typeof MOBILE_BILLING_RETURN_KINDS)[number];

/**
 * `result` on a billing return. `success` is Polar's success page (or the
 * portal's back button); `cancel` is the checkout's back button. Neither is
 * proof of payment: the entitlement arrives by webhook, so poll
 * `GET /billing/status` after a return.
 */
export const MOBILE_BILLING_RETURN_RESULTS = ['success', 'cancel'] as const;
export type MobileBillingReturnResult = (typeof MOBILE_BILLING_RETURN_RESULTS)[number];

/** `POST /billing/portal`. */
export interface PortalSessionRequest {
  /** The mobile app's URL base. See {@link INVALID_RETURN_TO_CODE}. */
  returnTo?: string;
}

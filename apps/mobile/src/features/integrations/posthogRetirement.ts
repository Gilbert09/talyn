import type { Features } from '@talyn/shared';
import {
  posthogCodeConnectionExists,
  posthogCodeOffered,
  posthogCodeRetired,
  posthogCodeRetiringNotice,
} from '@talyn/shared';

type Status = { connected?: boolean; hostNotAllowed?: boolean } | null | undefined;

/** What the PostHog Code card may draw, from the `posthogCodeRetired` flag. Mirrors web `PostHogCodeRetirement`. */
export function postHogRetirement(features: Partial<Features> | null | undefined, status: Status): { offered: boolean; notice: boolean } {
  const hasConnection = posthogCodeConnectionExists(status);
  return { offered: posthogCodeOffered(features, hasConnection), notice: posthogCodeRetiringNotice(features, hasConnection) };
}

/** Whether the catalog lists PostHog Code. An unknown status reads as not connected. */
export function postHogCatalogOffered(features: Partial<Features> | null | undefined, status: Status): boolean {
  return postHogRetirement(features, status).offered;
}

/** The default-agent hint. With the flag on, nothing falls back to PostHog Code. */
export function automaticDefaultCopy(features: Partial<Features> | null | undefined): string {
  return posthogCodeRetired(features) ? 'Automatic prefers Talyn Fleet.' : 'Automatic prefers Talyn Fleet, then PostHog Code.';
}

/**
 * Whether PostHog Code may be offered, read from the provider list. With the
 * flag on, the backend lists it only for a workspace that still has it.
 */
export function postHogListed(features: Partial<Features> | null | undefined, providers: readonly { type: string }[]): boolean {
  return !posthogCodeRetired(features) || providers.some((p) => p.type === 'posthog_code');
}

/** The title of the row that links to the integrations list. */
export function integrationsLinkTitle(features: Partial<Features> | null | undefined, providers: readonly { type: string }[]): string {
  return postHogListed(features, providers) ? 'PostHog Code and Trunk' : 'Integrations';
}

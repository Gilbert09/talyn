import type { Response } from 'express';
import {
  POSTHOG_CODE_RETIRED_CODE,
  POSTHOG_CODE_RETIRED_ERROR,
  type CloudProviderType,
} from '@talyn/shared';
import { isFeatureEnabled, workspaceHasFeature } from './featureFlags.js';
import { readPostHogIntegration } from './posthogCode/integrationRow.js';

/**
 * Server side of the `posthogCodeRetired` flag. Routes ask about the caller;
 * dispatch, the resolver and failover ask about the workspace owner.
 */

/** The flag, for the workspace owner. */
export async function posthogCodeRetiredForWorkspace(workspaceId: string): Promise<boolean> {
  return (await workspaceHasFeature('posthogCodeRetired', workspaceId)).enabled;
}

/**
 * Should a connect route refuse? Only when the flag is on for the caller AND
 * the workspace has no PostHog Code row. A row in any state (working, expired
 * grant, host no longer allowed) may still be updated and reconnected.
 */
export async function refusesNewPostHogCodeConnection(
  user: { id: string; email?: string | null },
  workspaceId: string,
): Promise<boolean> {
  if (!(await isFeatureEnabled('posthogCodeRetired', { distinctId: user.id, email: user.email }))) {
    return false;
  }
  return !(await readPostHogIntegration(workspaceId));
}

export function sendPostHogCodeRetired(res: Response): Response {
  return res.status(410).json({
    success: false,
    code: POSTHOG_CODE_RETIRED_CODE,
    error: POSTHOG_CODE_RETIRED_ERROR,
  });
}

/**
 * The resolver's chain with PostHog Code dropped as a fall-back. It stays when
 * the workspace chose it as its default, or when it is the only provider left,
 * so an old PostHog-Code-only workspace keeps working.
 */
export async function withoutRetiredPostHogCode<T extends { provider: CloudProviderType }>(
  workspaceId: string,
  chain: T[],
  pinned: CloudProviderType | 'ask' | null,
): Promise<T[]> {
  if (pinned === 'posthog_code') return chain;
  if (!chain.some((l) => l.provider === 'posthog_code')) return chain;
  if (!chain.some((l) => l.provider !== 'posthog_code')) return chain;
  if (!(await posthogCodeRetiredForWorkspace(workspaceId))) return chain;
  return chain.filter((l) => l.provider !== 'posthog_code');
}

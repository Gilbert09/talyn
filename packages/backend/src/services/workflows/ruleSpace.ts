import type { WorkflowAction } from '@talyn/shared';
import { TeamError } from '../billing/teams.js';
import { isFeatureEnabled } from '../featureFlags.js';
import { assertSpaceMember } from '../teams/access.js';

/**
 * The team space a rule's `start_session` action puts its session in.
 *
 * The session runs in the rule's own workspace, as a moved session does: a
 * space is a container, not a workspace. So the only checks are the ones a
 * move makes, for the rule's owner: the `spaces` flag, team membership and a
 * live space. The route checks a NEW space when the rule is saved. The run
 * checks again, because the owner can leave the team or the space can be
 * archived after the save.
 */

export interface RuleSpaceOwner {
  id: string;
  email?: string | null;
}

/** The distinct space ids that the rule's session actions name. */
export function ruleSpaceIds(actions: readonly WorkflowAction[]): string[] {
  const ids = new Set<string>();
  for (const action of actions) {
    if (action.type === 'start_session' && action.spaceId) ids.add(action.spaceId);
  }
  return [...ids];
}

/** Why the owner cannot start a rule's session in this space, or null when they can. */
export async function ruleSpaceRefusal(owner: RuleSpaceOwner, spaceId: string): Promise<string | null> {
  if (!(await isFeatureEnabled('spaces', { distinctId: owner.id, email: owner.email }))) {
    return 'Spaces are not available for this account.';
  }
  try {
    const space = await assertSpaceMember(owner.id, spaceId);
    return space.archivedAt ? 'The space is archived.' : null;
  } catch (err) {
    if (err instanceof TeamError) return 'The space was not found, or you are not in its team.';
    throw err;
  }
}

import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { TeamRole } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { teamMembers as teamMembersTable } from '../../db/schema.js';

/**
 * Keeps `team_members` in step with `team_seats`. A seat holder is a team
 * member. Called by the seat writers in `services/billing/teams.ts`; kept apart
 * from `membership.ts` so the billing code does not import it back.
 */

function avatarFor(githubUserId: number): string {
  return `https://avatars.githubusercontent.com/u/${githubUserId}?v=4`;
}

/** Seat sync: a new seat makes its holder a member. An existing member keeps their row. */
export async function addSeatMembers(
  teamId: string,
  seats: ReadonlyArray<{
    githubUserId: number;
    githubLogin: string;
    avatarUrl: string | null;
    role?: TeamRole;
    userId?: string | null;
    invitedByUserId?: string | null;
  }>
): Promise<void> {
  if (seats.length === 0) return;
  await getPoolDbClient()
    .insert(teamMembersTable)
    .values(
      seats.map((s) => ({
        id: uuid(),
        teamId,
        githubUserId: s.githubUserId,
        userId: s.userId ?? null,
        githubLogin: s.githubLogin,
        avatarUrl: s.avatarUrl ?? avatarFor(s.githubUserId),
        role: s.role ?? 'member',
        source: 'seat',
        invitedByUserId: s.invitedByUserId ?? null,
      }))
    )
    .onConflictDoNothing({ target: [teamMembersTable.teamId, teamMembersTable.githubUserId] });
}

/**
 * Seat sync: a removed seat removes a member who came only from that seat. An
 * invited member stays, and so does an owner or admin: the seat did not give
 * them their role.
 */
export async function removeSeatMember(teamId: string, githubUserId: number): Promise<void> {
  await getPoolDbClient()
    .delete(teamMembersTable)
    .where(
      and(
        eq(teamMembersTable.teamId, teamId),
        eq(teamMembersTable.githubUserId, githubUserId),
        eq(teamMembersTable.source, 'seat'),
        eq(teamMembersTable.role, 'member')
      )
    );
  await getPoolDbClient()
    .update(teamMembersTable)
    .set({ source: 'invite' })
    .where(
      and(
        eq(teamMembersTable.teamId, teamId),
        eq(teamMembersTable.githubUserId, githubUserId),
        eq(teamMembersTable.source, 'seat')
      )
    );
}

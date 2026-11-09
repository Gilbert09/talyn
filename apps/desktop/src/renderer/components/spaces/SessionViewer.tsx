import type { SpaceItemCreator, SpacePresenceMember, Workbench } from '@talyn/shared';
import { memberName, useIsWorkbenchOwner, viewersOf } from '../../lib/spaces';
import { findSessionRow, findSpace, useSpacesStore } from '../../stores/spaces';
import { MemberAvatar, PresenceAvatars, SpaceDot } from './SpaceAvatars';

export interface SessionViewer {
  owner: boolean;
  creator: SpaceItemCreator | null;
  viewers: SpacePresenceMember[];
}

export function useSessionViewer(workbench: Pick<Workbench, 'id' | 'workspaceId' | 'spaceId'>): SessionViewer {
  const owner = useIsWorkbenchOwner(workbench);
  const creator = useSpacesStore((s) => findSessionRow(s.sessions, workbench.id)?.creator ?? null);
  const presence = useSpacesStore((s) => (workbench.spaceId ? s.presence[workbench.spaceId] : undefined));
  const selfUserId = useSpacesStore((s) => s.selfUserId);
  return { owner, creator, viewers: viewersOf(presence, workbench.id, selfUserId) };
}

export function SessionOwnerChip({ creator }: { creator: SpaceItemCreator | null }) {
  const label = creator?.githubLogin ? `${memberName(creator)}'s session` : "A teammate's session";
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
      data-attr="session-owner-chip"
    >
      {creator && <MemberAvatar member={creator} size={12} />}
      {label}
    </span>
  );
}

export function SessionPresence({ viewers }: { viewers: SpacePresenceMember[] }) {
  if (viewers.length === 0) return null;
  return <PresenceAvatars members={viewers} showText size={16} />;
}

export function SessionSpaceChip({ spaceId }: { spaceId: string | null | undefined }) {
  const teams = useSpacesStore((s) => s.teams);
  const ref = findSpace(teams, spaceId);
  if (!ref) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
      title={`${ref.space.name} · ${ref.team.name}`}
      data-attr="session-space-chip"
    >
      <SpaceDot color={ref.space.color} image={ref.space.image} className="h-2 w-2" />
      {ref.space.name}
    </span>
  );
}

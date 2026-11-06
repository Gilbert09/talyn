import type { SpaceItemCreator, SpacePresenceMember } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { memberName, presenceSentence } from '../../lib/spaces';

export function MemberAvatar({
  member,
  size = 16,
  className,
  title,
}: {
  member: Pick<SpaceItemCreator, 'avatarUrl' | 'githubLogin'>;
  size?: number;
  className?: string;
  title?: string;
}) {
  const name = memberName(member);
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-[9px] font-medium text-muted-foreground',
        className,
      )}
      style={{ width: size, height: size }}
      title={title ?? name}
    >
      {member.avatarUrl ? (
        <img src={member.avatarUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        name.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}

export function PresenceAvatars({
  members,
  max = 3,
  size = 16,
  showText = false,
}: {
  members: SpacePresenceMember[];
  max?: number;
  size?: number;
  showText?: boolean;
}) {
  if (members.length === 0) return null;
  const sentence = presenceSentence(members) ?? '';
  const shown = members.slice(0, max);
  const more = members.length - shown.length;
  return (
    <span className="inline-flex shrink-0 items-center gap-1" title={sentence} data-attr="presence-avatars">
      <span className="flex -space-x-1">
        {shown.map((m) => (
          <MemberAvatar key={m.userId} member={m} size={size} className="ring-1 ring-background" title={sentence} />
        ))}
      </span>
      {more > 0 && <span className="text-[10px] text-muted-foreground">+{more}</span>}
      {showText && <span className="truncate text-xs text-muted-foreground">{sentence}</span>}
    </span>
  );
}

export function SpaceDot({ color, className }: { color: string | null; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block h-2.5 w-2.5 shrink-0 rounded-full', !color && 'bg-muted-foreground/50', className)}
      style={color ? { backgroundColor: color } : undefined}
    />
  );
}

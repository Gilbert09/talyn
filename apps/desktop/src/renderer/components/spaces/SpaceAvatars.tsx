import type { SpaceItemCreator, SpacePresenceMember } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { memberName, presenceSentence } from '../../lib/spaces';
import { railInitials } from '../../lib/contextRail';

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

/** A space's small marker: its image when it has one, else its colour dot. */
export function SpaceDot({
  color,
  image,
  className,
}: {
  color: string | null;
  image?: string | null;
  className?: string;
}) {
  if (image) {
    return (
      <img
        src={image}
        alt=""
        aria-hidden
        data-attr="space-dot-image"
        className={cn('inline-block h-2.5 w-2.5 shrink-0 rounded-[3px] object-cover', className)}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn('inline-block h-2.5 w-2.5 shrink-0 rounded-full', !color && 'bg-muted-foreground/50', className)}
      style={color ? { backgroundColor: color } : undefined}
    />
  );
}

/** A space's square tile: its image, or its initials on its colour. The context rail and the image picker use it. */
export function SpaceTile({
  name,
  color,
  image,
  size,
  className,
}: {
  name: string;
  color: string | null;
  image?: string | null;
  size: number;
  className?: string;
}) {
  if (image) {
    return (
      <img
        src={image}
        alt=""
        data-attr="space-tile-image"
        className={cn('block shrink-0 rounded-lg object-cover', className)}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg text-[13px] font-semibold text-white',
        !color && 'bg-muted-foreground/60',
        className,
      )}
      style={{ width: size, height: size, ...(color ? { backgroundColor: color } : {}) }}
    >
      {railInitials(name)}
    </span>
  );
}

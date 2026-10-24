import type { User } from '@supabase/supabase-js';
import { cn } from '../../lib/utils';
import { useIsDevBuild } from '../../hooks/useIsDevBuild';

interface UserChipProps {
  user: User;
  collapsed: boolean;
  onClick: () => void;
}

export function UserChip({ user, collapsed, onClick }: UserChipProps) {
  const isDev = useIsDevBuild();
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const username =
    (typeof meta.user_name === 'string' && meta.user_name) ||
    (typeof meta.preferred_username === 'string' && meta.preferred_username) ||
    (user.email?.split('@')[0] ?? 'user');
  const avatarUrl = typeof meta.avatar_url === 'string' ? meta.avatar_url : undefined;
  const initials = username.slice(0, 1).toUpperCase();

  return (
    <button
      type="button"
      onClick={onClick}
      title={
        isDev
          ? `DEV build — signed in as @${username}. Click for account settings`
          : `Signed in as @${username} — click for account settings`
      }
      className={cn(
        'flex items-center gap-2 text-sm rounded-md transition-colors',
        isDev ? 'bg-warning/25 ring-1 ring-inset ring-warning/40 hover:bg-warning/35' : 'hover:bg-accent',
        collapsed ? 'h-8 w-8 justify-center flex-shrink-0' : 'flex-1 min-w-0 px-2 py-1.5'
      )}
    >
      <span className="relative flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-medium">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            className="h-full w-full object-cover"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : (
          initials
        )}
      </span>
      {!collapsed && <span className="min-w-0 flex-1 truncate text-left">@{username}</span>}
      {!collapsed && isDev && (
        <span className="shrink-0 rounded bg-warning px-1 py-0.5 text-[9px] font-bold uppercase leading-none tracking-wide text-warning-foreground">
          Dev
        </span>
      )}
    </button>
  );
}

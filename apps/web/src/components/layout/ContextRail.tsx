import { attentionBadgeLabel } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { formatKeys } from '../../lib/shortcuts';
import { WorkspaceLogo } from '../widgets/WorkspaceLogo';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { useWorkspaceStore } from '../../stores/workspace';
import { useSpacesStore } from '../../stores/spaces';
import { spacesOffered, switchContext, useActiveSpace } from '../../lib/spaces';
import { railEntries, railEntryAttention, useContextAttention, type RailEntry } from '../../lib/contextRail';
import { SpaceTile } from '../spaces/SpaceAvatars';
import { CONTEXT_JUMP_KEYS } from './appShortcuts';

const TILE = 36;

/**
 * The bar on the far left, like Slack's: one tile per workspace and per space,
 * with a red count of what waits on me there. Hidden with only one context.
 */
export function ContextRail() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const currentWorkspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const spacesOn = useWorkspaceStore((s) => spacesOffered(s.features));
  const teams = useSpacesStore((s) => s.teams);
  const active = useActiveSpace();
  const entries = railEntries(workspaces, teams, spacesOn);
  const shown = entries.length > 1;
  const activeKey = active ? `space:${active.space.id}` : `workspace:${currentWorkspaceId ?? ''}`;
  const counts = useContextAttention(shown, activeKey);
  if (!shown) return null;

  const select = (entry: RailEntry) => {
    if (spacesOn) switchContext(entry.context);
    else if (entry.id !== currentWorkspaceId) useWorkspaceStore.getState().setCurrentWorkspace(entry.id);
  };

  return (
    <TooltipProvider delayDuration={200}>
      <nav
        aria-label="Workspaces and spaces"
        data-attr="context-rail"
        className="flex h-full w-16 shrink-0 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden border-r bg-muted py-3"
      >
        {entries.map((entry, i) => {
          const key = `${entry.kind}:${entry.id}`;
          const isActive = key === activeKey;
          const count = railEntryAttention(entry, counts);
          return (
            <div key={key} className="flex w-full flex-col items-center gap-2">
              {entry.groupStart && <div aria-hidden className="h-px w-8 bg-border" />}
              <RailTile
                entry={entry}
                active={isActive}
                badge={attentionBadgeLabel(count)}
                count={count}
                keys={spacesOn && i < 9 ? CONTEXT_JUMP_KEYS(i + 1) : undefined}
                onClick={() => select(entry)}
              />
            </div>
          );
        })}
      </nav>
    </TooltipProvider>
  );
}

function RailTile({
  entry,
  active,
  badge,
  count,
  keys,
  onClick,
}: {
  entry: RailEntry;
  active: boolean;
  badge: string | null;
  count: number;
  keys?: string;
  onClick: () => void;
}) {
  const waiting = badge ? `${count} ${count === 1 ? 'item needs' : 'items need'} you` : null;
  const label = [entry.kind === 'space' ? `${entry.name} (${entry.teamName})` : entry.name, waiting].filter(Boolean).join(', ');
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-current={active ? 'true' : undefined}
          data-attr={entry.kind === 'space' ? 'context-rail-space' : 'context-rail-workspace'}
          className="group relative flex w-full justify-center"
        >
          {/* Slack's pill on the left edge: tall for the open context, short on hover. */}
          <span
            aria-hidden
            className={cn(
              'absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-all',
              active ? 'h-8' : 'h-0 group-hover:h-4'
            )}
          />
          <span
            className={cn(
              'relative rounded-[10px] ring-offset-2 ring-offset-muted transition-shadow',
              active ? 'ring-2 ring-foreground/70' : 'opacity-80 group-hover:opacity-100'
            )}
          >
            {entry.kind === 'workspace' ? (
              <WorkspaceLogo logo={entry.logo} fallbackSeed={entry.id} size={TILE} className="block" />
            ) : (
              <SpaceTile name={entry.name} color={entry.color} image={entry.image} size={TILE} />
            )}
            {badge && (
              <span
                data-attr="context-rail-badge"
                className="absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold tabular-nums leading-none text-white ring-2 ring-muted"
              >
                {badge}
              </span>
            )}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="flex items-center gap-2">
        <span className="font-medium">{entry.name}</span>
        {entry.kind === 'space' && <span className="text-muted-foreground">{entry.teamName}</span>}
        {waiting && <span className="text-red-500">{waiting}</span>}
        {keys && <span className="text-muted-foreground">{formatKeys(keys)}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

import { cloudProviderStatus, type CloudProviderTone } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { FleetAgentMark, ProviderIcon } from '../../lib/providerMeta';
import { useWorkspaceStore } from '../../stores/workspace';

export function CloudProviderStatus({ collapsed }: { collapsed: boolean }) {
  const providers = useWorkspaceStore((s) => s.cloudProviders);
  const posthogNeedsReauth = useWorkspaceStore((s) => s.posthogStatus?.needsReauth === true);
  const openSettings = useWorkspaceStore((s) => s.openSettings);

  if (!providers || providers.length === 0) return null;

  return (
    <div
      className={cn(
        '-mx-2 mb-2 border-b px-2 pb-2',
        collapsed && 'flex flex-col items-center gap-1',
      )}
    >
      {!collapsed && (
        <p className="px-4 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
          Agents
        </p>
      )}
      {providers.map((p) => {
        const status = cloudProviderStatus(p.type === 'posthog_code'
          ? { ...p, needsReconnect: p.needsReconnect || posthogNeedsReauth }
          : p);
        const title = `${p.displayName}: ${status.detail}`;
        const dimmed = status.tone === 'disconnected';
        if (collapsed) {
          return (
            <button
              key={p.type}
              type="button"
              onClick={() => openSettings('integrations')}
              title={title}
              aria-label={title}
              className="relative flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-accent"
            >
              <ProviderIcon
                provider={p.type}
                label={title}
                className={cn('h-4 w-4', dimmed && 'opacity-40 grayscale')}
              />
              <StatusDot tone={status.tone} className="absolute bottom-1 right-1 ring-2 ring-card" />
            </button>
          );
        }
        return (
          <button
            key={p.type}
            type="button"
            onClick={() => openSettings('integrations')}
            title={title}
            className="group flex h-7 w-full items-center gap-3 rounded-md px-4 text-xs transition-colors hover:bg-accent"
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
              <ProviderIcon
                provider={p.type}
                label={title}
                className={cn('h-3.5 w-3.5', dimmed && 'opacity-40 grayscale')}
              />
            </span>
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-left',
                dimmed ? 'text-muted-foreground' : 'text-foreground',
              )}
            >
              {p.displayName}
            </span>
            {status.agents.map((agent) => (
              <FleetAgentMark key={agent} agent={agent} className="h-3 w-3" />
            ))}
            <StatusDot tone={status.tone} className={status.tone === 'connected' ? 'ring-[3px] ring-green-500/20' : undefined} />
            {status.tone !== 'connected' && (
              <span
                className={cn(
                  'text-[10px] font-medium',
                  status.tone === 'reauth'
                    ? 'text-amber-500'
                    : 'text-muted-foreground/60 group-hover:text-foreground',
                )}
              >
                {status.tone === 'reauth' ? 'Reconnect' : 'Connect'}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function StatusDot({ tone, className }: { tone: CloudProviderTone; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        tone === 'connected' && 'bg-green-500',
        tone === 'reauth' && 'bg-amber-500',
        tone === 'disconnected' && 'bg-muted-foreground/40',
        className,
      )}
    />
  );
}

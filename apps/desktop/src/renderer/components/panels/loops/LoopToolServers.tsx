import { useEffect, useState } from 'react';
import type { McpServerDefinition } from '@talyn/shared';
import { api } from '../../../lib/api';
import { useWorkspaceStore } from '../../../stores/workspace';
import { cn } from '../../../lib/utils';

/**
 * The per-loop tool-server pin.
 *
 * Three states, kept visible because they are genuinely different answers:
 *
 *   null   use whatever the workspace has switched on, now and in future
 *   []     no tool servers at all
 *   [...]  exactly these
 *
 * Inherit is the default and the one most loops want — a server connected next
 * month is picked up without editing every loop. A pin is for a prompt that
 * should stay narrow, and "none" is a pin like any other: collapsing it into
 * inherit would make "run this one with no tools" the one thing a loop could
 * not say.
 */
export function LoopToolServers({
  value,
  onChange,
}: {
  value: string[] | null;
  onChange: (next: string[] | null) => void;
}) {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const [servers, setServers] = useState<McpServerDefinition[] | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    api.mcpServers
      .list(workspaceId)
      // A workspace outside the tool-servers audience gets a 403 here, which is
      // not an error worth showing inside a loop editor — it just means there
      // is nothing to pick.
      .then((rows) => live && setServers(rows))
      .catch(() => live && setServers([]));
    return () => {
      live = false;
    };
  }, [workspaceId]);

  if (servers !== null && servers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This workspace has no tool servers connected, so this loop&rsquo;s agent gets the usual
        tools and nothing else.
      </p>
    );
  }

  const enabled = (servers ?? []).filter((s) => s.enabled);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {[
          { pinned: false, label: "Whatever the workspace has on" },
          { pinned: true, label: 'Choose for this loop' },
        ].map((o) => (
          <button
            key={String(o.pinned)}
            onClick={() => onChange(o.pinned ? enabled.map((s) => s.id) : null)}
            className={cn(
              'inline-flex items-center rounded-full border px-2.5 py-1 text-xs transition-colors',
              (value !== null) === o.pinned
                ? 'border-transparent bg-primary text-primary-foreground'
                : 'hover:bg-accent'
            )}
          >
            {o.label}
          </button>
        ))}
      </div>

      {value === null ? (
        <p className="text-xs text-muted-foreground">
          {servers === null
            ? 'Loading...'
            : `This loop gets the ${enabled.length} tool server${enabled.length === 1 ? '' : 's'} ` +
              'switched on for the workspace, including any you connect later.'}
        </p>
      ) : (
        <>
          <div className="grid gap-1 sm:grid-cols-2">
            {enabled.map((server) => {
              const on = value.includes(server.id);
              return (
                <label key={server.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      onChange(on ? value.filter((id) => id !== server.id) : [...value, server.id])
                    }
                  />
                  <span className="truncate">{server.displayName || server.name}</span>
                </label>
              );
            })}
          </div>
          {value.length === 0 && (
            <p className="text-xs text-amber-600">
              Nothing is ticked, so this loop runs with no tool servers at all.
            </p>
          )}
        </>
      )}
    </div>
  );
}

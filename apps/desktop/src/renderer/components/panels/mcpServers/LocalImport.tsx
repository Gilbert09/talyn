import { useEffect, useState } from 'react';
import { Download, Laptop } from 'lucide-react';
import type { McpServerInput } from '@talyn/shared';
import type { LocalMcpFinding } from '../../../../main/preload';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { cn } from '../../../lib/utils';

/**
 * MCP servers already configured on this machine.
 *
 * Desktop only — reading `~/.claude.json` needs a filesystem, so `apps/web`
 * ships a component of the same name that renders nothing.
 *
 * Every finding is shown, including the ones that cannot be imported, with the
 * reason on the row. Dropping them silently would leave somebody hunting for a
 * server they can see in their own config and concluding the scan is broken —
 * and "an stdio server has nowhere in the sandbox to keep its key" is a fact
 * about the product worth learning once.
 *
 * Credentials do not come along, by design. The address is filled in; the key
 * is typed once, into the field that encrypts it.
 */
export function LocalImport({
  connectedUrls,
  onImport,
}: {
  connectedUrls: Set<string>;
  onImport: (input: McpServerInput) => void;
}) {
  const [findings, setFindings] = useState<LocalMcpFinding[] | null>(null);

  useEffect(() => {
    let live = true;
    window.electron.mcp
      .scanLocal()
      .then((rows) => live && setFindings(rows))
      .catch(() => live && setFindings([]));
    return () => {
      live = false;
    };
  }, []);

  // Nothing found is nothing to say. A section reading "no local servers" on
  // every machine that has none is a section that trains people to skip it.
  if (findings === null || findings.length === 0) return null;

  const importable = findings.filter((f) => f.importable && !connectedUrls.has(f.url ?? ''));
  const rest = findings.filter((f) => !f.importable || connectedUrls.has(f.url ?? ''));

  return (
    <div>
      <h2 className="mb-1 flex items-center gap-2 font-medium">
        <Laptop className="h-4 w-4" />
        Already on this machine
      </h2>
      <p className="mb-3 text-sm text-muted-foreground">
        Found in your Claude and Codex configuration. Importing fills in the address — you will
        need to paste the key again, because Talyn does not read it from those files.
      </p>

      <div className="space-y-2">
        {importable.map((f) => (
          <div key={`${f.source}:${f.name}`} className="flex items-center gap-3 rounded-lg border px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{f.name}</span>
                <Badge variant="outline">{f.source}</Badge>
                {f.hasLocalCredential && <Badge variant="secondary">Key needed</Badge>}
              </div>
              <p className="truncate text-xs text-muted-foreground">{f.url}</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                onImport({
                  name: f.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''),
                  displayName: f.name,
                  url: f.url ?? '',
                  // Bearer is what nearly every remote MCP server wants, and the
                  // editor is one click away if this one is different.
                  authKind: f.hasLocalCredential ? 'bearer' : 'none',
                  enabled: true,
                  tools: null,
                })
              }
            >
              <Download className="mr-1 h-3.5 w-3.5" />
              Import
            </Button>
          </div>
        ))}

        {rest.map((f) => {
          const already = connectedUrls.has(f.url ?? '');
          return (
            <div
              key={`${f.source}:${f.name}`}
              className={cn('rounded-lg border px-3 py-2 opacity-60')}
            >
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{f.name}</span>
                <Badge variant="outline">{f.source}</Badge>
                {already && <Badge variant="secondary">Connected</Badge>}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {already ? 'Already connected to this workspace.' : `Cannot be used here: ${f.reason}`}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

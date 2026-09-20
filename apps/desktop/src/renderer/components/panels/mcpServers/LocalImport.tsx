import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import type { McpServerInput } from '@talyn/shared';
import type { LocalMcpFinding } from '../../../../main/preload';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../ui/dialog';
import { McpServerLogo } from './McpServerLogo';
import { cn } from '../../../lib/utils';

const INTRO_SEEN_KEY = 'talyn:mcp-local-import-seen';
let introSeen = false;

interface LocalImportProps {
  connectedUrls: Set<string>;
  onImport: (input: McpServerInput) => void;
}

export function LocalImport(props: LocalImportProps) {
  const [scanVersion, setScanVersion] = useState(0);
  const [findings, setFindings] = useState<LocalMcpFinding[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setFailed(false);
    window.electron.mcp
      .scanLocal()
      .then((rows) => live && setFindings(rows))
      .catch(() => { if (live) setFailed(true); });
    return () => {
      live = false;
    };
  }, [scanVersion]);

  const availableCount = findings?.filter(
    (finding) => finding.importable && !props.connectedUrls.has(finding.url ?? '')
  ).length;

  const [open, setOpen] = useState(() => {
    try {
      return !introSeen && localStorage.getItem(INTRO_SEEN_KEY) !== '1';
    } catch {
      return !introSeen;
    }
  });

  useEffect(() => {
    introSeen = true;
    try {
      localStorage.setItem(INTRO_SEEN_KEY, '1');
    } catch {
      // Keep the preference for this session if storage is unavailable.
    }
  }, []);

  return (
    <>
      <Button variant="outline" onClick={() => {
        setOpen(true);
        setScanVersion((version) => version + 1);
      }} data-attr="mcp-import">
        <Download className="mr-1 h-4 w-4" />
        Import servers
        {!failed && availableCount !== undefined && (
          <Badge variant="secondary" className="ml-2">{availableCount}</Badge>
        )}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          role="dialog"
          aria-modal="true"
          aria-labelledby="mcp-import-title"
          className="max-w-2xl"
          onClose={() => setOpen(false)}
          onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}
        >
          <DialogHeader>
            <DialogTitle id="mcp-import-title">Import from this machine</DialogTitle>
            <DialogDescription>
              Choose a server from your Claude or Codex configuration. You may need to sign in or enter its key.
            </DialogDescription>
          </DialogHeader>
          {open && <LocalImportList {...props} findings={findings} failed={failed} onImport={(input) => { setOpen(false); props.onImport(input); }} />}
          <div className="mt-4 flex justify-end">
            <Button autoFocus variant="outline" onClick={() => setOpen(false)}>Done</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function LocalImportList({ connectedUrls, onImport, findings, failed }: LocalImportProps & {
  findings: LocalMcpFinding[] | null;
  failed: boolean;
}) {

  if (failed) return <p role="alert" className="text-sm text-muted-foreground">Could not read local servers. Close this window and try again.</p>;
  if (findings === null) return <p role="status" className="text-sm text-muted-foreground">Looking for local servers…</p>;
  if (findings.length === 0) return <p className="text-sm text-muted-foreground">No servers found in your Claude or Codex configuration.</p>;

  const importable = findings.filter((f) => f.importable && !connectedUrls.has(f.url ?? ''));
  const rest = findings.filter((f) => !f.importable || connectedUrls.has(f.url ?? ''));

  return (
    <div>
      <div className="space-y-2">
        {importable.map((f) => (
          <div key={`${f.source}:${f.name}`} className="flex items-center gap-3 rounded-lg border px-3 py-2">
            <McpServerLogo url={f.url} />
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
              className={cn('flex items-center gap-3 rounded-lg border px-3 py-2 opacity-60')}
            >
              <McpServerLogo url={f.url} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{f.name}</span>
                  <Badge variant="outline">{f.source}</Badge>
                  {already && <Badge variant="secondary">Connected</Badge>}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {already ? 'Already connected to this workspace.' : `Cannot be used here: ${f.reason}`}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

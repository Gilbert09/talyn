import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Workbench, WorkbenchPullRequestChoice } from '@talyn/shared';
import { api } from '../../lib/api';
import { linkSessionPullRequest, parsePullRequestNumber } from '../../lib/linkWorkbenchPullRequest';
import { useWorkbenchStore } from '../../stores/workbenches';
import { Command, CommandInput, CommandItem, CommandList } from '../ui/command';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';

const stateClasses: Record<WorkbenchPullRequestChoice['state'] | 'draft', string> = {
  draft: 'bg-muted text-muted-foreground',
  open: 'bg-success/15 text-success',
  merged: 'bg-merged/15 text-merged',
  closed: 'bg-destructive/15 text-destructive',
};

export function LinkPullRequestDialog({ workbench, onClose }: { workbench: Workbench; onClose: () => void }) {
  const [prs, setPrs] = useState<WorkbenchPullRequestChoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [linkingNumber, setLinkingNumber] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [showClosed, setShowClosed] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    void api.workbenches
      .openPullRequests(workbench.id, { state: showClosed ? 'all' : 'open' })
      .then((rows) => {
        if (active) setPrs(rows);
      })
      .catch((err: unknown) => {
        if (active) setLoadError(err instanceof Error ? err.message : 'Unknown error');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workbench.id, showClosed]);

  const link = async (number: number) => {
    if (linkingNumber !== null) return;
    setLinkError(null);
    setLinkingNumber(number);
    try {
      const updated = await linkSessionPullRequest(api.workbenches, workbench, number);
      useWorkbenchStore.getState().upsertWorkbench(updated);
      onClose();
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'Could not link the pull request.');
      const current = await api.workbenches.get(workbench.id).catch(() => null);
      if (current) useWorkbenchStore.getState().upsertWorkbench(current);
    } finally {
      setLinkingNumber(null);
    }
  };

  const number = parsePullRequestNumber(search, workbench.repoFullName);
  const visible = prs.filter(
    (pr) =>
      pr.number !== number &&
      `${pr.number} ${pr.title} ${pr.headRef} ${pr.author}`.toLowerCase().includes(search.toLowerCase()),
  );
  const badge = (pr: WorkbenchPullRequestChoice) => {
    const state = pr.draft && pr.state === 'open' ? 'draft' : pr.state;
    return (
      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ${stateClasses[state]}`}>
        {state[0].toUpperCase() + state.slice(1)}
      </span>
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && linkingNumber === null) onClose();
      }}
    >
      <DialogContent
        onClose={linkingNumber === null ? onClose : undefined}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && linkingNumber === null) onClose();
        }}
        className="app-region-no-drag max-w-lg overflow-hidden"
      >
        <DialogHeader className="mb-3 gap-1 text-left">
          <DialogTitle>Link pull request</DialogTitle>
          <p className="text-xs text-muted-foreground">{workbench.repoFullName}</p>
        </DialogHeader>
        <Command label="Search pull requests" shouldFilter={false} className="border border-border">
          <CommandInput
            autoFocus
            aria-label="Search pull requests"
            placeholder="Search, or paste a PR number or URL"
            value={search}
            onValueChange={(value) => {
              setSearch(value);
              setLinkError(null);
            }}
            disabled={linkingNumber !== null}
          />
          {linkError && (
            <p role="alert" className="px-3 py-2 text-xs text-destructive">
              {linkError}
            </p>
          )}
          <label className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(event) => setShowClosed(event.target.checked)}
              disabled={linkingNumber !== null}
              className="accent-primary"
            />
            Show merged and closed
          </label>
          <CommandList className="min-h-40 max-h-72" aria-busy={loading || linkingNumber !== null}>
            {number !== null && (
              <CommandItem
                value={`link-${number}`}
                disabled={linkingNumber !== null && linkingNumber !== number}
                onSelect={() => void link(number)}
                className="text-sm"
              >
                {linkingNumber === number && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-label="Linking" />}
                Link #{number}
              </CommandItem>
            )}
            {loading ? (
              <p className="px-3 py-5 text-center text-xs text-muted-foreground">Loading…</p>
            ) : loadError ? (
              <p role="alert" className="px-3 py-3 text-xs text-destructive">
                Could not load pull requests: {loadError}. You can still enter a number or URL.
              </p>
            ) : visible.length === 0 && number === null ? (
              <p className="px-3 py-5 text-center text-xs text-muted-foreground">
                {search && prs.length > 0 ? 'No pull requests match.' : 'No pull requests found.'}
              </p>
            ) : (
              visible.map((pr) => (
                <CommandItem
                  key={pr.number}
                  value={`pr-${pr.number}`}
                  disabled={linkingNumber !== null && linkingNumber !== pr.number}
                  onSelect={() => void link(pr.number)}
                  className="block py-1.5 text-sm"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {linkingNumber === pr.number && (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-label="Linking" />
                    )}
                    <span className="shrink-0 tabular-nums text-muted-foreground">#{pr.number}</span>
                    <span className="min-w-0 flex-1 truncate">{pr.title}</span>
                    {badge(pr)}
                  </span>
                  <span className="block truncate pl-7 text-xs text-muted-foreground">
                    {pr.headRef} · {pr.author}
                  </span>
                </CommandItem>
              ))
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

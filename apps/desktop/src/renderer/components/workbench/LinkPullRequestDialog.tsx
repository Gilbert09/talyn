import { useEffect, useState } from 'react';
import type { OpenWorkbenchPullRequest, Workbench } from '@talyn/shared';
import { api } from '../../lib/api';
import { linkSessionPullRequest, parsePullRequestNumber } from '../../lib/linkWorkbenchPullRequest';
import { getWorkbenchBridge } from '../../lib/workbenchBridge';
import { toast } from '../../stores/toast';
import { useWorkbenchStore } from '../../stores/workbenches';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';

export function LinkPullRequestDialog({ workbench, onClose }: { workbench: Workbench; onClose: () => void }) {
  const [prs, setPrs] = useState<OpenWorkbenchPullRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [input, setInput] = useState('');
  useEffect(() => {
    let active = true;
    void api.workbenches
      .openPullRequests(workbench.id)
      .then((rows) => {
        if (active) setPrs(rows);
      })
      .catch((err: unknown) => {
        if (active) toast.error('Could not load pull requests', err instanceof Error ? err.message : undefined);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workbench.id]);

  const link = async (number: number) => {
    setBusy(true);
    try {
      const updated = await linkSessionPullRequest(api.workbenches, getWorkbenchBridge(), workbench, number);
      useWorkbenchStore.getState().upsertWorkbench(updated);
      onClose();
    } catch (err) {
      toast.error('Could not link the pull request', err instanceof Error ? err.message : undefined);
      const current = await api.workbenches.get(workbench.id).catch(() => null);
      if (current) useWorkbenchStore.getState().upsertWorkbench(current);
    } finally {
      setBusy(false);
    }
  };
  const number = parsePullRequestNumber(input, workbench.repoFullName);
  const visible = prs.filter((pr) =>
    `${pr.number} ${pr.title} ${pr.headRef} ${pr.author}`.toLowerCase().includes(filter.toLowerCase())
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent onClose={busy ? undefined : onClose} className="app-region-no-drag">
        <DialogHeader>
          <DialogTitle>Link pull request</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{workbench.repoFullName}</p>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (number && !busy) void link(number);
          }}
        >
          <Input
            aria-label="PR number or URL"
            placeholder="PR number or URL"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={busy}
          />
          <Button type="submit" disabled={!number || busy}>
            Link
          </Button>
        </form>
        {input && !number && (
          <p className="text-sm text-muted-foreground">Enter a PR number or a URL for this repository.</p>
        )}
        <Input
          aria-label="Filter pull requests"
          placeholder="Filter pull requests"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <div className="max-h-72 overflow-y-auto" aria-busy={loading || busy}>
          {loading ? (
            <p className="text-sm">Loading…</p>
          ) : visible.length === 0 ? (
            <p className="text-sm">No open pull requests found.</p>
          ) : (
            visible.map((pr) => (
              <button
                key={pr.number}
                type="button"
                disabled={busy}
                onClick={() => void link(pr.number)}
                className="block w-full rounded p-2 text-left hover:bg-accent disabled:opacity-50"
              >
                <span className="text-sm">
                  #{pr.number} {pr.title}
                </span>
                {pr.draft && <span className="ml-2 rounded bg-muted px-1 text-xs">Draft</span>}
                <span className="block text-xs text-muted-foreground">
                  {pr.headRef} · {pr.author}
                </span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

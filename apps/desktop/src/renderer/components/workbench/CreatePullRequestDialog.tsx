import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { toast } from '../../stores/toast';
import { useWorkbenchStore } from '../../stores/workbenches';
import type { WorkbenchOps } from '../../lib/workbenchOps';

const DRAFTING = 'Writing a description…';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Create PR. Talyn commits, pushes and opens the pull request itself; an agent
 * only drafts the title and description, in a hidden run that never reaches
 * the chat. The fields stay editable while the draft is written, and a draft
 * that lands late fills only the fields nobody has typed in.
 */
export function CreatePullRequestDialog({
  workbench,
  chat,
  ops,
  open,
  onClose,
}: {
  workbench: Pick<Workbench, 'baseBranch' | 'branch'>;
  chat: WorkbenchChat | null;
  ops: Pick<WorkbenchOps, 'draftPullRequest' | 'createPullRequest'>;
  open: boolean;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState(workbench.baseBranch);
  const [asDraft, setAsDraft] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Refs, because a draft resolves after renders the closure did not see.
  const edited = useRef({ title: false, body: false });
  const commitMessage = useRef('');
  const draftSeq = useRef(0);
  const baseRef = useRef(base);
  baseRef.current = base;

  const draft = useCallback(() => {
    const seq = ++draftSeq.current;
    setDrafting(true);
    setDraftError(null);
    ops
      .draftPullRequest(chat, baseRef.current.trim() || workbench.baseBranch)
      .then((d) => {
        if (seq !== draftSeq.current) return;
        if (!edited.current.title) setTitle(d.title);
        if (!edited.current.body) setBody(d.body);
        commitMessage.current = d.commitMessage;
      })
      .catch((err) => {
        if (seq === draftSeq.current) setDraftError(message(err));
      })
      .finally(() => {
        if (seq === draftSeq.current) setDrafting(false);
      });
  }, [ops, chat, workbench.baseBranch]);

  // A fresh dialog each time it opens, with the draft started at once.
  useEffect(() => {
    if (!open) {
      draftSeq.current++;
      return;
    }
    setTitle('');
    setBody('');
    setBase(workbench.baseBranch);
    baseRef.current = workbench.baseBranch;
    setAsDraft(false);
    setCreateError(null);
    setCreating(false);
    edited.current = { title: false, body: false };
    commitMessage.current = '';
    draft();
    // Only on open: a re-render with a new `ops` must not start a second draft.
  }, [open]);

  const regenerate = () => {
    // Asked for in so many words, so it may replace what is there.
    edited.current = { title: false, body: false };
    draft();
  };

  const cancel = useCallback(() => {
    if (!creating) onClose();
  }, [creating, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, cancel]);

  const create = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const result = await ops.createPullRequest({
        title: title.trim(),
        body,
        base: base.trim() || workbench.baseBranch,
        draft: asDraft,
        commitMessage: commitMessage.current,
      });
      useWorkbenchStore.getState().upsertWorkbench(result.workbench);
      const verb = result.existing ? 'Linked the open pull request' : 'Opened';
      toast.success(`${verb} #${result.pullRequest.number}`, result.pullRequest.url);
      draftSeq.current++;
      onClose();
    } catch (err) {
      setCreateError(message(err));
    } finally {
      setCreating(false);
    }
  };

  const placeholder = (idle: string) => (drafting ? DRAFTING : idle);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && cancel()}>
      <DialogContent className="max-w-xl" role="dialog" aria-modal="true" aria-labelledby="create-pr-title">
        <DialogHeader>
          <DialogTitle id="create-pr-title">Create pull request</DialogTitle>
          <DialogDescription className="text-xs">
            Talyn commits any uncommitted changes, pushes <span className="font-mono">{workbench.branch}</span> and
            opens the pull request. The agent only writes the words.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-[13px]">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="flex min-w-0 items-center gap-1.5" aria-live="polite">
              {drafting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  {DRAFTING}
                </>
              ) : draftError ? (
                <span className="text-destructive" role="alert">
                  Could not write a draft: {draftError} Write the title and description yourself.
                </span>
              ) : null}
            </span>
            <button
              type="button"
              onClick={regenerate}
              disabled={drafting || creating}
              className="inline-flex shrink-0 items-center gap-1 rounded px-1 hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className="h-3 w-3" />
              Regenerate
            </button>
          </div>
          <label className="block space-y-1">
            <span className="text-xs font-medium">Title</span>
            <Input
              aria-label="Title"
              value={title}
              placeholder={placeholder('feat: what this changes')}
              disabled={creating}
              onChange={(e) => {
                edited.current.title = true;
                setTitle(e.target.value);
              }}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium">Description</span>
            <Textarea
              aria-label="Description"
              value={body}
              placeholder={placeholder('What changed and why, and how it was tested. Markdown works.')}
              disabled={creating}
              className="min-h-[200px] font-mono text-xs"
              onChange={(e) => {
                edited.current.body = true;
                setBody(e.target.value);
              }}
            />
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="block min-w-[12rem] flex-1 space-y-1">
              <span className="text-xs font-medium">Base branch</span>
              <Input
                aria-label="Base branch"
                value={base}
                disabled={creating}
                className="font-mono text-xs"
                onChange={(e) => setBase(e.target.value)}
              />
            </label>
            <label className="flex h-8 items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={asDraft}
                disabled={creating}
                onChange={(e) => setAsDraft(e.target.checked)}
              />
              Create as draft
            </label>
          </div>
          {createError && (
            <p className="whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive" role="alert">
              {createError}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={cancel} disabled={creating}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void create()} disabled={creating || !title.trim() || !base.trim()}>
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {creating ? 'Creating…' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

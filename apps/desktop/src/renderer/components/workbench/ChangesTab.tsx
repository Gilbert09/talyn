import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileDiff,
  FileMinus,
  FilePlus,
  FileText,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  SendHorizontal,
  X,
} from 'lucide-react';
import { PatchDiff } from '@pierre/diffs/react';
import type { Workbench, WorkbenchChangedFile, WorkbenchChanges, WorkbenchChat } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { formatCommentsMessage, type DiffComment } from '../../lib/workbenchFormat';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { newClientId } from '../../lib/workbenchBridge';
import {
  isViewed,
  loadViewed,
  markViewed,
  reconcileViewed,
  reconcileViewedPatch,
  saveViewed,
  unmarkViewed,
  type ViewedMap,
} from '../../lib/viewedFiles';
import { toast } from '../../stores/toast';
import { Button } from '../ui/button';
import { createChatTab } from './ChatTabs';

/** How often the list refreshes while it is on screen. */
export const CHANGES_REFRESH_MS = 10_000;

interface Selection {
  side: 'additions' | 'deletions';
  start: number;
  end: number;
}

const STATUS_ICON = { added: FilePlus, deleted: FileMinus, renamed: FileDiff, modified: FileText } as const;

/**
 * The branch's changes against its base: the file list with a Viewed mark
 * per file, a unified diff of the chosen file, and line comments that collect
 * in a bar and go into the composer as one message.
 */
export function ChangesTab({
  workbench,
  chat,
  ops,
  visible,
  turnsEnded,
  comments,
  setComments,
}: {
  workbench: Workbench;
  chat: WorkbenchChat | null;
  ops: WorkbenchOps;
  visible: boolean;
  /** Bumps each time a turn in this workbench ends — a refresh trigger. */
  turnsEnded: number;
  comments: DiffComment[];
  setComments: (next: DiffComment[]) => void;
}) {
  const [changes, setChanges] = useState<WorkbenchChanges | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [viewed, setViewedState] = useState<ViewedMap>(() => loadViewed(workbench.id));
  /** Viewed files whose diff is shown anyway, because the person opened it again. */
  const [expanded, setExpanded] = useState<Record<string, true>>({});
  const loadingRef = useRef(false);
  const viewedRef = useRef(viewed);
  /** The turn count the viewed marks were last checked against by patch hash. */
  const verifiedAt = useRef<number | null>(null);

  const setViewed = useCallback(
    (update: (cur: ViewedMap) => ViewedMap) => {
      const next = update(viewedRef.current);
      if (next === viewedRef.current) return;
      viewedRef.current = next;
      setViewedState(next);
      saveViewed(workbench.id, next);
    },
    [workbench.id]
  );

  // An edit that keeps the line counts only shows in the patch text, so after
  // a turn each viewed file's patch is read again and compared.
  const verifyViewed = useCallback(
    async (files: WorkbenchChangedFile[]) => {
      for (const f of files) {
        if (!viewedRef.current[f.path]) continue;
        try {
          const patch = await ops.diff(f.path);
          setViewed((cur) => reconcileViewedPatch(cur, f.path, patch));
        } catch {
          // A failed read proves nothing either way; the mark stays.
        }
      }
    },
    [ops, setViewed]
  );

  const refresh = useCallback(async () => {
    if (ops.unavailable || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const next = await ops.changes();
      setChanges(next);
      setError(null);
      setViewed((cur) => reconcileViewed(cur, next.files));
      if (verifiedAt.current !== turnsEnded) {
        verifiedAt.current = turnsEnded;
        void verifyViewed(next.files);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the changes.');
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [ops, setViewed, verifyViewed, turnsEnded]);

  useEffect(() => {
    setChanges(null);
    setSelectedPath(null);
    setExpanded({});
    const loaded = loadViewed(workbench.id);
    viewedRef.current = loaded;
    setViewedState(loaded);
    verifiedAt.current = null;
  }, [workbench.id]);

  useEffect(() => {
    if (visible && !ops.unavailable) void refresh();
    // `refresh` changes with `turnsEnded`; listing both is the same trigger.
  }, [visible, turnsEnded, refresh, ops.unavailable]);

  useEffect(() => {
    if (!visible || ops.unavailable) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, CHANGES_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [visible, refresh, ops.unavailable]);

  const files = changes?.files ?? [];
  const selected = files.find((f) => f.path === selectedPath) ?? null;
  const viewedCount = files.filter((f) => isViewed(viewed, f)).length;

  const toggleViewed = async (file: WorkbenchChangedFile) => {
    if (isViewed(viewedRef.current, file)) {
      setViewed((cur) => unmarkViewed(cur, file.path));
      return;
    }
    try {
      const patch = await ops.diff(file.path);
      setViewed((cur) => markViewed(cur, file, patch));
      setExpanded((cur) => {
        if (!cur[file.path]) return cur;
        const next = { ...cur };
        delete next[file.path];
        return next;
      });
      // Move on to the next file still to read, as a review tool does.
      if (selectedPath === file.path) {
        const i = files.findIndex((f) => f.path === file.path);
        const next = [...files.slice(i + 1), ...files.slice(0, i)].find(
          (f) => f.path !== file.path && !isViewed(viewedRef.current, f)
        );
        if (next) setSelectedPath(next.path);
      }
    } catch (err) {
      toast.error('Could not mark the file as viewed', err instanceof Error ? err.message : undefined);
    }
  };

  if (ops.unavailable) return <p className="p-3 text-xs text-muted-foreground">{ops.unavailable}</p>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b px-3 py-1.5 text-xs text-muted-foreground">
        <span>
          {files.length} {files.length === 1 ? 'file' : 'files'} changed
          {viewedCount > 0 && (
            <span className="ml-2" data-testid="viewed-count">
              {viewedCount}/{files.length} viewed
            </span>
          )}
          {changes && (
            <span className="ml-2 tabular-nums">
              <span className="text-success">+{files.reduce((n, f) => n + f.added, 0)}</span>{' '}
              <span className="text-destructive">−{files.reduce((n, f) => n + f.removed, 0)}</span>
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          className="rounded p-1 hover:bg-accent hover:text-foreground"
          title="Refresh"
          aria-label="Refresh the changes"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        </button>
      </div>
      {error && <p className="px-3 py-2 text-xs text-destructive">{error}</p>}
      {!changes && loading && (
        <div className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading changes…
        </div>
      )}
      {changes && files.length === 0 && (
        <p className="px-3 py-4 text-xs text-muted-foreground">No changes against {workbench.baseBranch} yet.</p>
      )}
      {files.length > 0 && (
        <ul className="max-h-[40%] shrink-0 overflow-y-auto border-b">
          {files.map((f) => (
            <FileRow
              key={f.path}
              file={f}
              active={f.path === selectedPath}
              viewed={isViewed(viewed, f)}
              onClick={() => setSelectedPath(f.path)}
              onToggleViewed={() => void toggleViewed(f)}
            />
          ))}
        </ul>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {selected && isViewed(viewed, selected) && !expanded[selected.path] ? (
          <button
            type="button"
            onClick={() => setExpanded((cur) => ({ ...cur, [selected.path]: true }))}
            className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          >
            <ChevronRight className="h-3.5 w-3.5" />
            Viewed. Show the diff again.
          </button>
        ) : (
          selected && (
            <>
              {isViewed(viewed, selected) && (
                <button
                  type="button"
                  onClick={() =>
                    setExpanded((cur) => {
                      const next = { ...cur };
                      delete next[selected.path];
                      return next;
                    })
                  }
                  className="flex w-full items-center gap-1.5 border-b px-3 py-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
                >
                  <ChevronDown className="h-3 w-3" /> Viewed. Collapse.
                </button>
              )}
              <FileDiffView
                key={`${selected.path}:${changes?.headSha ?? ''}`}
                file={selected}
                ops={ops}
                refreshKey={turnsEnded}
                onPatch={(patch) => setViewed((cur) => reconcileViewedPatch(cur, selected.path, patch))}
                onComment={(c) => setComments([...comments, c])}
              />
            </>
          )
        )}
      </div>
      <CommentBar workbench={workbench} chat={chat} ops={ops} comments={comments} setComments={setComments} />
    </div>
  );
}

function FileRow({
  file,
  active,
  viewed,
  onClick,
  onToggleViewed,
}: {
  file: WorkbenchChangedFile;
  active: boolean;
  viewed: boolean;
  onClick: () => void;
  onToggleViewed: () => void;
}) {
  const Icon = STATUS_ICON[file.status];
  return (
    <li className={cn('flex items-center', active ? 'bg-secondary' : 'hover:bg-accent/60', viewed && 'opacity-60')}>
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2 py-1 pl-3 text-left text-xs"
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      >
        <Icon
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            file.status === 'added' && 'text-success',
            file.status === 'deleted' && 'text-destructive',
            (file.status === 'modified' || file.status === 'renamed') && 'text-muted-foreground'
          )}
        />
        <span dir="rtl" className="min-w-0 flex-1 truncate text-left font-mono">
          <bdi>{file.path}</bdi>
        </span>
        {file.binary ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">binary</span>
        ) : (
          <span className="shrink-0 text-[11px] tabular-nums">
            {file.added > 0 && <span className="text-success">+{file.added}</span>}
            {file.added > 0 && file.removed > 0 && ' '}
            {file.removed > 0 && <span className="text-destructive">−{file.removed}</span>}
          </span>
        )}
      </button>
      <label
        className="flex shrink-0 cursor-pointer items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
        title={viewed ? 'Mark as not viewed' : 'Mark as viewed. A later change to this diff clears the mark.'}
      >
        <input
          type="checkbox"
          checked={viewed}
          onChange={onToggleViewed}
          className="h-3 w-3 accent-primary"
          aria-label={`Viewed ${file.path}`}
        />
        Viewed
      </label>
    </li>
  );
}

function FileDiffView({
  file,
  ops,
  refreshKey,
  onPatch,
  onComment,
}: {
  file: WorkbenchChangedFile;
  ops: WorkbenchOps;
  refreshKey: number;
  /** Every patch read, so a Viewed mark can be checked against it. */
  onPatch?: (patch: string) => void;
  onComment: (comment: DiffComment) => void;
}) {
  const onPatchRef = useRef(onPatch);
  onPatchRef.current = onPatch;
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    let cancelled = false;
    ops
      .diff(file.path)
      .then((p) => {
        if (cancelled) return;
        setPatch(p);
        onPatchRef.current?.(p);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [file.path, ops, refreshKey]);

  const options = useMemo(
    () => ({
      diffStyle: 'unified' as const,
      enableLineSelection: true,
      onLineSelected: (range: { start: number; end: number; side?: 'additions' | 'deletions' } | null) => {
        if (!range) return;
        const start = Math.min(range.start, range.end);
        const end = Math.max(range.start, range.end);
        setSelection({ side: range.side ?? 'additions', start, end });
      },
    }),
    []
  );

  if (error) return <p className="p-3 text-xs text-destructive">{error}</p>;
  if (patch === null) {
    return (
      <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading diff…
      </div>
    );
  }
  if (!patch.trim()) {
    return <p className="p-3 text-xs text-muted-foreground">{file.binary ? 'Binary file — no text diff.' : 'No text changes.'}</p>;
  }

  const addComment = () => {
    if (!selection || !draft.trim()) return;
    onComment({ id: newClientId(), path: file.path, side: selection.side, startLine: selection.start, endLine: selection.end, text: draft.trim() });
    setDraft('');
    setSelection(null);
  };

  return (
    <div>
      <div className="max-w-full overflow-x-auto">
        <PatchDiff
          patch={patch}
          options={options}
          selectedLines={selection ? { start: selection.start, end: selection.end, side: selection.side } : null}
        />
      </div>
      {selection ? (
        <div className="space-y-1.5 border-t bg-muted/30 p-2">
          <div className="text-[11px] text-muted-foreground">
            Comment on {selection.start === selection.end ? `line ${selection.start}` : `lines ${selection.start}–${selection.end}`}
          </div>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addComment();
              if (e.key === 'Escape') setSelection(null);
            }}
            rows={2}
            className="block w-full resize-y rounded border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
            placeholder="What should change here? (⌘Enter to add)"
            aria-label="Line comment"
          />
          <div className="flex justify-end gap-1">
            <Button variant="ghost" className="h-6 px-2 text-xs" onClick={() => setSelection(null)}>
              Cancel
            </Button>
            <Button className="h-6 px-2 text-xs" onClick={addComment} disabled={!draft.trim()}>
              Add comment
            </Button>
          </div>
        </div>
      ) : (
        <p className="flex items-center gap-1 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
          <MessageSquarePlus className="h-3 w-3" /> Click a line number (shift-click for a range) to comment.
        </p>
      )}
    </div>
  );
}

/**
 * The line comments waiting to go to the agent. "Send" sends them to the open
 * chat as one message; a running turn queues it.
 */
function CommentBar({
  workbench,
  chat,
  ops,
  comments,
  setComments,
}: {
  workbench: Workbench;
  chat: WorkbenchChat | null;
  ops: WorkbenchOps;
  comments: DiffComment[];
  setComments: (next: DiffComment[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  if (comments.length === 0) return null;
  const send = async () => {
    setSending(true);
    try {
      const target = chat ?? (await createChatTab(workbench));
      if (!target) return;
      const res = await ops.send(target, { text: formatCommentsMessage(comments) });
      setComments([]);
      setOpen(false);
      if (res.queued) toast.info('Queued', 'It runs when the current turn ends.');
    } catch (err) {
      toast.error('Could not send the comments', err instanceof Error ? err.message : undefined);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="shrink-0 border-t bg-info/10" data-testid="comment-bar">
      {open && (
        <ul className="max-h-32 space-y-1 overflow-y-auto border-b px-3 py-1.5">
          {comments.map((c) => (
            <li key={c.id} className="flex items-start gap-1.5 text-xs">
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {c.path.split('/').pop()}:{c.startLine}
                {c.endLine !== c.startLine ? `–${c.endLine}` : ''}
              </span>
              <span className="min-w-0 flex-1 truncate">{c.text}</span>
              <button
                type="button"
                onClick={() => setComments(comments.filter((x) => x.id !== c.id))}
                className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Remove the comment"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-foreground/90 hover:text-foreground"
          aria-expanded={open}
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {comments.length} {comments.length === 1 ? 'comment' : 'comments'} ready to send
        </button>
        <Button
          className="h-6 gap-1 px-2 text-xs"
          onClick={() => void send()}
          disabled={sending || ops.unavailable !== null}
          title={ops.unavailable ?? undefined}
        >
          {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <SendHorizontal className="h-3 w-3" />} Send to agent
        </Button>
      </div>
    </div>
  );
}

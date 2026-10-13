import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileDiff, FileMinus, FilePlus, FileText, Loader2, MessageSquarePlus, RefreshCw, Send, X } from 'lucide-react';
import { PatchDiff } from '@pierre/diffs/react';
import type { Workbench, WorkbenchChangedFile, WorkbenchChanges, WorkbenchChat } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { formatCommentsMessage, type DiffComment } from '../../lib/workbenchFormat';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { newClientId } from '../../lib/workbenchBridge';
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
 * The branch's changes against its base: the file list, a unified diff of the
 * chosen file, and line comments that collect in a tray and go to the agent
 * as one message.
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
  const loadingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (ops.unavailable || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      setChanges(await ops.changes());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the changes.');
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [ops]);

  useEffect(() => {
    setChanges(null);
    setSelectedPath(null);
  }, [workbench.id]);

  useEffect(() => {
    if (visible) void refresh();
  }, [visible, turnsEnded, refresh]);

  useEffect(() => {
    if (!visible) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, CHANGES_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [visible, refresh]);

  const files = changes?.files ?? [];
  const selected = files.find((f) => f.path === selectedPath) ?? null;

  if (ops.unavailable) return <p className="p-3 text-xs text-muted-foreground">{ops.unavailable}</p>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b px-3 py-1.5 text-xs text-muted-foreground">
        <span>
          {files.length} {files.length === 1 ? 'file' : 'files'} changed
          {changes && (
            <span className="ml-2 tabular-nums">
              <span className="text-emerald-600 dark:text-emerald-500">+{files.reduce((n, f) => n + f.added, 0)}</span>{' '}
              <span className="text-red-600 dark:text-red-500">−{files.reduce((n, f) => n + f.removed, 0)}</span>
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
      {error && <p className="px-3 py-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
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
            <FileRow key={f.path} file={f} active={f.path === selectedPath} onClick={() => setSelectedPath(f.path)} />
          ))}
        </ul>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {selected && (
          <FileDiffView
            key={`${selected.path}:${changes?.headSha ?? ''}`}
            file={selected}
            ops={ops}
            refreshKey={turnsEnded}
            onComment={(c) => setComments([...comments, c])}
          />
        )}
      </div>
      <CommentTray workbench={workbench} chat={chat} ops={ops} comments={comments} setComments={setComments} />
    </div>
  );
}

function FileRow({ file, active, onClick }: { file: WorkbenchChangedFile; active: boolean; onClick: () => void }) {
  const Icon = STATUS_ICON[file.status];
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn('flex w-full items-center gap-2 px-3 py-1 text-left text-xs', active ? 'bg-secondary' : 'hover:bg-accent/60')}
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      >
        <Icon
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            file.status === 'added' && 'text-emerald-600 dark:text-emerald-500',
            file.status === 'deleted' && 'text-red-600 dark:text-red-500',
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
            {file.added > 0 && <span className="text-emerald-600 dark:text-emerald-500">+{file.added}</span>}
            {file.added > 0 && file.removed > 0 && ' '}
            {file.removed > 0 && <span className="text-red-600 dark:text-red-500">−{file.removed}</span>}
          </span>
        )}
      </button>
    </li>
  );
}

function FileDiffView({
  file,
  ops,
  refreshKey,
  onComment,
}: {
  file: WorkbenchChangedFile;
  ops: WorkbenchOps;
  refreshKey: number;
  onComment: (comment: DiffComment) => void;
}) {
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    let cancelled = false;
    ops
      .diff(file.path)
      .then((p) => {
        if (!cancelled) setPatch(p);
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

  if (error) return <p className="p-3 text-xs text-red-600 dark:text-red-400">{error}</p>;
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

function CommentTray({
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
  const [sending, setSending] = useState(false);
  if (comments.length === 0) return null;
  const send = async () => {
    setSending(true);
    try {
      const target = chat ?? (await createChatTab(workbench));
      if (!target) return;
      const res = await ops.send(target, { text: formatCommentsMessage(comments) });
      setComments([]);
      toast.info(res.queued ? 'Comments queued' : 'Comments sent to the agent');
    } catch (err) {
      toast.error('Could not send the comments', err instanceof Error ? err.message : undefined);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="shrink-0 border-t bg-muted/20 p-2">
      <ul className="mb-2 max-h-32 space-y-1 overflow-y-auto">
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
      <Button className="h-7 w-full gap-1.5 text-xs" onClick={() => void send()} disabled={sending || Boolean(ops.unavailable)}>
        {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        Send {comments.length} {comments.length === 1 ? 'comment' : 'comments'} to agent
      </Button>
    </div>
  );
}

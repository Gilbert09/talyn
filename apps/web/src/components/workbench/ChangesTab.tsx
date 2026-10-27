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
import type { Workbench, WorkbenchChangedFile, WorkbenchChanges, WorkbenchChat, WorkbenchDiffScope } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { formatCommentsMessage, type DiffComment } from '../../lib/workbenchFormat';
import type { WorkbenchOps } from '../../lib/workbenchOps';
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

const STATUS_ICON = {
  added: FilePlus,
  deleted: FileMinus,
  renamed: FileDiff,
  modified: FileText,
} as const;

/**
 * The branch's changes against its base: the file list, a unified diff of the chosen file, and line comments that collect
 * in a bar and go to the agent as one message.
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
  const [selection, setSelection] = useState<{ path: string; scope: WorkbenchDiffScope } | null>(null);
  const [collapsed, setCollapsed] = useState<Partial<Record<WorkbenchDiffScope, boolean>>>({});
  const [showMergedDiff, setShowMergedDiff] = useState(false);
  const loadingRef = useRef(false);
  const merged = workbench.pr?.state === 'merged';
  const showChanges = !merged || showMergedDiff;

  const refresh = useCallback(async () => {
    if (ops.unavailable || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const next = await ops.changes();
      setChanges(next);
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
    setSelection(null);
    setCollapsed({});
    setShowMergedDiff(false);
  }, [workbench.id]);

  useEffect(() => {
    if (visible && showChanges && !ops.unavailable) void refresh();
  }, [visible, showChanges, turnsEnded, refresh, ops.unavailable]);

  useEffect(() => {
    if (!visible || !showChanges || ops.unavailable) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, CHANGES_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [visible, showChanges, refresh, ops.unavailable]);

  const files = changes?.files ?? [];
  const groups = changes?.uncommitted && changes.committed ? [
    { scope: 'uncommitted' as const, label: 'Uncommitted', files: changes.uncommitted, empty: 'No uncommitted changes.' },
    { scope: 'committed' as const, label: 'Committed on this branch', files: changes.committed, empty: 'No committed changes.' },
  ] : [{ scope: 'combined' as const, label: 'Changes against base', files, empty: 'No changes against the base branch.' }];
  const selected = groups.find((g) => g.scope === selection?.scope)?.files.find((f) => f.path === selection?.path) ?? null;

  if (merged && !showMergedDiff) {
    return (
      <div className="space-y-2 p-3 text-xs text-muted-foreground">
        <p>
          PR #{workbench.pr?.number} merged. Its changes are in {workbench.baseBranch}.
        </p>
        <Button variant="outline" size="sm" onClick={() => setShowMergedDiff(true)}>
          Show the branch diff anyway
        </Button>
      </div>
    );
  }

  if (ops.unavailable) return <p className="p-3 text-xs text-muted-foreground">{ops.unavailable}</p>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b px-3 py-1.5 text-xs text-muted-foreground">
        <span>Changes</span>
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
      {changes && (
        <div className="max-h-[40%] shrink-0 overflow-y-auto border-b">
          {groups.map((group) => (
            <section key={group.scope} aria-label={group.label}>
              <button
                type="button"
                aria-expanded={!collapsed[group.scope]}
                onClick={() => setCollapsed((current) => ({ ...current, [group.scope]: !current[group.scope] }))}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent/60"
              >
                {collapsed[group.scope] ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                <span className="font-medium">{group.label}</span>
                <span className="text-muted-foreground">{group.files.length} {group.files.length === 1 ? 'file' : 'files'}</span>
                <span className="ml-auto tabular-nums">
                  <span className="text-success">+{group.files.reduce((n, f) => n + f.added, 0)}</span>{' '}
                  <span className="text-destructive">−{group.files.reduce((n, f) => n + f.removed, 0)}</span>
                </span>
              </button>
              {!collapsed[group.scope] && (group.files.length === 0 ? (
                <p className="px-3 pb-3 text-xs text-muted-foreground">{group.empty}</p>
              ) : (
                <ul>
                  {group.files.map((f) => (
                    <FileRow
                      key={f.path}
                      file={f}
                      active={f.path === selection?.path && group.scope === selection.scope}
                      onClick={() => setSelection((current) => current?.path === f.path && current.scope === group.scope
                        ? null : { path: f.path, scope: group.scope })}
                    />
                  ))}
                </ul>
              ))}
            </section>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {selected && selection && (
          <FileDiffView
            key={`${selection?.scope}:${selected.path}:${changes?.headSha ?? ''}`}
            file={selected}
            scope={selection.scope}
            ops={ops}
            refreshKey={turnsEnded}
            onComment={(c) => setComments([...comments, c])}
          />
        )}
      </div>
      <CommentBar workbench={workbench} chat={chat} ops={ops} comments={comments} setComments={setComments} />
    </div>
  );
}

function FileRow({ file, active, onClick }: { file: WorkbenchChangedFile; active: boolean; onClick: () => void }) {
  const Icon = STATUS_ICON[file.status];
  return (
    <li className={cn('flex items-center', active ? 'bg-secondary' : 'hover:bg-accent/60')}>
      <button
        type="button"
        onClick={onClick}
        aria-expanded={active}
        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1 text-left text-xs"
        title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      >
        <Icon
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            file.status === 'added' && 'text-success',
            file.status === 'deleted' && 'text-destructive',
            (file.status === 'modified' || file.status === 'renamed') && 'text-muted-foreground',
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
    </li>
  );
}

function FileDiffView({
  file,
  scope,
  ops,
  refreshKey,
  onComment,
}: {
  file: WorkbenchChangedFile;
  scope: WorkbenchDiffScope;
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
      .diff(file.path, scope)
      .then((p) => {
        if (cancelled) return;
        setPatch(p);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [file.path, scope, ops, refreshKey]);

  const options = useMemo(
    () => ({
      diffStyle: 'unified' as const,
      enableLineSelection: true,
      onLineSelected: (
        range: {
          start: number;
          end: number;
          side?: 'additions' | 'deletions';
        } | null,
      ) => {
        if (!range) return;
        const start = Math.min(range.start, range.end);
        const end = Math.max(range.start, range.end);
        setSelection({ side: range.side ?? 'additions', start, end });
      },
    }),
    [],
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
    return (
      <p className="p-3 text-xs text-muted-foreground">
        {file.binary ? 'Binary file — no text diff.' : 'No text changes.'}
      </p>
    );
  }

  const addComment = () => {
    if (!selection || !draft.trim()) return;
    onComment({
      id: crypto.randomUUID(),
      path: file.path,
      side: selection.side,
      startLine: selection.start,
      endLine: selection.end,
      text: draft.trim(),
    });
    setDraft('');
    setSelection(null);
  };

  return (
    <div>
      <div className="max-w-full overflow-x-auto">
        <PatchDiff
          patch={patch}
          options={options}
          selectedLines={
            selection
              ? {
                  start: selection.start,
                  end: selection.end,
                  side: selection.side,
                }
              : null
          }
        />
      </div>
      {selection ? (
        <div className="space-y-1.5 border-t bg-muted/30 p-2">
          <div className="text-[11px] text-muted-foreground">
            Comment on{' '}
            {selection.start === selection.end
              ? `line ${selection.start}`
              : `lines ${selection.start}–${selection.end}`}
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
      const res = await ops.send(target, {
        text: formatCommentsMessage(comments),
      });
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
          {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <SendHorizontal className="h-3 w-3" />} Send to
          agent
        </Button>
      </div>
    </div>
  );
}

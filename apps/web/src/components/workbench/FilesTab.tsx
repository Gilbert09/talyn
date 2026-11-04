import { Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Loader2, RefreshCw, X } from 'lucide-react';
import type { Workbench, WorkbenchFileContent, WorkbenchFileList } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { trackEvent } from '../../lib/analytics';
import { captureWorkbenchFailure } from '../../lib/workbenchAnalytics';
import { buildFileTree, type FileTreeNode } from '../../lib/workbenchFormat';
import { needsWake, type WorkbenchOps } from '../../lib/workbenchOps';
import { RECONNECTING_TEXT, readWithReconnect } from '../../lib/sandboxReconnect';
import { FileIcon } from './FileIcon';
import { StoredBanner } from './StoredBanner';
import { Button } from '../ui/button';
import { lazyWithReload } from '../../lib/lazyWithReload';

// Monaco is large, so it loads only when a file opens.
const CodeViewer = lazyWithReload(() => import('./CodeViewer'));

/** Every file on the branch as a tree, and a read-only viewer for the one picked. */
export function FilesTab({ workbench, ops, visible }: { workbench: Workbench; ops: WorkbenchOps; visible: boolean }) {
  const [list, setList] = useState<WorkbenchFileList | null>(null);
  const paths = list?.paths ?? null;
  const [error, setError] = useState<string | null>(null);
  const [wake, setWake] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);

  // Test doubles may leave `readUnavailable` out: then `unavailable` decides, as before.
  const blocked = ops.readUnavailable !== undefined ? ops.readUnavailable : ops.unavailable;
  // Only a person's refresh passes `live`: it wakes a sleeping sandbox.
  const load = (live = false) => {
    if (blocked) return;
    setLoading(true);
    readWithReconnect(() => ops.files(live ? { live: true } : undefined), {
      onReconnecting: (r) => alive.current && setReconnecting(r),
      isCancelled: () => !alive.current,
    })
      .then((next) => {
        if (live && workbench.sandboxState === 'suspended') trackEvent('session_sandbox_woken', { workbench_id: workbench.id, source: 'user_refresh' });
        setList(next);
        setError(null);
        setWake(false);
      })
      .catch((err: Error) => {
        if (live) captureWorkbenchFailure('refresh_files', err, workbench.id);
        if (needsWake(err)) setWake(true);
        else setError(err.message);
      })
      .finally(() => alive.current && setLoading(false));
  };

  useEffect(() => {
    setList(null);
    setWake(false);
    setSelected(null);
    setOpenDirs(new Set());
  }, [workbench.id]);

  useEffect(() => {
    if (visible && paths === null && !wake) load();
  }, [visible, paths, ops, wake]);

  const tree = useMemo(() => buildFileTree(paths ?? []), [paths]);

  if (blocked) return <p className="p-3 text-xs text-muted-foreground">{blocked}</p>;

  const toggle = (path: string) =>
    setOpenDirs((cur) => {
      const next = new Set(cur);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b px-3 py-1.5 text-xs text-muted-foreground">
        <span>{paths ? `${paths.length} files` : 'Files'}</span>
        <button
          type="button"
          onClick={() => load(true)}
          className="rounded p-1 hover:bg-accent hover:text-foreground"
          title={list?.snapshotAt ? 'Wake the sandbox and refresh' : 'Refresh'}
          aria-label="Refresh the file list"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        </button>
      </div>
      {reconnecting ? <p className="px-3 py-1.5 text-[11px] text-muted-foreground" data-testid="sandbox-reconnecting">{RECONNECTING_TEXT}</p> : error && <p className="px-3 py-2 text-xs text-destructive">{error}</p>}
      {list?.snapshotAt && (
        <StoredBanner
          changes={{ snapshotAt: list.snapshotAt, storedReason: workbench.archivedAt ? 'archived' : 'asleep' }}
          what="files"
          onRefresh={() => load(true)}
        />
      )}
      {wake && (
        <div className="space-y-2 border-b p-3 text-xs text-muted-foreground" data-testid="files-not-stored">
          <p>The sandbox is asleep and Talyn has no stored copy of its files.</p>
          <Button variant="outline" size="sm" onClick={() => load(true)}>
            Wake the sandbox to see them
          </Button>
        </div>
      )}
      <div
        data-testid="file-tree"
        className={cn('min-h-0 overflow-y-auto py-1', selected ? 'max-h-[40%] shrink-0 border-b' : 'flex-1')}
      >
        {paths === null && loading && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading files…
          </div>
        )}
        <TreeLevel
          nodes={tree}
          depth={0}
          openDirs={openDirs}
          toggle={toggle}
          selected={selected}
          onSelect={setSelected}
        />
      </div>
      {selected && (
        <div className="min-h-0 flex-1">
          <FileViewer key={selected} path={selected} ops={ops} onClose={() => setSelected(null)} />
        </div>
      )}
    </div>
  );
}

function TreeLevel({
  nodes,
  depth,
  openDirs,
  toggle,
  selected,
  onSelect,
}: {
  nodes: FileTreeNode[];
  depth: number;
  openDirs: Set<string>;
  toggle: (path: string) => void;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <ul>
      {nodes.map((node) => {
        const isDir = node.children !== null;
        const open = isDir && openDirs.has(node.path);
        return (
          <li key={node.path}>
            <button
              type="button"
              onClick={() => (isDir ? toggle(node.path) : onSelect(node.path))}
              className={cn(
                'flex w-full items-center gap-1 py-0.5 pr-2 text-left text-xs',
                node.path === selected ? 'bg-secondary' : 'hover:bg-accent/60',
              )}
              style={{ paddingLeft: `${8 + depth * 12}px` }}
              aria-expanded={isDir ? open : undefined}
            >
              {isDir ? (
                open ? (
                  <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                )
              ) : (
                <span className="w-3 shrink-0" />
              )}
              <FileIcon name={node.name} folder={isDir} open={open} />
              <span className="truncate font-mono">{node.name}</span>
            </button>
            {open && node.children && (
              <TreeLevel
                nodes={node.children}
                depth={depth + 1}
                openDirs={openDirs}
                toggle={toggle}
                selected={selected}
                onSelect={onSelect}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function FileViewer({ path, ops, onClose }: { path: string; ops: WorkbenchOps; onClose: () => void }) {
  const [file, setFile] = useState<WorkbenchFileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wake, setWake] = useState(false);
  const [live, setLive] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  useEffect(() => {
    let cancelled = false;
    readWithReconnect(() => (live ? ops.readFile(path, { live: true }) : ops.readFile(path)), {
      onReconnecting: (r) => !cancelled && setReconnecting(r),
      isCancelled: () => cancelled,
    })
      .then((f) => {
        if (cancelled) return;
        setFile(f);
        setWake(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        if (needsWake(err) && !live) setWake(true);
        else setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [path, ops, live]);

  // Monaco stops the event when it uses Escape itself (to close find, say), so
  // only an Escape that nothing inside wanted reaches this handler.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };

  const loading = (
    <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading {path}…
    </div>
  );
  let body: ReactNode;
  if (reconnecting) body = <p className="p-3 text-[11px] text-muted-foreground" data-testid="sandbox-reconnecting">{RECONNECTING_TEXT}</p>;
  else if (error) body = <p className="p-3 text-xs text-destructive">{error}</p>;
  else if (wake) {
    body = (
      <div className="space-y-2 p-3 text-xs text-muted-foreground" data-testid="file-not-stored">
        <p>This file is not stored.</p>
        <Button variant="outline" size="sm" onClick={() => { setWake(false); setLive(true); }}>
          Wake the sandbox to see it
        </Button>
      </div>
    );
  }
  else if (!file) body = loading;
  else if (file.binary) body = <p className="p-3 text-xs text-muted-foreground">{path} is a binary file.</p>;
  else {
    body = (
      <Suspense fallback={loading}>
        <CodeViewer path={path} content={file.content} />
      </Suspense>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      <div className="flex shrink-0 items-center gap-2 border-b bg-background py-1 pl-3 pr-1.5 font-mono text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={path}>
          {path}
        </span>
        {file?.source === 'github' && (
          <span className="shrink-0 font-sans" data-testid="file-from-github">
            from GitHub{file.ref ? ` at ${file.ref.slice(0, 7)}` : ''}
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 hover:bg-accent hover:text-foreground"
          title="Close file (Esc)"
          aria-label="Close file"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}

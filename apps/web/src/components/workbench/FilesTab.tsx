import { Suspense, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Loader2, RefreshCw, X } from 'lucide-react';
import type { Workbench } from '@talyn/shared';
import { cn } from '../../lib/utils';
import { buildFileTree, type FileTreeNode } from '../../lib/workbenchFormat';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { FileIcon } from './FileIcon';
import { lazyWithReload } from '../../lib/lazyWithReload';

// Monaco is large, so it loads only when a file opens.
const CodeViewer = lazyWithReload(() => import('./CodeViewer'));

/** Every file on the branch as a tree, and a read-only viewer for the one picked. */
export function FilesTab({ workbench, ops, visible }: { workbench: Workbench; ops: WorkbenchOps; visible: boolean }) {
  const [paths, setPaths] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);

  const load = () => {
    if (ops.unavailable) return;
    setLoading(true);
    ops
      .listFiles()
      .then((p) => {
        setPaths(p);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    setPaths(null);
    setSelected(null);
    setOpenDirs(new Set());
  }, [workbench.id]);

  useEffect(() => {
    if (visible && paths === null) load();
  }, [visible, paths, ops]);

  const tree = useMemo(() => buildFileTree(paths ?? []), [paths]);

  if (ops.unavailable) return <p className="p-3 text-xs text-muted-foreground">{ops.unavailable}</p>;

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
          onClick={load}
          className="rounded p-1 hover:bg-accent hover:text-foreground"
          title="Refresh"
          aria-label="Refresh the file list"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        </button>
      </div>
      {error && <p className="px-3 py-2 text-xs text-destructive">{error}</p>}
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
  const [file, setFile] = useState<{ content: string; binary: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    ops
      .readFile(path)
      .then((f) => {
        if (!cancelled) setFile(f);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [path, ops]);

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
  if (error) body = <p className="p-3 text-xs text-destructive">{error}</p>;
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

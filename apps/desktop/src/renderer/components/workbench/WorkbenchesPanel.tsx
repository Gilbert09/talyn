import { useEffect, useRef } from 'react';
import { Loader2, Plus, SquareTerminal } from 'lucide-react';
import { useWorkspaceStore } from '../../stores/workspace';
import { useWorkbenchStore, visibleChats } from '../../stores/workbenches';
import { loadWorkbenches } from '../../lib/workbenchData';
import { opsFor } from '../../lib/workbenchOps';
import { Button } from '../ui/button';
import { NewWorkbenchDialog } from './NewWorkbenchDialog';
import { WorkbenchSidebar } from './WorkbenchSidebar';
import { WorkbenchView } from './WorkbenchView';
import { runPromptAction } from './WorkbenchHeader';
import { useOrderedLiveWorkbenches, useSelectedWorkbench, useWorkspaceWorkbenches } from './workbenchSelectors';

/**
 * Workbenches: Conductor-style branches with an agent chat, a diff and a
 * terminal. Takes the whole main area. Keyboard shortcuts live here so they
 * are active only while the panel is on screen.
 */
export function WorkbenchesPanel() {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const all = useWorkspaceWorkbenches();
  const ordered = useOrderedLiveWorkbenches();
  const selected = useSelectedWorkbench();
  const listLoaded = useWorkbenchStore((s) => s.listLoaded);
  const listError = useWorkbenchStore((s) => s.listError);
  const openNewDialog = useWorkbenchStore((s) => s.openNewDialog);

  useEffect(() => {
    if (workspaceId) void loadWorkbenches(workspaceId);
  }, [workspaceId]);

  // With nothing chosen, open the first live workbench.
  useEffect(() => {
    if (!selected && ordered.length > 0) useWorkbenchStore.getState().selectWorkbench(ordered[0].id);
  }, [selected, ordered]);

  useWorkbenchShortcuts(ordered.map((w) => w.id));

  return (
    <div className="flex h-full min-h-0">
      <WorkbenchSidebar workbenches={all} />
      <div className="min-w-0 flex-1">
        {selected ? (
          <WorkbenchView key={selected.id} workbench={selected} />
        ) : !listLoaded ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading workbenches…
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <SquareTerminal className="h-8 w-8 text-muted-foreground" />
            <div className="space-y-1">
              <h2 className="text-base font-semibold">No workbench open</h2>
              <p className="max-w-md text-sm text-muted-foreground">
                A workbench is one branch with its own agent chat, live diff and terminal. Create one for a new
                piece of work, or open one from a pull request.
              </p>
              {listError && <p className="text-xs text-red-600 dark:text-red-400">{listError}</p>}
            </div>
            <Button size="sm" className="gap-1.5" onClick={() => openNewDialog()}>
              <Plus className="h-4 w-4" /> New workbench
              <span className="ml-1 text-xs opacity-70">⌘N</span>
            </Button>
          </div>
        )}
      </div>
      <NewWorkbenchDialog />
    </div>
  );
}

/** True when the key event came from somewhere a person is typing. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

function useWorkbenchShortcuts(orderedIds: string[]) {
  const idsRef = useRef(orderedIds);
  idsRef.current = orderedIds;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const store = useWorkbenchStore.getState();
      const key = e.key.toLowerCase();
      const wb = store.selectedWorkbenchId ? store.workbenches[store.selectedWorkbenchId] : undefined;

      if (key === 'n' && !e.shiftKey) {
        e.preventDefault();
        store.openNewDialog();
      } else if (key === 'd' && e.shiftKey) {
        e.preventDefault();
        store.setSideTab('changes');
      } else if (key === 'j' && !e.shiftKey) {
        e.preventDefault();
        store.toggleTerminal();
      } else if (key === 'p' && e.shiftKey && wb) {
        e.preventDefault();
        const chats = visibleChats(store, wb.id);
        const chat = chats.find((c) => c.id === store.selectedChatByWorkbench[wb.id]) ?? chats[chats.length - 1] ?? null;
        void runPromptAction(opsFor(wb), 'create_pr', chat);
      } else if (key === 'w' && !e.shiftKey && wb && !isTyping(e.target)) {
        const chatId = store.selectedChatByWorkbench[wb.id] ?? visibleChats(store, wb.id).slice(-1)[0]?.id;
        if (chatId) {
          e.preventDefault();
          store.hideChat(wb.id, chatId);
        }
      } else if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
        const id = idsRef.current[Number(e.key) - 1];
        if (id) {
          e.preventDefault();
          store.selectWorkbench(id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

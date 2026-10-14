import { useEffect } from 'react';
import { workbenchesOffered, type Workbench, type WorkbenchChat } from '@talyn/shared';
import { MENU_COMMANDS } from '../../../main/menuCommands';
import {
  FOCUS_COMPOSER_EVENT,
  dispatchKeydown,
  registerShortcuts,
  runShortcut,
  type Shortcut,
} from '../../lib/shortcuts';
import { opsFor } from '../../lib/workbenchOps';
import { useNavigationStore } from '../../stores/navigation';
import { useWorkbenchStore, visibleChats } from '../../stores/workbenches';
import { useWorkspaceStore } from '../../stores/workspace';
import { createChatTab } from '../workbench/ChatTabs';
import { runPromptAction } from '../workbench/WorkbenchHeader';
import { groupByRepository, isArchived } from '../workbench/workbenchSelectors';

/** Live workbenches in sidebar order, the order ⌘1–9 counts in. */
export function orderedLiveWorkbenches(): Workbench[] {
  const all = Object.values(useWorkbenchStore.getState().workbenches).filter((w) => !isArchived(w));
  return groupByRepository(all).flatMap((g) => g.items);
}

/** The workbench on screen, if the route is one. */
export function currentWorkbench(): Workbench | null {
  const { route } = useNavigationStore.getState();
  if (route.view !== 'workbench') return null;
  return useWorkbenchStore.getState().workbenches[route.id] ?? null;
}

function currentChat(wb: Workbench): WorkbenchChat | null {
  const store = useWorkbenchStore.getState();
  const chats = visibleChats(store, wb.id);
  return chats.find((c) => c.id === store.selectedChatByWorkbench[wb.id]) ?? chats[chats.length - 1] ?? null;
}

function openWorkbench(wb: Workbench | undefined): void {
  if (wb) useNavigationStore.getState().navigate({ view: 'workbench', id: wb.id });
}

/** Step through the sidebar order; from outside a workbench, ↓ opens the first and ↑ the last. */
function stepWorkbench(delta: 1 | -1): void {
  const list = orderedLiveWorkbenches();
  if (list.length === 0) return;
  const cur = currentWorkbench();
  const i = cur ? list.findIndex((w) => w.id === cur.id) : -1;
  const next = i === -1 ? (delta === 1 ? 0 : list.length - 1) : (i + delta + list.length) % list.length;
  openWorkbench(list[next]);
}

const offered = () => workbenchesOffered(useWorkspaceStore.getState().features);
const inWorkbench = () => currentWorkbench() !== null;

type Def = Omit<Shortcut, 'keys' | 'label' | 'menu'> & { keys?: string; label?: string };

/** A shortcut whose chord the application menu owns: keys and label come from main/menuCommands.ts. */
function fromMenu(def: Def): Shortcut {
  const cmd = MENU_COMMANDS.find((c) => c.id === def.id);
  if (!cmd) throw new Error(`No menu command ${def.id}`);
  return { ...def, keys: cmd.keys, label: def.label ?? cmd.label, menu: true };
}

/**
 * The shell's shortcuts. Each reads the stores when it runs, so the list is
 * built once and never goes stale.
 */
export function buildAppShortcuts(): Shortcut[] {
  const nav = () => useNavigationStore.getState();
  const wbStore = () => useWorkbenchStore.getState();

  const jumps: Shortcut[] = Array.from({ length: 9 }, (_, i) =>
    fromMenu({
      id: `workbench.jump.${i + 1}`,
      label: `Open workbench ${i + 1}`,
      group: 'Workbenches',
      allowInInput: true,
      hidden: true,
      when: () => orderedLiveWorkbenches().length > i,
      run: () => openWorkbench(orderedLiveWorkbenches()[i]),
    })
  );

  return [
    fromMenu({
      id: 'palette.open',
      label: 'Search',
      group: 'General',
      allowInInput: true,
      hidden: true,
      run: () => nav().togglePalette(),
    }),
    fromMenu({
      id: 'workbench.new',
      group: 'Workbenches',
      allowInInput: true,
      when: offered,
      run: () => {
        nav().navigate({ view: 'home' });
        wbStore().openNewDialog();
      },
    }),
    fromMenu({
      id: 'settings.open',
      label: 'Open settings',
      group: 'General',
      allowInInput: true,
      run: () => useWorkspaceStore.getState().openSettings(),
    }),
    fromMenu({
      id: 'sidebar.toggle',
      group: 'General',
      allowInInput: true,
      run: () => useWorkspaceStore.getState().toggleSidebar(),
    }),
    fromMenu({
      id: 'nav.back',
      group: 'General',
      allowInInput: true,
      when: () => nav().backStack.length > 0,
      run: () => nav().back(),
    }),
    fromMenu({
      id: 'nav.forward',
      group: 'General',
      allowInInput: true,
      when: () => nav().forwardStack.length > 0,
      run: () => nav().forward(),
    }),
    fromMenu({
      id: 'workbench.previous',
      group: 'Workbenches',
      allowInInput: true,
      when: () => orderedLiveWorkbenches().length > 0,
      run: () => stepWorkbench(-1),
    }),
    fromMenu({
      id: 'workbench.next',
      group: 'Workbenches',
      allowInInput: true,
      when: () => orderedLiveWorkbenches().length > 0,
      run: () => stepWorkbench(1),
    }),
    ...jumps,
    fromMenu({
      id: 'workbench.changes',
      group: 'Workbench',
      allowInInput: true,
      when: inWorkbench,
      run: () => wbStore().setSideTab('changes'),
    }),
    fromMenu({
      id: 'terminal.toggle',
      group: 'Workbench',
      allowInInput: true,
      when: inWorkbench,
      run: () => wbStore().toggleTerminal(),
    }),
    fromMenu({
      id: 'workbench.createPr',
      group: 'Workbench',
      allowInInput: true,
      when: inWorkbench,
      run: () => {
        const wb = currentWorkbench();
        if (wb) void runPromptAction(opsFor(wb), 'create_pr', currentChat(wb));
      },
    }),
    fromMenu({
      id: 'chat.new',
      group: 'Workbench',
      allowInInput: true,
      when: inWorkbench,
      run: () => {
        const wb = currentWorkbench();
        if (wb) void createChatTab(wb);
      },
    }),
    fromMenu({
      id: 'chat.close',
      label: 'Close chat tab',
      group: 'Workbench',
      allowInInput: true,
      when: () => {
        const wb = currentWorkbench();
        return wb !== null && currentChat(wb) !== null;
      },
      run: () => {
        const wb = currentWorkbench();
        const chat = wb ? currentChat(wb) : null;
        if (wb && chat) wbStore().hideChat(wb.id, chat.id);
      },
    }),
    fromMenu({
      id: 'composer.focus',
      group: 'Workbench',
      allowInInput: true,
      when: inWorkbench,
      run: () => window.dispatchEvent(new CustomEvent(FOCUS_COMPOSER_EVENT)),
    }),
  ];
}

/** True inside Electron with the application menu, which then owns the `menu: true` chords. */
export function menuOwnsChords(): boolean {
  return typeof window !== 'undefined' && typeof window.electron?.onMenuCommand === 'function';
}

/**
 * Registers the shell's shortcuts, installs the one keydown listener and
 * runs the commands the application menu sends. Mounted once, by AppShell.
 */
export function useAppShortcuts(): void {
  useEffect(() => {
    const unregister = registerShortcuts(buildAppShortcuts());
    const owned = menuOwnsChords();
    const onKey = (e: KeyboardEvent) => {
      dispatchKeydown(e, { menuOwnsChords: owned });
    };
    window.addEventListener('keydown', onKey);
    const unsubscribeMenu = owned ? window.electron.onMenuCommand((id) => runShortcut(id)) : undefined;
    return () => {
      unregister();
      window.removeEventListener('keydown', onKey);
      unsubscribeMenu?.();
    };
  }, []);
}

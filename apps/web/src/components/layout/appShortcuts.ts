import { useEffect } from 'react';
import { workbenchesOffered, type Workbench, type WorkbenchChat } from '@talyn/shared';
import { MENU_COMMANDS } from '../../lib/menuCommands';
import { FOCUS_COMPOSER_EVENT, dispatchKeydown, registerShortcuts, type Shortcut } from '../../lib/shortcuts';
import { requestWorkbenchAction, type WorkbenchAction } from '../../lib/workbenchActions';
import { useNavigationStore } from '../../stores/navigation';
import { useWorkbenchStore, visibleChats } from '../../stores/workbenches';
import { useWorkspaceStore } from '../../stores/workspace';
import { closeChatTab, createChatTab } from '../workbench/ChatTabs';
import { openNewWorkbench } from '../workbench/new/openNewWorkbench';
import { groupByRepository, isArchived } from '../workbench/workbenchSelectors';

export function orderedLiveWorkbenches(): Workbench[] {
  const all = Object.values(useWorkbenchStore.getState().workbenches).filter((w) => !isArchived(w));
  return groupByRepository(all).flatMap((g) => g.items);
}

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

function stepWorkbench(delta: 1 | -1): void {
  const list = orderedLiveWorkbenches();
  if (list.length === 0) return;
  const cur = currentWorkbench();
  const i = cur ? list.findIndex((w) => w.id === cur.id) : -1;
  const next = i === -1 ? (delta === 1 ? 0 : list.length - 1) : (i + delta + list.length) % list.length;
  openWorkbench(list[next]);
}

const offered = () => workbenchesOffered(useWorkspaceStore.getState().features);
const inWorkbench = () => offered() && currentWorkbench() !== null;

type Def = Omit<Shortcut, 'keys' | 'label' | 'menu'> & { keys?: string; label?: string };

function fromMenu(def: Def): Shortcut {
  const cmd = MENU_COMMANDS.find((c) => c.id === def.id);
  if (!cmd) throw new Error(`No menu command ${def.id}`);
  return { ...def, keys: cmd.keys, label: def.label ?? cmd.label, menu: true };
}

function headerAction(id: string, action: WorkbenchAction): Shortcut {
  return fromMenu({
    id,
    group: 'Session',
    allowInInput: true,
    when: inWorkbench,
    run: () => {
      const wb = currentWorkbench();
      if (wb) requestWorkbenchAction(wb.id, action);
    },
  });
}

export function buildAppShortcuts(): Shortcut[] {
  const nav = () => useNavigationStore.getState();
  const wbStore = () => useWorkbenchStore.getState();

  const jumps: Shortcut[] = Array.from({ length: 9 }, (_, i) =>
    fromMenu({
      id: `workbench.jump.${i + 1}`,
      label: `Open session ${i + 1}`,
      group: 'Sessions',
      allowInInput: true,
      hidden: true,
      when: () => offered() && orderedLiveWorkbenches().length > i,
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
      group: 'Sessions',
      allowInInput: true,
      when: offered,
      run: () => openNewWorkbench(),
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
      id: 'workbench.previous',
      group: 'Sessions',
      allowInInput: true,
      when: () => offered() && orderedLiveWorkbenches().length > 0,
      run: () => stepWorkbench(-1),
    }),
    fromMenu({
      id: 'workbench.next',
      group: 'Sessions',
      allowInInput: true,
      when: () => offered() && orderedLiveWorkbenches().length > 0,
      run: () => stepWorkbench(1),
    }),
    ...jumps,
    fromMenu({
      id: 'workbench.changes',
      group: 'Session',
      allowInInput: true,
      when: inWorkbench,
      run: () => wbStore().setSideTab('changes'),
    }),
    fromMenu({
      id: 'terminal.toggle',
      group: 'Session',
      allowInInput: true,
      when: inWorkbench,
      run: () => wbStore().toggleTerminal(),
    }),
    fromMenu({
      id: 'panel.toggle',
      group: 'Session',
      allowInInput: true,
      when: inWorkbench,
      run: () => wbStore().toggleRightPanel(),
    }),
    headerAction('workbench.createPr', 'create_pr'),
    headerAction('workbench.fixChecks', 'fix_checks'),
    headerAction('workbench.merge', 'merge'),
    headerAction('workbench.archive', 'archive'),
    fromMenu({
      id: 'chat.new',
      group: 'Session',
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
      group: 'Session',
      allowInInput: true,
      when: () => {
        const wb = currentWorkbench();
        return offered() && wb !== null && currentChat(wb) !== null;
      },
      run: () => {
        const wb = currentWorkbench();
        const chat = wb ? currentChat(wb) : null;
        if (wb && chat) void closeChatTab(wb, chat);
      },
    }),
    fromMenu({
      id: 'composer.focus',
      group: 'Session',
      allowInInput: true,
      when: inWorkbench,
      run: () => window.dispatchEvent(new CustomEvent(FOCUS_COMPOSER_EVENT)),
    }),
  ];
}

export function menuOwnsChords(): boolean {
  return false;
}

export function useAppShortcuts(): void {
  useEffect(() => {
    const unregister = registerShortcuts(buildAppShortcuts());
    const owned = menuOwnsChords();
    const onKey = (e: KeyboardEvent) => {
      dispatchKeydown(e, { menuOwnsChords: owned });
    };
    window.addEventListener('keydown', onKey);
    return () => {
      unregister();
      window.removeEventListener('keydown', onKey);
    };
  }, []);
}

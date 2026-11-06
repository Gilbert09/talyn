import { useEffect } from 'react';
import { workbenchesOffered, type Workbench, type WorkbenchChat } from '@talyn/shared';
import { MENU_COMMANDS } from '../../lib/menuCommands';
import { FOCUS_COMPOSER_EVENT, OPEN_REPOSITORY_PICKER_EVENT, composerForTab, dispatchKeydown, isEmptyComposer, isInOverlay, registerShortcuts, type Shortcut } from '../../lib/shortcuts';
import { requestWorkbenchAction, type WorkbenchAction } from '../../lib/workbenchActions';
import { useNavigationStore } from '../../stores/navigation';
import { useWorkbenchStore, visibleChats } from '../../stores/workbenches';
import { useWorkspaceStore } from '../../stores/workspace';
import { closeChatTab, createChatTab } from '../workbench/ChatTabs';
import { openNewWorkbench } from '../workbench/new/openNewWorkbench';
import { groupByRepository, isArchived } from '../workbench/workbenchSelectors';
import { buildGoToShortcuts } from './goToShortcuts';
import { contextEntries, isWorkbenchOwner, spacesOffered, switchContext } from '../../lib/spaces';
import { useSpacesStore } from '../../stores/spaces';

/**
 * ⌘1–9 belongs to the browser (switch tab), and ⌘⌥1–9 opens a session, so a
 * context jump adds ⇧: ⌘⌥⇧1–9 (Ctrl+Alt+Shift elsewhere).
 */
export const CONTEXT_JUMP_KEYS = (n: number) => `mod+alt+shift+${n}`;

export function orderedContexts() {
  return contextEntries(useWorkspaceStore.getState().workspaces, useSpacesStore.getState().teams);
}

export function orderedLiveWorkbenches(): Workbench[] {
  const { workbenches, extraWorkbenchIds } = useWorkbenchStore.getState();
  const all = Object.values(workbenches).filter((w) => !isArchived(w) && !extraWorkbenchIds[w.id]);
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
const ownsCurrent = () => {
  const wb = currentWorkbench();
  if (!wb) return false;
  if (!useWorkbenchStore.getState().extraWorkbenchIds[wb.id]) return true;
  const ws = useWorkspaceStore.getState();
  return isWorkbenchOwner(wb, ws.workspaces, ws.currentWorkspaceId);
};
const inOwnWorkbench = () => inWorkbench() && ownsCurrent();

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
    when: inOwnWorkbench,
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

  const contextJumps: Shortcut[] = Array.from({ length: 9 }, (_, i) => ({
    id: `context.jump.${i + 1}`,
    keys: CONTEXT_JUMP_KEYS(i + 1),
    label: `Switch to workspace or space ${i + 1}`,
    group: 'General',
    allowInInput: true,
    hidden: true,
    when: () => spacesOffered(useWorkspaceStore.getState().features) && orderedContexts().length > i,
    run: () => {
      const context = orderedContexts()[i];
      if (context) switchContext(context);
    },
  }));

  return [
    ...contextJumps,
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
    {
      id: 'repository.open',
      keys: '/',
      label: 'Choose repository',
      group: 'New session',
      allowInInput: (target) => target instanceof HTMLTextAreaElement && target.hasAttribute('data-new-workbench-composer') && target.value === '',
      when: () => nav().route.view === 'home' && !nav().paletteOpen && !isInOverlay(document.activeElement) && !document.querySelector('[data-radix-popper-content-wrapper], [role="dialog"][data-state="open"]') && Boolean(document.querySelector<HTMLButtonElement>('[data-attr="new-workbench-repo"]:not(:disabled)')),
      run: () => window.dispatchEvent(new Event(OPEN_REPOSITORY_PICKER_EVENT)),
    },
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
      allowInInput: isEmptyComposer,
      when: () => nav().backStack.length > 0,
      run: () => nav().back(),
    }),
    fromMenu({
      id: 'nav.forward',
      group: 'General',
      allowInInput: isEmptyComposer,
      when: () => nav().forwardStack.length > 0,
      run: () => nav().forward(),
    }),
    {
      id: 'nav.back.bracket',
      keys: 'mod+[',
      label: 'Back',
      group: 'General',
      hidden: true,
      alias: true,
      when: () => nav().backStack.length > 0,
      run: () => nav().back(),
    },
    {
      id: 'nav.forward.bracket',
      keys: 'mod+]',
      label: 'Forward',
      group: 'General',
      hidden: true,
      alias: true,
      when: () => nav().forwardStack.length > 0,
      run: () => nav().forward(),
    },
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
      id: 'workbench.sandbox',
      group: 'Session',
      allowInInput: true,
      when: () => currentWorkbench()?.runtime === 'sandbox',
      run: () => wbStore().setSideTab('sandbox'),
    }),
    fromMenu({
      id: 'terminal.toggle',
      group: 'Session',
      allowInInput: true,
      when: inOwnWorkbench,
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
      when: inOwnWorkbench,
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
    {
      id: 'composer.focus.tab',
      keys: 'tab',
      label: 'Focus chat input',
      group: 'Session',
      hidden: true,
      // `composerForTab` leaves Tab alone in fields, the terminal, code views and overlays.
      when: () => inWorkbench() && composerForTab() !== null,
      run: () => window.dispatchEvent(new CustomEvent(FOCUS_COMPOSER_EVENT)),
    },
    ...buildGoToShortcuts(),
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

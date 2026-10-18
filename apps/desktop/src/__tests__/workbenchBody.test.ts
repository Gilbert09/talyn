/**
 * @jest-environment jsdom
 */
import type { Workbench, WorkbenchChat } from '@talyn/shared';
import type { PRCheckContext, PRRow } from '../renderer/lib/api';
import {
  DEFAULT_LAYOUT,
  DOCK_MIN_HEIGHT,
  DOCK_RESERVED_ABOVE,
  GIT_PANEL_MAX_WIDTH,
  GIT_PANEL_MIN_WIDTH,
  LAYOUT_STORAGE_KEY,
  clampDockHeight,
  clampPanelWidth,
  readLayout,
  writeLayout,
} from '../renderer/lib/workbenchLayout';
import { checkChatLine, checkRequirement, orderChecks, tallyChecks } from '../renderer/lib/workbenchChecks';
import {
  WORKBENCH_ACTION_SHORTCUT,
  availableWorkbenchActions,
  primaryWorkbenchAction,
  workbenchActionKeys,
  type WorkbenchAction,
} from '../renderer/lib/workbenchActions';
import { prRowAsLike } from '../renderer/lib/workbenchFormat';
import { MENU_COMMANDS } from '../main/menuCommands';
import { FOCUS_COMPOSER_EVENT } from '../renderer/lib/shortcuts';
import { insertIntoComposer } from '../renderer/lib/composerInsert';
import { composerDraftKey, useWorkbenchStore } from '../renderer/stores/workbenches';
import { notificationText, openFromNotification } from '../renderer/lib/workbenchNotify';
import { useNavigationStore } from '../renderer/stores/navigation';

jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));

beforeEach(() => {
  window.localStorage.clear();
});

describe('workbench layout', () => {
  it.each([
    [100, GIT_PANEL_MIN_WIDTH],
    [340.4, 340],
    [5000, GIT_PANEL_MAX_WIDTH],
    [Number.NaN, DEFAULT_LAYOUT.gitPanelWidth],
  ])('panel width %p clamps to %p', (input, expected) => {
    expect(clampPanelWidth(input)).toBe(expected);
  });

  it.each<[number, number | undefined, number]>([
    [50, undefined, DOCK_MIN_HEIGHT],
    [400, undefined, 400],
    [900, 800, 800 - DOCK_RESERVED_ABOVE],
    // A column too short for both still gives the dock its minimum.
    [900, 200, DOCK_MIN_HEIGHT],
    [Number.POSITIVE_INFINITY, 800, DEFAULT_LAYOUT.dockHeight],
  ])('dock height %p in a %p column clamps to %p', (height, available, expected) => {
    expect(clampDockHeight(height, available)).toBe(expected);
  });

  it('reads the defaults with nothing stored', () => {
    expect(readLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it('writes a patch over what is stored, and reads it back', () => {
    writeLayout({ gitPanelWidth: 400 });
    writeLayout({ gitPanelTab: 'checks' });
    expect(readLayout()).toEqual({ ...DEFAULT_LAYOUT, gitPanelWidth: 400, gitPanelTab: 'checks' });
  });

  it.each([
    ['not JSON', '{nope'],
    ['an unknown tab and wrong types', JSON.stringify({ gitPanelTab: 'diff', gitPanelWidth: '400', dockHeight: null })],
  ])('falls back field by field on %s', (_name, raw) => {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, raw);
    expect(readLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it('clamps a stored value from an older build', () => {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ gitPanelWidth: 20, dockHeight: 10 }));
    expect(readLayout()).toMatchObject({ gitPanelWidth: GIT_PANEL_MIN_WIDTH, dockHeight: DOCK_MIN_HEIGHT });
  });
});

describe('the store keeps the layout', () => {
  it('a tab or a width change is stored', () => {
    const s = useWorkbenchStore.getState();
    s.setSideTab('files');
    s.setRightPanelWidth(9999);
    expect(useWorkbenchStore.getState()).toMatchObject({ sideTab: 'files', rightPanelWidth: GIT_PANEL_MAX_WIDTH });
    expect(readLayout()).toMatchObject({ gitPanelTab: 'files', gitPanelWidth: GIT_PANEL_MAX_WIDTH });
  });

  it('a new store starts from the stored layout', () => {
    window.localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ gitPanelTab: 'checks', gitPanelWidth: 420, dockHeight: 333 })
    );
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      const fresh = require('../renderer/stores/workbenches') as typeof import('../renderer/stores/workbenches');
      expect(fresh.useWorkbenchStore.getState()).toMatchObject({
        sideTab: 'checks',
        rightPanelWidth: 420,
        terminalHeight: 333,
        terminalOpen: false,
        rightPanelOpen: true,
      });
    });
  });

  it('opening the dock shows a hidden right panel; ⌘J from a hidden panel opens both', () => {
    useWorkbenchStore.setState({ rightPanelOpen: false, terminalOpen: false });
    useWorkbenchStore.getState().toggleTerminal();
    expect(useWorkbenchStore.getState()).toMatchObject({ rightPanelOpen: true, terminalOpen: true });
    useWorkbenchStore.getState().toggleTerminal();
    expect(useWorkbenchStore.getState()).toMatchObject({ rightPanelOpen: true, terminalOpen: false });
    useWorkbenchStore.setState({ rightPanelOpen: false, terminalOpen: true });
    useWorkbenchStore.getState().toggleTerminal();
    expect(useWorkbenchStore.getState()).toMatchObject({ rightPanelOpen: true, terminalOpen: true });
    useWorkbenchStore.setState({ rightPanelOpen: false });
    useWorkbenchStore.getState().setTerminalTab('run');
    expect(useWorkbenchStore.getState()).toMatchObject({ rightPanelOpen: true, terminalOpen: true, terminalTab: 'run' });
  });

  it('⌘⌥B toggles the right panel', () => {
    useWorkbenchStore.setState({ rightPanelOpen: true });
    useWorkbenchStore.getState().toggleRightPanel();
    expect(useWorkbenchStore.getState().rightPanelOpen).toBe(false);
  });

  it.each([
    ['', 'one', 'one'],
    ['draft', 'one', 'draft\n\none'],
    ['draft\n', 'one', 'draft\n\none'],
    ['draft\n\n', 'one', 'draft\n\none'],
    ['   ', 'one', 'one'],
    ['draft', '   ', 'draft'],
  ])('appendDraft(%p, %p) → %p', (cur, add, expected) => {
    useWorkbenchStore.setState({ drafts: cur ? { k: cur } : {} });
    useWorkbenchStore.getState().appendDraft('k', add);
    expect(useWorkbenchStore.getState().drafts.k ?? '').toBe(expected);
  });

  it.each([
    [null, 'wb:wb1'],
    [{ id: 'c1' }, 'c1'],
  ])('the draft key for chat %p is %p', (chat, key) => {
    expect(composerDraftKey('wb1', chat)).toBe(key);
  });

  it('insertIntoComposer adds to the open chat draft and asks the composer for focus', () => {
    useWorkbenchStore.setState({ drafts: { c1: 'Look at this' } });
    const focus = jest.fn();
    window.addEventListener(FOCUS_COMPOSER_EVENT, focus);
    insertIntoComposer('wb1', { id: 'c1' }, 'The CI check `lint` is failing');
    window.removeEventListener(FOCUS_COMPOSER_EVENT, focus);
    expect(useWorkbenchStore.getState().drafts.c1).toBe('Look at this\n\nThe CI check `lint` is failing');
    expect(focus).toHaveBeenCalledTimes(1);
  });
});

describe('checks', () => {
  const ctx = (name: string, state: PRCheckContext['state'], required: boolean | null = true, url: string | null = null) =>
    ({ name, state, required, url }) as PRCheckContext;

  it('orders failing first, required before unknown before optional, then by name', () => {
    const ordered = orderChecks([
      ctx('pass', 'success'),
      ctx('skip', 'skipped'),
      ctx('opt-fail', 'failure', false),
      ctx('b-fail', 'failure', true),
      ctx('unknown-fail', 'failure', null),
      ctx('a-fail', 'failure', true),
      ctx('run', 'in_progress'),
      ctx('wait', 'pending'),
    ]);
    expect(ordered.map((c) => c.name)).toEqual([
      'a-fail',
      'b-fail',
      'unknown-fail',
      'opt-fail',
      'run',
      'wait',
      'pass',
      'skip',
    ]);
  });

  it.each<[boolean | null | undefined, string]>([
    [true, 'required'],
    [false, 'optional'],
    [null, 'unknown'],
    [undefined, 'unknown'],
  ])('required %p reads %p', (required, expected) => {
    expect(checkRequirement({ required })).toBe(expected);
  });

  it.each<[PRCheckContext, string]>([
    [ctx('lint', 'failure', true, 'https://ci/lint'), 'The CI check `lint` (required) is failing on #42: https://ci/lint'],
    [ctx('docs', 'failure', false, null), 'The CI check `docs` (optional) is failing on #42'],
    [ctx('e2e', 'in_progress', null, 'https://ci/e2e'), 'The CI check `e2e` is running on #42: https://ci/e2e'],
    [ctx('unit', 'success', true), 'The CI check `unit` (required) passed on #42'],
  ])('chat line for %p', (check, expected) => {
    expect(checkChatLine(check, 42)).toBe(expected);
  });

  it('tallies, counting an unknown failure as required', () => {
    expect(
      tallyChecks([
        ctx('a', 'failure', true),
        ctx('b', 'failure', null),
        ctx('c', 'failure', false),
        ctx('d', 'pending'),
        ctx('e', 'in_progress'),
        ctx('f', 'success'),
        ctx('g', 'skipped'),
      ])
    ).toEqual({ failing: 3, failingRequired: 2, running: 2, passed: 1, skipped: 1 });
  });
});

describe('action cycle mapping', () => {
  type WbLike = Pick<Workbench, 'diffStat' | 'status' | 'archivedAt'>;
  const WB: WbLike = { diffStat: { added: 1, removed: 0, files: 1 }, status: 'ready', archivedAt: null };
  const pr = (summary: Partial<PRRow['summary']>, state: PRRow['state'] = 'open') =>
    prRowAsLike({
      id: 'p',
      number: 1,
      state,
      summary: { url: 'u', mergeable: 'MERGEABLE', ciStatus: 'passing', draft: false, ...summary },
    } as PRRow);

  it.each<[WorkbenchAction, string | null]>([
    ['create_pr', 'mod+shift+p'],
    ['resolve_conflicts', null],
    ['fix_checks', 'mod+shift+x'],
    ['merge', 'mod+shift+m'],
    ['archive', 'mod+shift+a'],
  ])('%s has the chord %p, from the menu table', (action, keys) => {
    expect(workbenchActionKeys(action)).toBe(keys);
    const id = WORKBENCH_ACTION_SHORTCUT[action];
    if (id) expect(MENU_COMMANDS.some((c) => c.id === id)).toBe(true);
  });

  it('the right-panel toggle is a menu chord', () => {
    expect(MENU_COMMANDS.find((c) => c.id === 'panel.toggle')?.keys).toBe('mod+alt+b');
  });

  it.each<[string, ReturnType<typeof pr> | null, Partial<WbLike>, WorkbenchAction | null, WorkbenchAction[]]>([
    ['no PR, no changes', null, { diffStat: { added: 0, removed: 0, files: 0 } }, null, ['create_pr', 'archive']],
    ['no PR, changes', null, {}, 'create_pr', ['create_pr', 'archive']],
    ['draft green PR', pr({ draft: true }), {}, 'merge', ['merge', 'archive']],
    ['running checks', pr({ ciStatus: 'running' }), {}, null, ['merge', 'archive']],
    ['conflicts and red', pr({ mergeable: 'CONFLICTING', ciStatus: 'failing_required' }), {}, 'resolve_conflicts', ['resolve_conflicts', 'fix_checks', 'archive']],
    ['optional red', pr({ ciStatus: 'failing_optional' }), {}, 'merge', ['fix_checks', 'merge', 'archive']],
    ['merged', pr({}, 'merged'), {}, 'archive', ['archive']],
    ['archived', null, { status: 'archived' }, null, []],
  ])('%s', (_name, prLike, over, primary, available) => {
    const wb = { ...WB, ...over };
    expect(primaryWorkbenchAction(wb, prLike)).toBe(primary);
    expect(availableWorkbenchActions(wb, prLike)).toEqual(available);
  });
});

describe('notifications', () => {
  it.each<[WorkbenchChat['status'], string]>([
    ['idle', 'lisbon: done'],
    ['error', 'lisbon: stopped with an error'],
    ['awaiting_input', 'lisbon: needs your input'],
  ])('%s → %p', (status, title) => {
    expect(notificationText({ status, title: 'Chat' }, { name: 'lisbon' }).title).toBe(title);
  });

  it('a click raises the window and opens the workbench route on that chat', () => {
    const focusWindow = jest.fn(() => Promise.resolve());
    (window as unknown as { electron: unknown }).electron = { focusWindow };
    useWorkbenchStore.setState({ unread: { c9: true } });
    openFromNotification({ id: 'c9', workbenchId: 'wb9' });
    expect(focusWindow).toHaveBeenCalled();
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'wb9' });
    expect(useWorkbenchStore.getState().selectedChatByWorkbench.wb9).toBe('c9');
    expect(useWorkbenchStore.getState().unread.c9).toBeUndefined();
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('without the preload bridge it still focuses and navigates', () => {
    const focus = jest.spyOn(window, 'focus').mockImplementation(() => {});
    openFromNotification({ id: 'c1', workbenchId: 'wb1' });
    expect(focus).toHaveBeenCalled();
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'wb1' });
    focus.mockRestore();
  });
});

/**
 * The app's named chords, with their labels and sections. The shortcut
 * registry (`shortcuts.ts`) reads keys from here, so the palette, the
 * Shortcuts settings page and the key handler cannot disagree.
 *
 * This is the web key table. The desktop app's table (apps/desktop
 * main/menuCommands.ts) uses chords that a browser keeps for itself, and a
 * page cannot catch those: ⌘N, ⌘T, ⌘W (new window, new tab, close tab),
 * ⌘1–9 (switch tab), ⌘L (address bar), ⌘R (reload) and ⌘[ / ⌘] (back and
 * forward). Some ⌘⇧ chords are also taken: ⌘⇧P is a private window in
 * Firefox, ⌘⇧A is tab search and ⌘⇧M is the profile menu in Chrome.
 *
 * The rules for the replacements:
 * - New session is ⌘⇧O. The chat chords add ⌥ to the desktop chord (⌘⌥T, ⌘⌥W).
 * - Jumping to a session is ⌘⌥1–9.
 * - Every session action is ⌘⌥ plus the desktop letter (P, X, M, A).
 * - Focus composer is ⌘⇧L.
 * - Back and forward are the browser's own, so they have no entry here.
 * - Chords a page can catch (⌘K, ⌘B, ⌘J, ⌘,, ⌘⇧D, ⌘⌥B, ⌘⌥↑/↓) stay as on desktop.
 * On Windows and Linux `mod` is Ctrl; `shortcuts.ts` ignores Ctrl+Alt when
 * it is really AltGr.
 */

export type MenuSection = 'app' | 'file' | 'view' | 'workbench';

export interface MenuCommand {
  id: string;
  label: string;
  /** Registry notation: 'mod+shift+p'. `mod` is ⌘ on macOS and Ctrl elsewhere. */
  keys: string;
  section: MenuSection;
  /** Draw a separator above this item. */
  separatorBefore?: boolean;
}

const JUMP_COMMANDS: MenuCommand[] = Array.from({ length: 9 }, (_, i) => ({
  id: `workbench.jump.${i + 1}`,
  label: `Session ${i + 1}`,
  keys: `mod+alt+${i + 1}`,
  section: 'workbench' as const,
  separatorBefore: i === 0,
}));

export const MENU_COMMANDS: MenuCommand[] = [
  { id: 'settings.open', label: 'Settings…', keys: 'mod+,', section: 'app' },
  { id: 'workbench.new', label: 'New Session', keys: 'mod+shift+o', section: 'file' },
  { id: 'chat.new', label: 'New Chat', keys: 'mod+alt+t', section: 'file' },
  { id: 'chat.close', label: 'Close Chat', keys: 'mod+alt+w', section: 'file', separatorBefore: true },
  { id: 'palette.open', label: 'Command Palette…', keys: 'mod+k', section: 'view' },
  { id: 'sidebar.toggle', label: 'Toggle Sidebar', keys: 'mod+b', section: 'view' },
  { id: 'terminal.toggle', label: 'Toggle Terminal', keys: 'mod+j', section: 'view' },
  { id: 'panel.toggle', label: 'Toggle Right Panel', keys: 'mod+alt+b', section: 'view' },
  { id: 'workbench.changes', label: 'Show Changes', keys: 'mod+shift+d', section: 'view' },
  { id: 'composer.focus', label: 'Focus Composer', keys: 'mod+shift+l', section: 'workbench' },
  { id: 'workbench.createPr', label: 'Create Pull Request', keys: 'mod+alt+p', section: 'workbench' },
  { id: 'workbench.fixChecks', label: 'Fix Checks', keys: 'mod+alt+x', section: 'workbench' },
  { id: 'workbench.merge', label: 'Merge Pull Request', keys: 'mod+alt+m', section: 'workbench' },
  { id: 'workbench.archive', label: 'Archive Session', keys: 'mod+alt+a', section: 'workbench' },
  {
    id: 'workbench.previous',
    label: 'Previous Session',
    keys: 'mod+alt+up',
    section: 'workbench',
    separatorBefore: true,
  },
  { id: 'workbench.next', label: 'Next Session', keys: 'mod+alt+down', section: 'workbench' },
  ...JUMP_COMMANDS,
];

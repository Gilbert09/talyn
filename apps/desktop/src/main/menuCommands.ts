/**
 * The chords the application menu owns.
 *
 * Electron gives a menu accelerator the key before the renderer sees it, so
 * ⌘W would close the window and ⌘R would reload it. Each command here is a
 * menu item that sends `menu:command` with its id; the renderer runs the
 * shortcut registered under the same id (`renderer/lib/shortcuts.ts`) and
 * skips the chord in its own keydown listener, so it never fires twice.
 *
 * Pure data, no Electron import: the renderer reads it too.
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

export const MENU_COMMAND_CHANNEL = 'menu:command';

const JUMP_COMMANDS: MenuCommand[] = Array.from({ length: 9 }, (_, i) => ({
  id: `workbench.jump.${i + 1}`,
  label: `Session ${i + 1}`,
  keys: `mod+${i + 1}`,
  section: 'workbench' as const,
  separatorBefore: i === 0,
}));

export const MENU_COMMANDS: MenuCommand[] = [
  { id: 'settings.open', label: 'Settings…', keys: 'mod+,', section: 'app' },
  { id: 'workbench.new', label: 'New Session', keys: 'mod+n', section: 'file' },
  { id: 'chat.new', label: 'New Chat', keys: 'mod+t', section: 'file' },
  { id: 'chat.close', label: 'Close Chat', keys: 'mod+w', section: 'file', separatorBefore: true },
  { id: 'palette.open', label: 'Command Palette…', keys: 'mod+k', section: 'view' },
  { id: 'sidebar.toggle', label: 'Toggle Sidebar', keys: 'mod+b', section: 'view' },
  { id: 'terminal.toggle', label: 'Toggle Terminal', keys: 'mod+j', section: 'view' },
  { id: 'panel.toggle', label: 'Toggle Right Panel', keys: 'mod+alt+b', section: 'view' },
  { id: 'workbench.changes', label: 'Show Changes', keys: 'mod+shift+d', section: 'view' },
  { id: 'nav.back', label: 'Back', keys: 'mod+[', section: 'view', separatorBefore: true },
  { id: 'nav.forward', label: 'Forward', keys: 'mod+]', section: 'view' },
  { id: 'composer.focus', label: 'Focus Composer', keys: 'mod+l', section: 'workbench' },
  { id: 'workbench.createPr', label: 'Create Pull Request', keys: 'mod+shift+p', section: 'workbench' },
  { id: 'workbench.fixChecks', label: 'Fix Checks', keys: 'mod+shift+x', section: 'workbench' },
  { id: 'workbench.merge', label: 'Merge Pull Request', keys: 'mod+shift+m', section: 'workbench' },
  { id: 'workbench.archive', label: 'Archive Session', keys: 'mod+shift+a', section: 'workbench' },
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

const ACCELERATOR_KEY: Record<string, string> = {
  mod: 'CmdOrCtrl',
  shift: 'Shift',
  alt: 'Alt',
  ctrl: 'Ctrl',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  backspace: 'Backspace',
  enter: 'Enter',
  escape: 'Escape',
};

/** 'mod+shift+p' → 'CmdOrCtrl+Shift+P', the form Electron's `accelerator` takes. */
export function toAccelerator(keys: string): string {
  return keys
    .split('+')
    .map((part) => ACCELERATOR_KEY[part] ?? part.toUpperCase())
    .join('+');
}

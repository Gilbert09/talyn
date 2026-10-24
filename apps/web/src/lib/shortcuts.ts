/**
 * One keyboard shortcut registry for the whole app.
 *
 * Entries are registered by whoever owns the action (the shell registers the
 * global ones) and dispatched by ONE keydown listener that `AppShell`
 * installs. The command palette lists the same entries, so a shortcut and its
 * palette row cannot disagree.
 *
 * `menu: true` marks a chord listed in `menuCommands.ts`. In the desktop app
 * the Electron menu owns those chords; the browser has no application menu,
 * so `menuOwnsChords()` is false and this listener runs every chord itself.
 */

export interface Shortcut {
  id: string;
  /** 'mod+shift+p'. `mod` is ⌘ on macOS and Ctrl elsewhere; arrows are up/down/left/right. */
  keys: string;
  label: string;
  group: string;
  /** The action applies now. A false answer lets the key through. */
  when?: () => boolean;
  /** Run even while focus is in a text field, a contenteditable or the terminal. */
  allowInInput?: boolean;
  /** The chord comes from `menuCommands.ts`; see the module comment. */
  menu?: boolean;
  /** Left out of the command palette's Actions list. */
  hidden?: boolean;
  run: () => void;
}

/** The composer listens for this to take focus (see `composer.focus` in `menuCommands.ts`). */
export const FOCUS_COMPOSER_EVENT = 'talyn:focus-composer';

const registry = new Map<string, Shortcut>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Add shortcuts. A later registration with the same id replaces the earlier one. Returns an unregister. */
export function registerShortcuts(shortcuts: Shortcut[]): () => void {
  for (const s of shortcuts) registry.set(s.id, s);
  notify();
  return () => {
    for (const s of shortcuts) {
      if (registry.get(s.id) === s) registry.delete(s.id);
    }
    notify();
  };
}

export function getShortcuts(): Shortcut[] {
  return [...registry.values()];
}

export function getShortcut(id: string): Shortcut | undefined {
  return registry.get(id);
}

/** Re-render on registry changes (the palette uses it). */
export function subscribeShortcuts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam. */
export function clearShortcuts(): void {
  registry.clear();
  notify();
}

export function shortcutEnabled(s: Shortcut): boolean {
  try {
    return s.when ? s.when() : true;
  } catch {
    return false;
  }
}

/** Run a shortcut by id, as the menu and the palette do. False when it is unknown or does not apply now. */
export function runShortcut(id: string): boolean {
  const s = registry.get(id);
  if (!s || !shortcutEnabled(s)) return false;
  s.run();
  return true;
}

function detectMac(): boolean {
  if (typeof navigator !== 'undefined') return /Mac|iPhone|iPad/.test(navigator.platform ?? '');
  return false;
}

export const IS_MAC = detectMac();

/** The browser has no application menu, so no chord is owned by one. */
export function menuOwnsChords(): boolean {
  return false;
}

interface ParsedKeys {
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

export function parseKeys(keys: string): ParsedKeys {
  const parts = keys.toLowerCase().split('+');
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  return { mod: mods.has('mod'), ctrl: mods.has('ctrl'), shift: mods.has('shift'), alt: mods.has('alt'), key };
}

const CODE_KEYS: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Minus: '-',
  Equal: '=',
  Backquote: '`',
};

const NAMED_KEYS: Record<string, string> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Backspace: 'backspace',
  Enter: 'enter',
  Escape: 'escape',
  Tab: 'tab',
  ' ': 'space',
};

/**
 * The registry name of the key a keydown pressed. Shift and Option change
 * `event.key` ('{' for ⇧[, '∫' for ⌥B on a Mac), so a printable key with a
 * modifier that rewrites it is read from `event.code` instead.
 */
export function keyFromEvent(e: Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'shiftKey'>): string {
  if (NAMED_KEYS[e.key]) return NAMED_KEYS[e.key];
  if (e.altKey || e.shiftKey) {
    const code = e.code ?? '';
    if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (CODE_KEYS[code]) return CODE_KEYS[code];
  }
  return (e.key ?? '').toLowerCase();
}

type KeyEventLike = Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'shiftKey' | 'metaKey' | 'ctrlKey'> &
  Partial<Pick<KeyboardEvent, 'getModifierState'>>;

export function matchesKeys(e: KeyEventLike, keys: string, mac: boolean = IS_MAC): boolean {
  const want = parseKeys(keys);
  // On Windows and Linux, AltGr reports as Ctrl+Alt. A person typing '@' or '{'
  // with AltGr must not trigger a Ctrl+Alt chord.
  if (!mac && typeof e.getModifierState === 'function' && e.getModifierState('AltGraph')) return false;
  const modPressed = mac ? e.metaKey : e.ctrlKey;
  // The modifier `mod` is not: Ctrl on a Mac, ⊞/⌘ elsewhere.
  const otherPressed = mac ? e.ctrlKey : e.metaKey;
  if (modPressed !== want.mod) return false;
  if (otherPressed !== (mac && want.ctrl)) return false;
  if (e.shiftKey !== want.shift) return false;
  if (e.altKey !== want.alt) return false;
  return keyFromEvent(e) === want.key;
}

/** True when the key event came from somewhere a person is typing: a field, a contenteditable or the terminal. */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
  return typeof el.closest === 'function' && el.closest('.xterm, [contenteditable="true"]') !== null;
}

export interface DispatchOptions {
  /** An application menu owns the `menu: true` chords. Always false in the browser. */
  menuOwnsChords: boolean;
  mac?: boolean;
}

/**
 * Run the first shortcut the event matches and that applies now. Returns
 * true when one ran (the event's default is then prevented).
 */
export function dispatchKeydown(e: KeyboardEvent, opts: DispatchOptions): boolean {
  if (e.defaultPrevented || e.isComposing) return false;
  const typing = isTyping(e.target);
  for (const s of registry.values()) {
    if (!matchesKeys(e, s.keys, opts.mac ?? IS_MAC)) continue;
    if (s.menu && opts.menuOwnsChords) return false;
    if (typing && !s.allowInInput) continue;
    if (!shortcutEnabled(s)) continue;
    e.preventDefault();
    s.run();
    return true;
  }
  return false;
}

const MAC_SYMBOL: Record<string, string> = {
  mod: '⌘',
  ctrl: '⌃',
  shift: '⇧',
  alt: '⌥',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  backspace: '⌫',
  enter: '⏎',
  escape: '⎋',
  tab: '⇥',
};

const OTHER_NAME: Record<string, string> = {
  mod: 'Ctrl',
  ctrl: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  backspace: 'Backspace',
  enter: 'Enter',
  escape: 'Esc',
  tab: 'Tab',
};

/** 'mod+shift+p' → '⌘⇧P' on a Mac, 'Ctrl+Shift+P' elsewhere. */
export function formatKeys(keys: string, mac: boolean = IS_MAC): string {
  const parts = keys.toLowerCase().split('+');
  if (mac) return parts.map((p) => MAC_SYMBOL[p] ?? p.toUpperCase()).join('');
  return parts.map((p) => OTHER_NAME[p] ?? p.toUpperCase()).join('+');
}

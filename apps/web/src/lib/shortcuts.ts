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
 *
 * A `keys` value with spaces is a sequence, like GitHub's: 'g p' is G, then P
 * within `SEQUENCE_TIMEOUT_MS`. Sequences run only outside typing targets and
 * only for unmodified keys, so they cannot clash with text or with chords.
 */

export interface Shortcut {
  id: string;
  /**
   * 'mod+shift+p'. `mod` is ⌘ on macOS and Ctrl elsewhere; arrows are up/down/left/right.
   * Space-separated steps ('g p') make a sequence.
   */
  keys: string;
  label: string;
  group: string;
  /** The action applies now. A false answer lets the key through. */
  when?: () => boolean;
  /** Run in typing targets, or use a function to allow one target. */
  allowInInput?: boolean | ((target: EventTarget | null) => boolean);
  /** The chord comes from `menuCommands.ts`; see the module comment. */
  menu?: boolean;
  /** Left out of the command palette's Actions list. */
  hidden?: boolean;
  /** Keep a second chord out of the shortcut settings list. */
  alias?: boolean;
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
  pending = null;
  notify();
}

/** How long the first key of a sequence waits for the next one. */
export const SEQUENCE_TIMEOUT_MS = 1500;

/** 'g p' → ['g', 'p']. A chord is a sequence of one step. */
export function parseSequence(keys: string): string[] {
  return keys.trim().split(/\s+/);
}

export function isSequence(keys: string): boolean {
  return parseSequence(keys).length > 1;
}

/** The steps typed so far of a sequence that is not complete. */
let pending: { steps: string[]; at: number } | null = null;

export function pendingSequence(): string[] | null {
  return pending ? [...pending.steps] : null;
}

function startsWith(steps: string[], prefix: string[]): boolean {
  return prefix.every((step, i) => steps[i] === step);
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

export function isEmptyComposer(target: EventTarget | null): boolean {
  return target instanceof HTMLTextAreaElement && target.hasAttribute('data-session-composer') && target.value === '';
}

/** Dialogs, menus, lists, popovers and the command palette. */
const OVERLAY =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="menubar"], [role="listbox"], [cmdk-root], ' +
  '[data-radix-popper-content-wrapper]';
/** Places where Tab keeps its own meaning: overlays, the terminal and code or diff views. */
const TAB_KEEPS_MEANING = `${OVERLAY}, .xterm, .cm-editor, .monaco-editor, diffs-container`;

/** True when the key event came from inside an overlay. A menu reads letters for type-ahead, so sequences stay out. */
export function isInOverlay(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return !!el && typeof el.closest === 'function' && el.closest(OVERLAY) !== null;
}

/** An overlay that is open anywhere on the page, focused or not. */
const OPEN_OVERLAY =
  '[role="dialog"][data-state="open"], [role="alertdialog"], [role="menu"], [cmdk-root], [data-radix-popper-content-wrapper]';

/**
 * The session composer that a plain Tab should focus, or null when Tab must
 * keep its normal meaning: focus is in a field, the terminal, a code view or
 * an overlay, an overlay is open, or the composer is missing, disabled or
 * already focused.
 */
export function composerForTab(doc: Document = document): HTMLTextAreaElement | null {
  const active = doc.activeElement;
  if (active && active !== doc.body) {
    if (isTyping(active)) return null;
    if (typeof active.closest === 'function' && active.closest(TAB_KEEPS_MEANING)) return null;
  }
  if (doc.querySelector(OPEN_OVERLAY)) return null;
  const composer = doc.querySelector<HTMLTextAreaElement>('textarea[data-session-composer]');
  if (!composer || composer.disabled || composer === active) return null;
  return composer;
}

export interface DispatchOptions {
  /** An application menu owns the `menu: true` chords. Always false in the browser. */
  menuOwnsChords: boolean;
  mac?: boolean;
  /** Test seam for the sequence timeout. */
  now?: number;
}

/** The next step of a pending sequence. Runs a complete one, or keeps waiting. Null when nothing matched. */
function continueSequence(e: KeyboardEvent, prefix: string[], mac: boolean, now: number): boolean | null {
  let longer: string[] | null = null;
  for (const s of registry.values()) {
    const steps = parseSequence(s.keys);
    if (steps.length < 2 || steps.length <= prefix.length || !startsWith(steps, prefix)) continue;
    if (!matchesKeys(e, steps[prefix.length], mac) || !shortcutEnabled(s)) continue;
    if (steps.length === prefix.length + 1) {
      e.preventDefault();
      s.run();
      return true;
    }
    longer = steps.slice(0, prefix.length + 1);
  }
  if (!longer) return null;
  pending = { steps: longer, at: now };
  e.preventDefault();
  return true;
}

/**
 * Run the first shortcut the event matches and that applies now. Returns
 * true when one ran or a sequence moved on (the event's default is then
 * prevented).
 *
 * A pending sequence is ended by any key. Esc only ends it. A key that does
 * not continue it goes on to the chords, so the key is never lost.
 */
export function dispatchKeydown(e: KeyboardEvent, opts: DispatchOptions): boolean {
  if (e.defaultPrevented || e.isComposing) {
    pending = null;
    return false;
  }
  const mac = opts.mac ?? IS_MAC;
  const now = opts.now ?? Date.now();
  const typing = isTyping(e.target);
  const sequencesAllowed = !typing && !isInOverlay(e.target);

  const prefix = pending && now - pending.at <= SEQUENCE_TIMEOUT_MS ? pending.steps : null;
  pending = null;
  if (prefix && sequencesAllowed) {
    if (keyFromEvent(e) === 'escape') return false;
    const result = continueSequence(e, prefix, mac, now);
    if (result) return true;
  }

  for (const s of registry.values()) {
    if (isSequence(s.keys) || !matchesKeys(e, s.keys, mac)) continue;
    if (s.menu && opts.menuOwnsChords) return false;
    if (typing && !(typeof s.allowInInput === 'function' ? s.allowInInput(e.target) : s.allowInInput)) continue;
    if (!shortcutEnabled(s)) continue;
    e.preventDefault();
    s.run();
    return true;
  }

  return sequencesAllowed && continueSequence(e, [], mac, now) === true;
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
  tab: 'Tab',
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

/** The word `formatKeys` puts between the steps of a sequence. `Kbd` splits on it. */
export const SEQUENCE_SEPARATOR = ' then ';

function formatChord(keys: string, mac: boolean): string {
  const parts = keys.toLowerCase().split('+');
  if (mac) return parts.map((p) => MAC_SYMBOL[p] ?? p.toUpperCase()).join('');
  return parts.map((p) => OTHER_NAME[p] ?? p.toUpperCase()).join('+');
}

/** 'mod+shift+p' → '⌘⇧P' on a Mac, 'Ctrl+Shift+P' elsewhere. 'g p' → 'G then P'. */
export function formatKeys(keys: string, mac: boolean = IS_MAC): string {
  return parseSequence(keys)
    .map((step) => formatChord(step, mac))
    .join(SEQUENCE_SEPARATOR);
}

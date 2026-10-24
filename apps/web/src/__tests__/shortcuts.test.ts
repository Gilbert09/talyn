import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import {
  clearShortcuts,
  dispatchKeydown,
  formatKeys,
  getShortcuts,
  isTyping,
  keyFromEvent,
  matchesKeys,
  menuOwnsChords,
  registerShortcuts,
  runShortcut,
  type Shortcut,
} from '../lib/shortcuts';
import { MENU_COMMANDS } from '../lib/menuCommands';
import { workbenchActionKeys } from '../lib/workbenchActions';

type KeyInit = Partial<Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>>;

function key(init: KeyInit, target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(e, 'target', { value: target });
  return e;
}

function shortcut(over: Partial<Shortcut> & Pick<Shortcut, 'id' | 'keys'>): Shortcut & { run: Mock } {
  return { label: over.id, group: 'Test', run: vi.fn(), ...over } as Shortcut & { run: Mock };
}

afterEach(() => clearShortcuts());

describe('matchesKeys', () => {
  it.each<[string, KeyInit, boolean, boolean]>([
    ['mod+k', { key: 'k', code: 'KeyK', metaKey: true }, true, true],
    ['mod+k', { key: 'k', code: 'KeyK', ctrlKey: true }, true, false],
    ['mod+k', { key: 'k', code: 'KeyK', ctrlKey: true }, false, true],
    ['mod+k', { key: 'k', code: 'KeyK', metaKey: true }, false, false],
    ['mod+k', { key: 'k', code: 'KeyK', metaKey: true, ctrlKey: true }, true, false],
    ['mod+k', { key: 'k', code: 'KeyK', metaKey: true, shiftKey: true }, true, false],
    ['mod+k', { key: 'k', code: 'KeyK' }, true, false],
    ['mod+shift+p', { key: 'P', code: 'KeyP', metaKey: true, shiftKey: true }, true, true],
    ['mod+shift+p', { key: 'p', code: 'KeyP', metaKey: true }, true, false],
    ['mod+shift+d', { key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true }, false, true],
    // Option rewrites event.key on a Mac; the code still names the key.
    ['mod+alt+b', { key: '∫', code: 'KeyB', metaKey: true, altKey: true }, true, true],
    ['mod+alt+up', { key: 'ArrowUp', code: 'ArrowUp', metaKey: true, altKey: true }, true, true],
    ['mod+alt+down', { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, altKey: true }, true, true],
    ['mod+alt+down', { key: 'ArrowDown', code: 'ArrowDown', metaKey: true }, true, false],
    ['mod+1', { key: '1', code: 'Digit1', metaKey: true }, true, true],
    ['mod+9', { key: '1', code: 'Digit1', metaKey: true }, true, false],
    ['mod+[', { key: '[', code: 'BracketLeft', metaKey: true }, true, true],
    ['mod+]', { key: ']', code: 'BracketRight', ctrlKey: true }, false, true],
    ['mod+,', { key: ',', code: 'Comma', metaKey: true }, true, true],
  ])('%s vs %p (mac=%s) → %s', (keys, init, mac, expected) => {
    expect(matchesKeys(key(init), keys, mac)).toBe(expected);
  });
});

describe('keyFromEvent', () => {
  it.each<[KeyInit, string]>([
    [{ key: 'K', code: 'KeyK', shiftKey: true }, 'k'],
    [{ key: '{', code: 'BracketLeft', shiftKey: true }, '['],
    [{ key: '!', code: 'Digit1', shiftKey: true }, '1'],
    [{ key: 'ArrowUp', code: 'ArrowUp' }, 'up'],
    [{ key: 'Backspace', code: 'Backspace', shiftKey: true }, 'backspace'],
    [{ key: 'j', code: 'KeyJ' }, 'j'],
  ])('%p → %s', (init, expected) => {
    expect(keyFromEvent(key(init))).toBe(expected);
  });
});

describe('isTyping', () => {
  it.each([
    ['an input', () => document.createElement('input'), true],
    ['a textarea', () => document.createElement('textarea'), true],
    ['a select', () => document.createElement('select'), true],
    [
      'a contenteditable',
      () => {
        const el = document.createElement('div');
        el.setAttribute('contenteditable', 'true');
        Object.defineProperty(el, 'isContentEditable', { value: true });
        return el;
      },
      true,
    ],
    [
      'the terminal',
      () => {
        const term = document.createElement('div');
        term.className = 'xterm';
        const inner = document.createElement('div');
        term.appendChild(inner);
        return inner;
      },
      true,
    ],
    ['a button', () => document.createElement('button'), false],
    ['the body', () => document.body, false],
  ])('%s → %s', (_label, make, expected) => {
    expect(isTyping(make())).toBe(expected);
  });

  it('null is not typing', () => {
    expect(isTyping(null)).toBe(false);
  });
});

describe('registry', () => {
  it('registers, replaces by id and unregisters', () => {
    const a = shortcut({ id: 'a', keys: 'mod+a' });
    const off = registerShortcuts([a]);
    expect(getShortcuts().map((s) => s.id)).toEqual(['a']);
    const a2 = shortcut({ id: 'a', keys: 'mod+shift+a' });
    const off2 = registerShortcuts([a2]);
    expect(getShortcuts()).toEqual([a2]);
    // The first unregister does not remove the replacement.
    off();
    expect(getShortcuts()).toEqual([a2]);
    off2();
    expect(getShortcuts()).toEqual([]);
  });

  it('runShortcut honours when', () => {
    const on = shortcut({ id: 'on', keys: 'mod+o' });
    const off = shortcut({ id: 'off', keys: 'mod+f', when: () => false });
    registerShortcuts([on, off]);
    expect(runShortcut('on')).toBe(true);
    expect(runShortcut('off')).toBe(false);
    expect(runShortcut('missing')).toBe(false);
    expect(on.run).toHaveBeenCalledTimes(1);
    expect(off.run).not.toHaveBeenCalled();
  });

  it('a throwing when counts as not applicable', () => {
    const s = shortcut({
      id: 'boom',
      keys: 'mod+b',
      when: () => {
        throw new Error('x');
      },
    });
    registerShortcuts([s]);
    expect(runShortcut('boom')).toBe(false);
  });
});

describe('dispatchKeydown', () => {
  const mac = { menuOwnsChords: false, mac: true };

  it('runs a match and prevents the default', () => {
    const s = shortcut({ id: 'k', keys: 'mod+k' });
    registerShortcuts([s]);
    const e = key({ key: 'k', code: 'KeyK', metaKey: true });
    expect(dispatchKeydown(e, mac)).toBe(true);
    expect(s.run).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('ignores a non-match', () => {
    const s = shortcut({ id: 'k', keys: 'mod+k' });
    registerShortcuts([s]);
    const e = key({ key: 'j', code: 'KeyJ', metaKey: true });
    expect(dispatchKeydown(e, mac)).toBe(false);
    expect(e.defaultPrevented).toBe(false);
  });

  it('skips a shortcut while typing unless allowInInput', () => {
    const blocked = shortcut({ id: 'w', keys: 'mod+w' });
    const allowed = shortcut({ id: 'k', keys: 'mod+k', allowInInput: true });
    registerShortcuts([blocked, allowed]);
    const input = document.createElement('textarea');
    expect(dispatchKeydown(key({ key: 'w', code: 'KeyW', metaKey: true }, input), mac)).toBe(false);
    expect(dispatchKeydown(key({ key: 'k', code: 'KeyK', metaKey: true }, input), mac)).toBe(true);
    expect(blocked.run).not.toHaveBeenCalled();
    expect(allowed.run).toHaveBeenCalledTimes(1);
  });

  it('leaves a menu-owned chord to the menu, so it never fires twice', () => {
    const s = shortcut({ id: 'n', keys: 'mod+n', menu: true });
    registerShortcuts([s]);
    const e = key({ key: 'n', code: 'KeyN', metaKey: true });
    expect(dispatchKeydown(e, { menuOwnsChords: true, mac: true })).toBe(false);
    expect(s.run).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
    // Without the menu (a browser, a test), the listener owns it.
    expect(dispatchKeydown(key({ key: 'n', code: 'KeyN', metaKey: true }), mac)).toBe(true);
    expect(s.run).toHaveBeenCalledTimes(1);
  });

  it('falls through to the next match when when() is false', () => {
    const first = shortcut({ id: 'first', keys: 'mod+w', when: () => false });
    const second = shortcut({ id: 'second', keys: 'mod+w' });
    registerShortcuts([first, second]);
    expect(dispatchKeydown(key({ key: 'w', code: 'KeyW', metaKey: true }), mac)).toBe(true);
    expect(first.run).not.toHaveBeenCalled();
    expect(second.run).toHaveBeenCalledTimes(1);
  });

  it('ignores an event something else already handled', () => {
    const s = shortcut({ id: 'k', keys: 'mod+k' });
    registerShortcuts([s]);
    const e = key({ key: 'k', code: 'KeyK', metaKey: true });
    e.preventDefault();
    expect(dispatchKeydown(e, mac)).toBe(false);
    expect(s.run).not.toHaveBeenCalled();
  });
});

describe('formatKeys', () => {
  it.each([
    ['mod+shift+p', true, '⌘⇧P'],
    ['mod+k', true, '⌘K'],
    ['mod+alt+up', true, '⌘⌥↑'],
    ['mod+,', true, '⌘,'],
    ['mod+[', true, '⌘['],
    ['mod+shift+p', false, 'Ctrl+Shift+P'],
    ['mod+alt+down', false, 'Ctrl+Alt+↓'],
    ['mod+1', false, 'Ctrl+1'],
  ])('%s (mac=%s) → %s', (keys, mac, expected) => {
    expect(formatKeys(keys, mac)).toBe(expected);
  });
});

describe('menu commands (web key table)', () => {
  it('has unique ids and unique chords', () => {
    expect(new Set(MENU_COMMANDS.map((c) => c.id)).size).toBe(MENU_COMMANDS.length);
    expect(new Set(MENU_COMMANDS.map((c) => c.keys)).size).toBe(MENU_COMMANDS.length);
  });

  it('uses no chord a browser keeps for itself', () => {
    const reserved = ['mod+n', 'mod+t', 'mod+w', 'mod+l', 'mod+r', 'mod+[', 'mod+]', 'mod+shift+n', 'mod+shift+t', 'mod+shift+w', 'mod+shift+p', 'mod+shift+a', 'mod+shift+m'];
    for (let i = 1; i <= 9; i += 1) reserved.push(`mod+${i}`);
    const keys = MENU_COMMANDS.map((c) => c.keys);
    for (const chord of reserved) expect(keys).not.toContain(chord);
  });

  it.each([
    ['workbench.new', 'mod+shift+o'],
    ['chat.new', 'mod+alt+t'],
    ['chat.close', 'mod+alt+w'],
    ['composer.focus', 'mod+shift+l'],
    ['workbench.createPr', 'mod+alt+p'],
    ['workbench.fixChecks', 'mod+alt+x'],
    ['workbench.merge', 'mod+alt+m'],
    ['workbench.archive', 'mod+alt+a'],
    ['workbench.jump.1', 'mod+alt+1'],
    ['workbench.jump.9', 'mod+alt+9'],
    ['palette.open', 'mod+k'],
    ['settings.open', 'mod+,'],
  ])('%s is %s', (id, keys) => {
    expect(MENU_COMMANDS.find((c) => c.id === id)?.keys).toBe(keys);
  });

  it('has no back or forward: the browser owns them', () => {
    expect(MENU_COMMANDS.find((c) => c.id === 'nav.back' || c.id === 'nav.forward')).toBeUndefined();
  });

  it.each([
    ['create_pr', 'mod+alt+p'],
    ['fix_checks', 'mod+alt+x'],
    ['merge', 'mod+alt+m'],
    ['archive', 'mod+alt+a'],
    ['resolve_conflicts', null],
  ] as const)('the %s header action reads its chord from the table', (action, keys) => {
    expect(workbenchActionKeys(action)).toBe(keys);
  });

  it('a jump chord matches on both platforms', () => {
    expect(matchesKeys(key({ key: '¡', code: 'Digit1', metaKey: true, altKey: true }), 'mod+alt+1', true)).toBe(true);
    expect(matchesKeys(key({ key: '1', code: 'Digit1', ctrlKey: true, altKey: true }), 'mod+alt+1', false)).toBe(true);
  });
});

describe('browser specifics', () => {
  it('no application menu owns a chord', () => {
    expect(menuOwnsChords()).toBe(false);
  });

  it.each([
    [false, false],
    [true, true],
  ])('AltGr on Windows does not trigger a Ctrl+Alt chord (mac=%s → matches=%s)', (mac, expected) => {
    const e = key({ key: '@', code: 'Digit2', ctrlKey: !mac, metaKey: mac, altKey: true });
    Object.defineProperty(e, 'getModifierState', { value: (k: string) => k === 'AltGraph' });
    expect(matchesKeys(e, 'mod+alt+2', mac)).toBe(expected);
  });

  it('a plain Ctrl+Alt chord still matches when AltGr is not held', () => {
    const e = key({ key: 'p', code: 'KeyP', ctrlKey: true, altKey: true });
    expect(matchesKeys(e, 'mod+alt+p', false)).toBe(true);
  });
});

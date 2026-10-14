/**
 * @jest-environment jsdom
 */
import {
  clearShortcuts,
  dispatchKeydown,
  formatKeys,
  getShortcuts,
  isTyping,
  keyFromEvent,
  matchesKeys,
  registerShortcuts,
  runShortcut,
  type Shortcut,
} from '../renderer/lib/shortcuts';
import { MENU_COMMANDS, toAccelerator } from '../main/menuCommands';

type KeyInit = Partial<Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>>;

function key(init: KeyInit, target: EventTarget = document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(e, 'target', { value: target });
  return e;
}

function shortcut(over: Partial<Shortcut> & Pick<Shortcut, 'id' | 'keys'>): Shortcut & { run: jest.Mock } {
  return { label: over.id, group: 'Test', run: jest.fn(), ...over } as Shortcut & { run: jest.Mock };
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

describe('menu commands', () => {
  it.each([
    ['mod+shift+p', 'CmdOrCtrl+Shift+P'],
    ['mod+alt+up', 'CmdOrCtrl+Alt+Up'],
    ['mod+,', 'CmdOrCtrl+,'],
    ['mod+]', 'CmdOrCtrl+]'],
    ['mod+7', 'CmdOrCtrl+7'],
  ])('toAccelerator(%s) → %s', (keys, expected) => {
    expect(toAccelerator(keys)).toBe(expected);
  });

  it('has unique ids and unique chords', () => {
    expect(new Set(MENU_COMMANDS.map((c) => c.id)).size).toBe(MENU_COMMANDS.length);
    expect(new Set(MENU_COMMANDS.map((c) => c.keys)).size).toBe(MENU_COMMANDS.length);
  });

  it('owns the chords Electron would otherwise take', () => {
    const keys = MENU_COMMANDS.map((c) => c.keys);
    for (const chord of ['mod+w', 'mod+n', 'mod+k', 'mod+,', 'mod+b', 'mod+j', 'mod+t', 'mod+l', 'mod+[', 'mod+]']) {
      expect(keys).toContain(chord);
    }
    for (let i = 1; i <= 9; i += 1) expect(keys).toContain(`mod+${i}`);
  });
});

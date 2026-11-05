import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import {
  SEQUENCE_TIMEOUT_MS,
  clearShortcuts,
  composerForTab,
  dispatchKeydown,
  formatKeys,
  getShortcuts,
  isSequence,
  isTyping,
  keyFromEvent,
  matchesKeys,
  parseSequence,
  pendingSequence,
  menuOwnsChords,
  registerShortcuts,
  runShortcut,
  type Shortcut,
} from '../lib/shortcuts';
import { MENU_COMMANDS } from '../lib/menuCommands';
import { splitSequence } from '../components/ui/kbd';
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

  it('lists arrows as the back and forward chords', () => {
    expect(MENU_COMMANDS.filter((c) => c.id.startsWith('nav.')).map((c) => c.keys)).toEqual(['mod+left', 'mod+right']);
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

describe('sequences', () => {
  const at = (now: number) => ({ menuOwnsChords: false, mac: true, now });
  const g = (target?: EventTarget) => key({ key: 'g', code: 'KeyG' }, target);
  const p = (target?: EventTarget) => key({ key: 'p', code: 'KeyP' }, target);

  it.each([
    ['g p', ['g', 'p'], true],
    ['  g   p ', ['g', 'p'], true],
    ['mod+k', ['mod+k'], false],
    ['shift+/', ['shift+/'], false],
  ])('parseSequence(%p) → %p', (keys, steps, sequence) => {
    expect(parseSequence(keys)).toEqual(steps);
    expect(isSequence(keys)).toBe(sequence);
  });

  it('runs on the second key and prevents both defaults', () => {
    const s = shortcut({ id: 'gp', keys: 'g p' });
    registerShortcuts([s]);
    const first = g();
    expect(dispatchKeydown(first, at(0))).toBe(true);
    expect(first.defaultPrevented).toBe(true);
    expect(pendingSequence()).toEqual(['g']);
    expect(s.run).not.toHaveBeenCalled();
    const second = p();
    expect(dispatchKeydown(second, at(500))).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(s.run).toHaveBeenCalledTimes(1);
    expect(pendingSequence()).toBeNull();
  });

  it('picks the sequence the second key names', () => {
    const gp = shortcut({ id: 'gp', keys: 'g p' });
    const gr = shortcut({ id: 'gr', keys: 'g r' });
    registerShortcuts([gp, gr]);
    dispatchKeydown(g(), at(0));
    expect(dispatchKeydown(key({ key: 'r', code: 'KeyR' }), at(10))).toBe(true);
    expect(gr.run).toHaveBeenCalledTimes(1);
    expect(gp.run).not.toHaveBeenCalled();
  });

  it.each([
    ['inside the timeout', SEQUENCE_TIMEOUT_MS, 1],
    ['after the timeout', SEQUENCE_TIMEOUT_MS + 1, 0],
  ])('second key %s', (_label, delay, runs) => {
    const s = shortcut({ id: 'gp', keys: 'g p' });
    registerShortcuts([s]);
    dispatchKeydown(g(), at(1000));
    const second = p();
    expect(dispatchKeydown(second, at(1000 + delay))).toBe(runs === 1);
    expect(second.defaultPrevented).toBe(runs === 1);
    expect(s.run).toHaveBeenCalledTimes(runs);
  });

  it('an unknown second key does nothing and goes through', () => {
    const s = shortcut({ id: 'gp', keys: 'g p' });
    registerShortcuts([s]);
    dispatchKeydown(g(), at(0));
    const other = key({ key: 'x', code: 'KeyX' });
    expect(dispatchKeydown(other, at(10))).toBe(false);
    expect(other.defaultPrevented).toBe(false);
    expect(pendingSequence()).toBeNull();
    // The sequence is over: P alone does nothing now.
    expect(dispatchKeydown(p(), at(20))).toBe(false);
    expect(s.run).not.toHaveBeenCalled();
  });

  it('an unknown second key still runs its own chord', () => {
    const seq = shortcut({ id: 'gp', keys: 'g p' });
    const chord = shortcut({ id: 'k', keys: 'mod+k' });
    registerShortcuts([seq, chord]);
    dispatchKeydown(g(), at(0));
    expect(dispatchKeydown(key({ key: 'k', code: 'KeyK', metaKey: true }), at(10))).toBe(true);
    expect(chord.run).toHaveBeenCalledTimes(1);
    expect(seq.run).not.toHaveBeenCalled();
  });

  it('Esc cancels a pending sequence and goes through', () => {
    const s = shortcut({ id: 'gp', keys: 'g p' });
    registerShortcuts([s]);
    dispatchKeydown(g(), at(0));
    const esc = key({ key: 'Escape', code: 'Escape' });
    expect(dispatchKeydown(esc, at(10))).toBe(false);
    expect(esc.defaultPrevented).toBe(false);
    expect(pendingSequence()).toBeNull();
    expect(dispatchKeydown(p(), at(20))).toBe(false);
    expect(s.run).not.toHaveBeenCalled();
  });

  it.each<[string, KeyInit]>([
    ['⌘', { metaKey: true }],
    ['Ctrl', { ctrlKey: true }],
    ['⌥', { altKey: true }],
    ['⇧', { shiftKey: true }],
  ])('a first key with %s held starts nothing', (_label, mods) => {
    const s = shortcut({ id: 'gp', keys: 'g p' });
    registerShortcuts([s]);
    const first = key({ key: 'g', code: 'KeyG', ...mods });
    expect(dispatchKeydown(first, at(0))).toBe(false);
    expect(first.defaultPrevented).toBe(false);
    expect(pendingSequence()).toBeNull();
  });

  it.each<[string, KeyInit]>([
    ['⌘', { metaKey: true }],
    ['⇧', { shiftKey: true }],
  ])('a second key with %s held does not finish it', (_label, mods) => {
    const s = shortcut({ id: 'gp', keys: 'g p' });
    registerShortcuts([s]);
    dispatchKeydown(g(), at(0));
    expect(dispatchKeydown(key({ key: 'p', code: 'KeyP', ...mods }), at(10))).toBe(false);
    expect(s.run).not.toHaveBeenCalled();
  });

  it.each([
    ['an input', () => document.createElement('input')],
    ['a textarea', () => document.createElement('textarea')],
    [
      'the terminal',
      () => {
        const term = document.createElement('div');
        term.className = 'xterm';
        const inner = document.createElement('div');
        term.appendChild(inner);
        return inner;
      },
    ],
    [
      'a dialog',
      () => {
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        const button = document.createElement('button');
        dialog.appendChild(button);
        return button;
      },
    ],
    [
      'a menu',
      () => {
        const menu = document.createElement('div');
        menu.setAttribute('role', 'menu');
        return menu;
      },
    ],
  ])('never starts in %s', (_label, make) => {
    const s = shortcut({ id: 'gp', keys: 'g p' });
    registerShortcuts([s]);
    const target = make();
    const first = g(target);
    expect(dispatchKeydown(first, at(0))).toBe(false);
    expect(first.defaultPrevented).toBe(false);
    expect(pendingSequence()).toBeNull();
    expect(dispatchKeydown(p(target), at(10))).toBe(false);
    expect(s.run).not.toHaveBeenCalled();
  });

  it('a second key typed into a field is text, not a step', () => {
    const s = shortcut({ id: 'gp', keys: 'g p' });
    registerShortcuts([s]);
    dispatchKeydown(g(), at(0));
    const typed = p(document.createElement('input'));
    expect(dispatchKeydown(typed, at(10))).toBe(false);
    expect(typed.defaultPrevented).toBe(false);
    expect(s.run).not.toHaveBeenCalled();
  });

  it('respects when: a hidden page starts and runs nothing', () => {
    const s = shortcut({ id: 'gl', keys: 'g l', when: () => false });
    registerShortcuts([s]);
    const first = g();
    expect(dispatchKeydown(first, at(0))).toBe(false);
    expect(first.defaultPrevented).toBe(false);
    expect(s.run).not.toHaveBeenCalled();
  });

  it('a gated second step lets the key through', () => {
    const open = shortcut({ id: 'gp', keys: 'g p' });
    const gated = shortcut({ id: 'gl', keys: 'g l', when: () => false });
    registerShortcuts([open, gated]);
    dispatchKeydown(g(), at(0));
    const l = key({ key: 'l', code: 'KeyL' });
    expect(dispatchKeydown(l, at(10))).toBe(false);
    expect(l.defaultPrevented).toBe(false);
    expect(gated.run).not.toHaveBeenCalled();
  });

  it('a key something else handled ends the sequence', () => {
    const s = shortcut({ id: 'gp', keys: 'g p' });
    registerShortcuts([s]);
    dispatchKeydown(g(), at(0));
    const handled = p();
    handled.preventDefault();
    expect(dispatchKeydown(handled, at(10))).toBe(false);
    expect(pendingSequence()).toBeNull();
  });

  it('a sequence is never matched as a chord, and a chord never as a sequence', () => {
    const seq = shortcut({ id: 'gp', keys: 'g p' });
    const chord = shortcut({ id: 'q', keys: 'shift+/' });
    registerShortcuts([seq, chord]);
    expect(dispatchKeydown(p(), at(0))).toBe(false);
    expect(dispatchKeydown(key({ key: '?', code: 'Slash', shiftKey: true }), at(10))).toBe(true);
    expect(chord.run).toHaveBeenCalledTimes(1);
    expect(seq.run).not.toHaveBeenCalled();
  });

  it('runShortcut runs a sequence by id, as the palette does', () => {
    const s = shortcut({ id: 'gp', keys: 'g p' });
    registerShortcuts([s]);
    expect(runShortcut('gp')).toBe(true);
    expect(s.run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['g p', true, 'G then P'],
    ['g p', false, 'G then P'],
    ['shift+/', true, '⇧/'],
    ['tab', true, 'Tab'],
    ['tab', false, 'Tab'],
  ])('formatKeys(%s, mac=%s) → %s', (keys, mac, expected) => {
    expect(formatKeys(keys, mac)).toBe(expected);
  });
});

describe('composerForTab', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mountComposer(): HTMLTextAreaElement {
    const composer = document.createElement('textarea');
    composer.setAttribute('data-session-composer', '');
    document.body.appendChild(composer);
    return composer;
  }

  function focusable(tag: string, wrap?: (el: HTMLElement) => HTMLElement): HTMLElement {
    const el = document.createElement(tag);
    if (tag === 'div') el.tabIndex = 0;
    document.body.appendChild(wrap ? wrap(el) : el);
    el.focus();
    return el;
  }

  function within(attr: string, value: string) {
    return (el: HTMLElement) => {
      const outer = document.createElement('div');
      if (attr === 'class') outer.className = value;
      else outer.setAttribute(attr, value);
      outer.appendChild(el);
      return outer;
    };
  }

  it('returns the composer when nothing is focused', () => {
    const composer = mountComposer();
    expect(composerForTab()).toBe(composer);
  });

  it('returns the composer from a plain button', () => {
    const composer = mountComposer();
    focusable('button');
    expect(composerForTab()).toBe(composer);
  });

  it.each<[string, () => void]>([
    ['the composer is focused', () => mountComposer().focus()],
    ['the composer is missing', () => focusable('button')],
    [
      'the composer is disabled',
      () => {
        mountComposer().disabled = true;
      },
    ],
    ['an input is focused', () => (mountComposer(), focusable('input'))],
    ['a textarea is focused', () => (mountComposer(), focusable('textarea'))],
    ['a select is focused', () => (mountComposer(), focusable('select'))],
    ['the terminal is focused', () => (mountComposer(), focusable('div', within('class', 'xterm')))],
    ['a code editor is focused', () => (mountComposer(), focusable('div', within('class', 'cm-editor')))],
    ['a diff view is focused', () => (mountComposer(), focusable('div', (el) => {
      const diff = document.createElement('diffs-container');
      diff.appendChild(el);
      return diff;
    }))],
    ['a dialog button is focused', () => (mountComposer(), focusable('button', within('role', 'dialog')))],
    ['a menu item is focused', () => (mountComposer(), focusable('div', within('role', 'menu')))],
    ['the palette is focused', () => (mountComposer(), focusable('div', within('cmdk-root', '')))],
    [
      'a dialog is open elsewhere',
      () => {
        mountComposer();
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('data-state', 'open');
        document.body.appendChild(dialog);
      },
    ],
    [
      'a popover is open elsewhere',
      () => {
        mountComposer();
        const popper = document.createElement('div');
        popper.setAttribute('data-radix-popper-content-wrapper', '');
        document.body.appendChild(popper);
      },
    ],
  ])('returns null when %s', (_label, arrange) => {
    arrange();
    expect(composerForTab()).toBeNull();
  });

  describe('Tab dispatch', () => {
    const mac = { menuOwnsChords: false, mac: true };

    function registerTab(): Shortcut & { run: { mock: { calls: unknown[] } } } {
      const s = shortcut({ id: 'composer.focus.tab', keys: 'tab', when: () => composerForTab() !== null });
      registerShortcuts([s]);
      return s;
    }

    it('moves focus and prevents the default', () => {
      mountComposer();
      const button = focusable('button');
      const s = registerTab();
      const e = key({ key: 'Tab', code: 'Tab' }, button);
      expect(dispatchKeydown(e, mac)).toBe(true);
      expect(e.defaultPrevented).toBe(true);
      expect(s.run.mock.calls).toHaveLength(1);
    });

    it('Shift+Tab keeps its normal behaviour', () => {
      mountComposer();
      const button = focusable('button');
      const s = registerTab();
      const e = key({ key: 'Tab', code: 'Tab', shiftKey: true }, button);
      expect(dispatchKeydown(e, mac)).toBe(false);
      expect(e.defaultPrevented).toBe(false);
      expect(s.run.mock.calls).toHaveLength(0);
    });

    it.each<[string, KeyInit]>([
      ['⌘', { metaKey: true }],
      ['Ctrl', { ctrlKey: true }],
      ['⌥', { altKey: true }],
    ])('Tab with %s held is left alone', (_label, mods) => {
      mountComposer();
      const button = focusable('button');
      const s = registerTab();
      expect(dispatchKeydown(key({ key: 'Tab', code: 'Tab', ...mods }, button), mac)).toBe(false);
      expect(s.run.mock.calls).toHaveLength(0);
    });

    it('Tab in the composer behaves as before', () => {
      const composer = mountComposer();
      composer.focus();
      const s = registerTab();
      const e = key({ key: 'Tab', code: 'Tab' }, composer);
      expect(dispatchKeydown(e, mac)).toBe(false);
      expect(e.defaultPrevented).toBe(false);
      expect(s.run.mock.calls).toHaveLength(0);
    });

    it('Tab in the terminal is left to the terminal', () => {
      mountComposer();
      const inner = focusable('div', within('class', 'xterm'));
      const s = registerTab();
      const e = key({ key: 'Tab', code: 'Tab' }, inner);
      expect(dispatchKeydown(e, mac)).toBe(false);
      expect(e.defaultPrevented).toBe(false);
      expect(s.run.mock.calls).toHaveLength(0);
    });

    it('does not prevent the default when there is no composer to focus', () => {
      const button = focusable('button');
      const s = registerTab();
      const e = key({ key: 'Tab', code: 'Tab' }, button);
      expect(dispatchKeydown(e, mac)).toBe(false);
      expect(e.defaultPrevented).toBe(false);
      expect(s.run.mock.calls).toHaveLength(0);
    });
  });
});

describe('Kbd splitSequence', () => {
  it.each<[string, boolean, string[][]]>([
    ['g p', true, [['G'], ['P']]],
    ['g p', false, [['G'], ['P']]],
    ['mod+shift+p', true, [['⌘', '⇧', 'P']]],
    ['mod+shift+p', false, [['Ctrl', 'Shift', 'P']]],
    ['tab', true, [['Tab']]],
  ])('%s (mac=%s) → %p', (keys, mac, expected) => {
    expect(splitSequence(formatKeys(keys, mac))).toEqual(expected);
  });
});

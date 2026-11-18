import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAppShortcuts } from '../components/layout/appShortcuts';
import { clearShortcuts, dispatchKeydown, isComposer, registerShortcuts } from '../lib/shortcuts';
import { useNavigationStore } from '../stores/navigation';

const opts = { menuOwnsChords: false, mac: true };

function press(key: string, target: EventTarget = document.activeElement ?? document.body): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true });
  Object.defineProperty(e, 'target', { value: target });
  dispatchKeydown(e, opts);
  return e;
}

function mount(tag: 'textarea' | 'input', attr?: string): HTMLElement {
  const el = document.createElement(tag);
  if (attr) el.setAttribute(attr, '');
  document.body.appendChild(el);
  el.focus();
  return el;
}

beforeEach(() => {
  registerShortcuts(buildAppShortcuts().filter((s) => s.id === 'composer.blur' || s.id === 'goto.my_prs'));
  useNavigationStore.getState().navigate({ view: 'home' });
});

afterEach(() => {
  clearShortcuts();
  document.body.innerHTML = '';
});

describe('isComposer', () => {
  it.each<[string, () => EventTarget | null, boolean]>([
    ['the session composer', () => mount('textarea', 'data-session-composer'), true],
    ['the new-session composer', () => mount('textarea', 'data-new-workbench-composer'), true],
    ['another textarea', () => mount('textarea'), false],
    ['an input', () => mount('input', 'data-session-composer'), false],
    ['the body', () => document.body, false],
    ['nothing', () => null, false],
  ])('%s → %s', (_label, target, expected) => {
    expect(isComposer(target())).toBe(expected);
  });
});

describe('Esc in a composer', () => {
  it.each(['data-session-composer', 'data-new-workbench-composer'])('leaves the %s composer, then G P opens pull requests', (attr) => {
    const composer = mount('textarea', attr);
    (composer as HTMLTextAreaElement).value = 'a draft';

    const esc = press('Escape', composer);
    expect(esc.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(document.body);
    expect((composer as HTMLTextAreaElement).value).toBe('a draft');

    press('g');
    press('p');
    expect(useNavigationStore.getState().route).toEqual({ view: 'prs', tab: 'my_prs' });
  });

  it('G P typed in the composer stays text', () => {
    const composer = mount('textarea', 'data-session-composer');
    press('g', composer);
    press('p', composer);
    expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
  });

  it('leaves an Esc that the composer used alone', () => {
    const composer = mount('textarea', 'data-session-composer');
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    Object.defineProperty(e, 'target', { value: composer });
    e.preventDefault();
    expect(dispatchKeydown(e, opts)).toBe(false);
    expect(document.activeElement).toBe(composer);
  });

  it.each<[string, () => HTMLElement]>([
    ['another text field', () => mount('textarea')],
    ['an input', () => mount('input')],
  ])('does nothing in %s', (_label, arrange) => {
    const el = arrange();
    const e = press('Escape', el);
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(el);
  });

  it('does not take Esc when nothing is focused', () => {
    const e = press('Escape', document.body);
    expect(e.defaultPrevented).toBe(false);
  });

  it('shows in the shortcuts list', () => {
    const blur = buildAppShortcuts().find((s) => s.id === 'composer.blur');
    expect(blur).toMatchObject({ keys: 'escape', label: 'Leave chat input', group: 'General' });
    expect(blur?.hidden).toBeUndefined();
  });
});

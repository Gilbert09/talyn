import '@testing-library/jest-dom/vitest';
import React, { useRef } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  FIND_HIGHLIGHT,
  FIND_HIGHLIGHT_CURRENT,
  OPEN_TRANSCRIPT_FIND_EVENT,
  clearMatches,
  findTextRanges,
  matchLabel,
  paintMatches,
  requestTranscriptFind,
  stepMatch,
} from '../lib/transcriptFind';
import { TranscriptFindBar } from '../components/workbench/TranscriptFindBar';
import { buildAppShortcuts, findTargetWorkbenchId } from '../components/layout/appShortcuts';
import { clearShortcuts, dispatchKeydown, registerShortcuts } from '../lib/shortcuts';
import { MENU_COMMANDS } from '../lib/menuCommands';
import { useNavigationStore } from '../stores/navigation';
import { useSplitViewStore } from '../stores/splitView';
import { useWorkspaceStore } from '../stores/workspace';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../components/auth/AuthProvider', () => ({ useAuth: () => ({ user: null }) }));

function rootWith(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('findTextRanges', () => {
  it.each([
    ['an empty query', '<p>hello</p>', '', []],
    ['a whitespace query', '<p>hello</p>', '   ', []],
    ['no match', '<p>hello</p>', 'bye', []],
    ['one match', '<p>hello world</p>', 'world', ['world']],
    ['any case', '<p>Hello HELLO hello</p>', 'hello', ['Hello', 'HELLO', 'hello']],
    ['a trimmed query', '<p>hello world</p>', '  world ', ['world']],
    ['matches across elements in order', '<p>foo</p><div><span>a foo</span></div><code>foo()</code>', 'foo', ['foo', 'foo', 'foo']],
    ['no overlap', '<p>aaaa</p>', 'aa', ['aa', 'aa']],
    ['button text, as the browser does', '<button>Read file.ts</button>', 'file.ts', ['file.ts']],
    ['not hidden text', '<p hidden>secret</p><p>secret</p>', 'secret', ['secret']],
    ['not aria-hidden text', '<span aria-hidden="true">x</span><span>x</span>', 'x', ['x']],
    ['not the find bar', '<div data-find-skip><input /><span>1 of 2</span></div><p>of</p>', 'of', ['of']],
    ['not svg or style text', '<svg><text>icon</text></svg><style>.icon{}</style><p>icon</p>', 'icon', ['icon']],
  ])('finds %s', (_name, html, query, expected) => {
    const root = rootWith(html);
    const ranges = findTextRanges(root, query);
    expect(ranges.map((r) => r.toString())).toEqual(expected);
  });

  it('gives each match its own offsets in one text node', () => {
    const root = rootWith('<p>ab ab ab</p>');
    expect(findTextRanges(root, 'AB').map((r) => [r.startOffset, r.endOffset])).toEqual([
      [0, 2],
      [3, 5],
      [6, 8],
    ]);
  });
});

describe('stepMatch', () => {
  it.each([
    [0, 1, 0, -1],
    [0, -1, 0, -1],
    [0, 1, 3, 1],
    [2, 1, 3, 0],
    [0, -1, 3, 2],
    [1, -1, 3, 0],
    [-1, 1, 3, 0],
    [-1, -1, 3, 2],
    [5, 1, 3, 0],
    [0, 1, 1, 0],
  ] as const)('from %i by %i of %i is %i', (current, delta, count, expected) => {
    expect(stepMatch(current, delta, count)).toBe(expected);
  });
});

describe('matchLabel', () => {
  it.each([
    ['', 0, 0, ''],
    ['  ', -1, 0, ''],
    ['x', -1, 0, 'No results'],
    ['x', 0, 1, '1 of 1'],
    ['x', 2, 12, '3 of 12'],
  ])('%j at %i of %i is %j', (query, current, count, expected) => {
    expect(matchLabel(query, current, count)).toBe(expected);
  });
});

describe('paintMatches', () => {
  const registry = new Map<string, { ranges: Range[] }>();

  beforeEach(() => {
    registry.clear();
    vi.stubGlobal('CSS', { highlights: registry });
    vi.stubGlobal(
      'Highlight',
      class {
        ranges: Range[];
        constructor(...ranges: Range[]) {
          this.ranges = ranges;
        }
      },
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('paints the current match apart from the others', () => {
    const ranges = findTextRanges(rootWith('<p>a a a</p>'), 'a');
    paintMatches(ranges, 1);
    expect(registry.get(FIND_HIGHLIGHT)?.ranges).toEqual([ranges[0], ranges[2]]);
    expect(registry.get(FIND_HIGHLIGHT_CURRENT)?.ranges).toEqual([ranges[1]]);
  });

  it('paints no current match when none is selected', () => {
    const ranges = findTextRanges(rootWith('<p>a a</p>'), 'a');
    registry.set(FIND_HIGHLIGHT_CURRENT, { ranges: [] });
    paintMatches(ranges, -1);
    expect(registry.get(FIND_HIGHLIGHT)?.ranges).toHaveLength(2);
    expect(registry.has(FIND_HIGHLIGHT_CURRENT)).toBe(false);
  });

  it.each([
    ['no matches', () => paintMatches([], -1)],
    ['clearMatches', () => clearMatches()],
  ])('clears both highlights for %s', (_name, clear) => {
    registry.set(FIND_HIGHLIGHT, { ranges: [] });
    registry.set(FIND_HIGHLIGHT_CURRENT, { ranges: [] });
    clear();
    expect(registry.size).toBe(0);
  });

  it('does nothing without the Highlight API', () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('CSS', {});
    expect(() => paintMatches(findTextRanges(rootWith('<p>a</p>'), 'a'), 0)).not.toThrow();
  });
});

function Harness({ workbenchId = 'wb-1', partial = false, children }: { workbenchId?: string; partial?: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div>
      <TranscriptFindBar workbenchId={workbenchId} scrollRef={ref} partial={partial} />
      <div ref={ref} data-testid={`scroll-${workbenchId}`}>
        {children}
      </div>
    </div>
  );
}

const open = (id = 'wb-1') => act(() => requestTranscriptFind(id));
const input = () => screen.getByRole('textbox', { name: 'Find in transcript' });
const type = (value: string) => fireEvent.change(input(), { target: { value } });

describe('TranscriptFindBar', () => {
  it('stays closed until its own session asks', () => {
    render(<Harness><p>hello</p></Harness>);
    expect(screen.queryByRole('search')).toBeNull();
    open('wb-other');
    expect(screen.queryByRole('search')).toBeNull();
    open('wb-1');
    expect(screen.getByRole('search', { name: 'Find in transcript' })).toBeInTheDocument();
  });

  it('counts matches and steps through them with Enter and Shift+Enter, wrapping', () => {
    render(<Harness><p>alpha beta</p><p>Alpha</p><p>ALPHA</p></Harness>);
    open();
    type('alpha');
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(screen.getByText('2 of 3')).toBeInTheDocument();
    fireEvent.keyDown(input(), { key: 'Enter' });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true });
    expect(screen.getByText('3 of 3')).toBeInTheDocument();
  });

  it('steps with the buttons', () => {
    render(<Harness><p>x x</p></Harness>);
    open();
    type('x');
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
  });

  it('shows No results and disables the step buttons', () => {
    render(<Harness><p>hello</p></Harness>);
    open();
    type('zzz');
    expect(screen.getByText('No results')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous match' })).toBeDisabled();
  });

  it('does not count its own text', () => {
    render(<Harness><p>of</p></Harness>);
    open();
    type('of');
    expect(screen.getByText('1 of 1')).toBeInTheDocument();
  });

  it.each([
    ['Escape', () => fireEvent.keyDown(input(), { key: 'Escape' })],
    ['the close button', () => fireEvent.click(screen.getByRole('button', { name: 'Close find' }))],
  ])('closes with %s and keeps the query for the next open', (_name, close) => {
    render(<Harness><p>hello</p></Harness>);
    open();
    type('hel');
    close();
    expect(screen.queryByRole('search')).toBeNull();
    open();
    expect(input()).toHaveValue('hel');
    expect(screen.getByText('1 of 1')).toBeInTheDocument();
  });

  it('closes when another session opens its find bar', () => {
    render(
      <>
        <Harness workbenchId="wb-1"><p>a</p></Harness>
        <Harness workbenchId="wb-2"><p>a</p></Harness>
      </>,
    );
    open('wb-1');
    expect(screen.getAllByRole('search')).toHaveLength(1);
    open('wb-2');
    const bars = screen.getAllByRole('search');
    expect(bars).toHaveLength(1);
    expect(bars[0].parentElement?.querySelector('[data-testid="scroll-wb-2"]')).not.toBeNull();
  });

  it('counts again when the transcript changes', async () => {
    const { rerender } = render(<Harness><p>needle</p></Harness>);
    open();
    type('needle');
    expect(screen.getByText('1 of 1')).toBeInTheDocument();
    rerender(<Harness><p>needle</p><p>another needle</p></Harness>);
    await waitFor(() => expect(screen.getByText('1 of 2')).toBeInTheDocument());
    rerender(<Harness><p>nothing</p></Harness>);
    await waitFor(() => expect(screen.getByText('No results')).toBeInTheDocument());
  });

  it('says when earlier messages are not searched', () => {
    render(<Harness partial><p>a</p></Harness>);
    open();
    expect(screen.getByTitle('Only loaded messages are searched. Scroll up to load earlier ones.')).toBeInTheDocument();
  });
});

describe('⌘F shortcut', () => {
  const press = (target: EventTarget = document.body) => {
    const e = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', metaKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'target', { value: target });
    return dispatchKeydown(e, { menuOwnsChords: false, mac: true });
  };
  const opened: string[] = [];
  const onOpen = (e: Event) => opened.push((e as CustomEvent<{ workbenchId: string }>).detail.workbenchId);

  beforeEach(() => {
    opened.length = 0;
    window.addEventListener(OPEN_TRANSCRIPT_FIND_EVENT, onOpen);
    clearShortcuts();
    registerShortcuts(buildAppShortcuts());
    useWorkspaceStore.setState({ features: { workbenches: true } } as never);
    useSplitViewStore.setState({ panes: ['wb-a', 'wb-b'], focusedId: 'wb-b' } as never);
  });

  afterEach(() => {
    window.removeEventListener(OPEN_TRANSCRIPT_FIND_EVENT, onOpen);
    clearShortcuts();
  });

  it('is ⌘F in the key table', () => {
    expect(MENU_COMMANDS.find((c) => c.id === 'transcript.find')?.keys).toBe('mod+f');
  });

  it.each([
    ['an open session', { view: 'workbench', id: 'wb-1' }, 'wb-1'],
    ['split view, the focused pane', { view: 'split' }, 'wb-b'],
    ['home', { view: 'home' }, null],
    ['history', { view: 'history' }, null],
  ] as const)('targets %s', (_name, route, expected) => {
    useNavigationStore.setState({ route } as never);
    expect(findTargetWorkbenchId()).toBe(expected);
    expect(press()).toBe(expected !== null);
    expect(opened).toEqual(expected ? [expected] : []);
  });

  it('leaves ⌘F to the browser when sessions are not offered', () => {
    useWorkspaceStore.setState({ features: { workbenches: false } } as never);
    useNavigationStore.setState({ route: { view: 'workbench', id: 'wb-1' } } as never);
    expect(press()).toBe(false);
    expect(opened).toEqual([]);
  });

  it('works from the composer', () => {
    useNavigationStore.setState({ route: { view: 'workbench', id: 'wb-1' } } as never);
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    expect(press(textarea)).toBe(true);
    expect(opened).toEqual(['wb-1']);
  });

  it.each(['xterm', 'monaco-editor', 'cm-editor'])('leaves ⌘F to a .%s', (cls) => {
    useNavigationStore.setState({ route: { view: 'workbench', id: 'wb-1' } } as never);
    const host = document.createElement('div');
    host.className = cls;
    const textarea = document.createElement('textarea');
    host.appendChild(textarea);
    document.body.appendChild(host);
    textarea.focus();
    expect(press(textarea)).toBe(false);
    expect(opened).toEqual([]);
  });
});

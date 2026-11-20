import '@testing-library/jest-dom/vitest';
import React, { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import {
  selectionActionPosition,
  selectionPrefill,
  TranscriptSelectionAction,
} from '../components/workbench/TranscriptSelectionAction';
import { useNavigationStore } from '../stores/navigation';
import { useWorkbenchStore } from '../stores/workbenches';
import { useWorkspaceStore } from '../stores/workspace';

const { trackEvent } = vi.hoisted(() => ({ trackEvent: vi.fn() }));
vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../lib/analytics', () => ({ trackEvent, captureAnalyticsException: vi.fn() }));

const box = (top: number, left: number, width: number, height: number) => ({ top, left, width, height, bottom: top + height, right: left + width });
const CONTAINER = box(100, 50, 600, 400);

describe('selectionActionPosition', () => {
  it.each<[string, ReturnType<typeof box>[], { top: number; left: number } | null]>([
    ['above the first line when there is room', [box(200, 120, 100, 16), box(216, 60, 300, 16)], { top: 200 - 100 - 28 - 6, left: 70 }],
    ['under the last line when the first is at the top', [box(110, 120, 100, 16), box(126, 60, 300, 16)], { top: 126 + 16 - 100 + 6, left: 10 }],
    ['inside the left edge', [box(300, 40, 100, 16)], { top: 300 - 100 - 34, left: 8 }],
    ['inside the right edge', [box(300, 600, 40, 16)], { top: 300 - 100 - 34, left: 600 - 220 - 8 }],
    ['skips empty rects', [box(0, 0, 0, 0), box(300, 150, 40, 16)], { top: 300 - 100 - 34, left: 100 }],
    ['nothing for no rects', [], null],
    ['nothing above the view', [box(10, 120, 100, 16)], null],
    ['nothing below the view', [box(900, 120, 100, 16)], null],
  ])('%s', (_name, rects, expected) => {
    expect(selectionActionPosition(CONTAINER, rects)).toEqual(expected);
  });

  it('stays inside the view when the selection runs past its bottom', () => {
    const position = selectionActionPosition(CONTAINER, [box(105, 120, 100, 16), box(480, 60, 300, 16), box(700, 60, 300, 16)]);
    expect(position?.top).toBe(400 - 28 - 8);
  });
});

const wb = (extra: Partial<Workbench> = {}) =>
  ({ id: 'wb1', workspaceId: 'ws1', kind: 'session', repositoryId: 'repo1', repoFullName: 'acme/web', ...extra }) as Workbench;

describe('selectionPrefill', () => {
  it.each<[string, Workbench, string | null, object]>([
    ['a session in the shown workspace', wb(), 'ws1', { repositoryId: 'repo1', repoFullName: 'acme/web' }],
    ['a session in another workspace', wb({ workspaceId: 'ws2' }), 'ws1', { repoFullName: 'acme/web' }],
    ['a thread', wb({ kind: 'thread', repositoryId: null, repoFullName: '' }), 'ws1', {}],
    ['a session with no repository name', wb({ repoFullName: '' }), 'ws1', { repositoryId: 'repo1' }],
  ])('%s', (_name, source, current, expected) => {
    expect(selectionPrefill(source, 'line one\nline two', current)).toEqual({ prompt: '> line one\n> line two\n\n', ...expected });
  });
});

function Harness({ workbench = wb() }: { workbench?: Workbench }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div>
      <p data-testid="outside">Outside the transcript</p>
      <div ref={containerRef} style={{ position: 'relative' }}>
        <TranscriptSelectionAction workbench={workbench} scrollRef={scrollRef} containerRef={containerRef} />
        <div ref={scrollRef} data-testid="scroll">
          <p data-testid="message">The agent found the bug in parse()</p>
          <textarea data-testid="field" defaultValue="an answer" />
        </div>
      </div>
    </div>
  );
}

function select(node: Node, start = 0, end = node.textContent?.length ?? 0) {
  const target = node.firstChild ?? node;
  const range = document.createRange();
  range.setStart(target, start);
  range.setEnd(target, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

async function release() {
  fireEvent.mouseUp(document);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const button = () => screen.queryByRole('button', { name: 'New session from selection' });

describe('TranscriptSelectionAction', () => {
  beforeEach(() => {
    // jsdom has no layout: give every range one line inside the container.
    Range.prototype.getClientRects = function () {
      return [box(300, 120, 100, 16)] as unknown as DOMRectList;
    };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(box(100, 50, 600, 400) as DOMRect);
    useWorkspaceStore.setState({ currentWorkspaceId: 'ws1' });
    useNavigationStore.getState().navigate({ view: 'workbench', id: 'wb1' });
    useWorkbenchStore.getState().clearNewWorkbenchPrefill();
  });

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    delete (Range.prototype as Partial<Range>).getClientRects;
  });

  it('shows over a selection in the transcript and opens a new session with it quoted', async () => {
    render(<Harness />);
    select(screen.getByTestId('message'), 4, 26);
    await release();
    expect(button()).toBeInTheDocument();
    expect(button()).toHaveStyle({ top: '166px', left: '70px' });

    const seq = useWorkbenchStore.getState().newWorkbench.seq;
    fireEvent.click(button()!);
    expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
    const request = useWorkbenchStore.getState().newWorkbench;
    expect(request.seq).toBe(seq + 1);
    expect(request.prefill).toEqual({ prompt: '> agent found the bug in\n\n', repositoryId: 'repo1', repoFullName: 'acme/web' });
    expect(trackEvent).toHaveBeenCalledWith('session_from_selection', { source_kind: 'session', chars: 22, repository_prefilled: true });
    expect(window.getSelection()?.isCollapsed).toBe(true);
    expect(button()).toBeNull();
  });

  it('keeps the selection when the button is pressed', async () => {
    render(<Harness />);
    select(screen.getByTestId('message'));
    await release();
    const pressed = fireEvent.mouseDown(button()!);
    expect(pressed).toBe(false);
  });

  it.each<[string, string]>([
    ['outside the transcript', 'outside'],
    ['in a text field of the transcript', 'field'],
  ])('does not show for a selection %s', async (_name, id) => {
    render(<Harness />);
    const node = screen.getByTestId(id);
    if (id === 'field') {
      const range = document.createRange();
      range.selectNodeContents(node);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    } else {
      select(node);
    }
    await release();
    expect(button()).toBeNull();
  });

  it('does not show for a selection of only spaces', async () => {
    render(<Harness />);
    const message = screen.getByTestId('message');
    message.textContent = 'a   b';
    select(message, 1, 4);
    await release();
    expect(button()).toBeNull();
  });

  it('hides when the selection goes away', async () => {
    render(<Harness />);
    select(screen.getByTestId('message'));
    await release();
    expect(button()).toBeInTheDocument();
    act(() => {
      window.getSelection()!.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(button()).toBeNull();
  });

  it('starts a session with no repository from a thread', async () => {
    render(<Harness workbench={wb({ kind: 'thread', repositoryId: null, repoFullName: '' })} />);
    select(screen.getByTestId('message'));
    await release();
    fireEvent.click(button()!);
    expect(useWorkbenchStore.getState().newWorkbench.prefill).toEqual({ prompt: '> The agent found the bug in parse()\n\n' });
    expect(trackEvent).toHaveBeenCalledWith('session_from_selection', expect.objectContaining({ source_kind: 'thread', repository_prefilled: false }));
  });
});

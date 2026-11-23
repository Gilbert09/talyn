import React, { useCallback, useEffect, useState } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import { transcriptQuotePrompt, type Workbench } from '@talyn/shared';
import { trackEvent } from '../../lib/analytics';
import { isThread } from '../../lib/threads';
import { useWorkspaceStore } from '../../stores/workspace';
import type { NewWorkbenchPrefill } from '../../stores/workbenches';
import { openNewWorkbench } from './new/openNewWorkbench';

/** The button's height and an estimate of its width, to keep it inside the transcript. */
const ACTION_HEIGHT = 28;
const ACTION_WIDTH = 220;
const GAP = 6;
const EDGE = 8;

export interface SelectionActionPosition {
  top: number;
  left: number;
}

type Box = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right' | 'width' | 'height'>;

/**
 * Where the button goes, relative to the container: above the first line of
 * the selection, or under its last line when there is no room above. Null
 * when the selection is out of view.
 */
export function selectionActionPosition(container: Box, rects: Box[]): SelectionActionPosition | null {
  const lines = rects.filter((r) => r.width > 0 || r.height > 0);
  if (lines.length === 0) return null;
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (last.bottom < container.top || first.top > container.bottom) return null;
  const roomAbove = first.top - container.top >= ACTION_HEIGHT + GAP + EDGE;
  const anchor = roomAbove ? first : last;
  const top = roomAbove ? first.top - container.top - ACTION_HEIGHT - GAP : Math.min(last.bottom - container.top + GAP, container.height - ACTION_HEIGHT - EDGE);
  const maxLeft = Math.max(EDGE, container.width - ACTION_WIDTH - EDGE);
  const left = Math.min(Math.max(anchor.left - container.left, EDGE), maxLeft);
  return { top: Math.max(EDGE, top), left };
}

/** The new-session prefill for a selection in this session's transcript. */
export function selectionPrefill(
  source: Pick<Workbench, 'kind' | 'repositoryId' | 'repoFullName' | 'workspaceId'>,
  text: string,
  currentWorkspaceId: string | null,
): NewWorkbenchPrefill {
  const prefill: NewWorkbenchPrefill = { prompt: transcriptQuotePrompt(text) };
  if (isThread(source)) return prefill;
  // A space session can run in another workspace. Its repository id means nothing here; its name works in the space composer.
  if (source.repositoryId && source.workspaceId === currentWorkspaceId) prefill.repositoryId = source.repositoryId;
  if (source.repoFullName) prefill.repoFullName = source.repoFullName;
  return prefill;
}

interface Shown extends SelectionActionPosition {
  text: string;
}

/** The selection's text and lines when it sits inside `root` and not in a text field. */
function readSelection(root: HTMLElement): { text: string; rects: DOMRect[] } | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const anchor = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
  if (anchor?.closest('input, textarea, [contenteditable="true"]')) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const rects = typeof range.getClientRects === 'function' ? Array.from(range.getClientRects()) : [];
  return { text, rects };
}

/**
 * Select text in a transcript and a "New session from selection" button shows
 * over it. The button opens the new-session page with the text quoted in the
 * composer and this session's repository chosen.
 */
export function TranscriptSelectionAction({
  workbench,
  scrollRef,
  containerRef,
}: {
  workbench: Workbench;
  /** The transcript's scrolling content. Only a selection inside it counts. */
  scrollRef: React.RefObject<HTMLElement | null>;
  /** The positioned element the button sits in. */
  containerRef: React.RefObject<HTMLElement | null>;
}) {
  const [shown, setShown] = useState<Shown | null>(null);

  const update = useCallback(() => {
    const root = scrollRef.current;
    const container = containerRef.current;
    if (!root || !container) return setShown(null);
    const read = readSelection(root);
    const position = read ? selectionActionPosition(container.getBoundingClientRect(), read.rects) : null;
    setShown(read && position ? { ...position, text: read.text } : null);
  }, [scrollRef, containerRef]);

  useEffect(() => {
    // Show after the mouse or a key lets go, not while a drag still grows the selection.
    const later = () => window.setTimeout(update, 0);
    const onSelectionChange = () => {
      const root = scrollRef.current;
      if (!root || !readSelection(root)) setShown(null);
    };
    document.addEventListener('mouseup', later);
    document.addEventListener('keyup', later);
    document.addEventListener('selectionchange', onSelectionChange);
    const scroller = scrollRef.current;
    scroller?.addEventListener('scroll', update, { passive: true });
    return () => {
      document.removeEventListener('mouseup', later);
      document.removeEventListener('keyup', later);
      document.removeEventListener('selectionchange', onSelectionChange);
      scroller?.removeEventListener('scroll', update);
    };
  }, [update, scrollRef]);

  // Another chat or session: whatever was selected is gone.
  useEffect(() => setShown(null), [workbench.id]);

  if (!shown) return null;

  const start = () => {
    const prefill = selectionPrefill(workbench, shown.text, useWorkspaceStore.getState().currentWorkspaceId);
    if (!prefill.prompt) return;
    trackEvent('session_from_selection', {
      source_kind: isThread(workbench) ? 'thread' : 'session',
      chars: shown.text.length,
      repository_prefilled: Boolean(prefill.repositoryId || prefill.repoFullName),
    });
    window.getSelection()?.removeAllRanges();
    setShown(null);
    openNewWorkbench(prefill);
  };

  return (
    <button
      type="button"
      data-attr="new-session-from-selection"
      className="absolute z-20 inline-flex h-7 items-center gap-1.5 rounded-md border bg-popover px-2.5 text-xs font-medium text-popover-foreground shadow-md hover:bg-accent hover:text-accent-foreground"
      style={{ top: shown.top, left: shown.left }}
      // Keep the selection: a press would clear it before the click lands.
      onMouseDown={(e) => e.preventDefault()}
      onClick={start}
    >
      <MessageSquarePlus className="h-3.5 w-3.5" />
      New session from selection
    </button>
  );
}

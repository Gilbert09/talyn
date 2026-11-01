import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

export const SIDEBAR_DEFAULT_WIDTH = 240;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;
const KEY = 'talyn-sidebar-width';
const KEY_STEP = 16;

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

function readWidth(): number {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? SIDEBAR_DEFAULT_WIDTH : clampSidebarWidth(Number(raw));
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function writeWidth(width: number): void {
  try {
    localStorage.setItem(KEY, String(width));
  } catch {
    // Private mode or a full disk: the width is only a convenience.
  }
}

/**
 * The expanded sidebar's width, which a person drags on its right edge. It is
 * remembered on this machine. Double-click the edge for the default width.
 */
export function useSidebarWidth() {
  const [width, setWidth] = useState(readWidth);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; width: number } | null>(null);
  const latest = useRef(width);
  latest.current = width;

  const commit = useCallback((next: number) => {
    const clamped = clampSidebarWidth(next);
    setWidth(clamped);
    writeWidth(clamped);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: globalThis.PointerEvent) => {
      if (!start.current) return;
      setWidth(clampSidebarWidth(start.current.width + e.clientX - start.current.x));
    };
    const up = () => {
      start.current = null;
      setDragging(false);
      writeWidth(latest.current);
    };
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [dragging]);

  const handleProps = {
    role: 'separator' as const,
    'aria-orientation': 'vertical' as const,
    'aria-label': 'Resize the sidebar',
    'aria-valuemin': SIDEBAR_MIN_WIDTH,
    'aria-valuemax': SIDEBAR_MAX_WIDTH,
    'aria-valuenow': width,
    tabIndex: 0,
    title: 'Drag to resize. Double-click for the default width.',
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      start.current = { x: e.clientX, width: latest.current };
      setDragging(true);
    },
    onDoubleClick: () => commit(SIDEBAR_DEFAULT_WIDTH),
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        commit(latest.current + (e.key === 'ArrowRight' ? KEY_STEP : -KEY_STEP));
      }
    },
  };

  return { width, dragging, handleProps };
}

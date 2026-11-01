import { useEffect, useRef } from 'react';

const EVENT = 'talyn-memory-changed';

/** Say that memory changed: a session saved one, or a person edited, forgot or restored one. */
export function notifyMemoryChanged(): void {
  window.dispatchEvent(new Event(EVENT));
}

/**
 * Call `onChange` when memory changes. Calls are grouped, so a transcript
 * that renders many memory cards at once causes one reload.
 */
export function useMemoryChanged(onChange: () => void, delayMs = 400): void {
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => latest.current(), delayMs);
    };
    window.addEventListener(EVENT, handler);
    return () => {
      window.removeEventListener(EVENT, handler);
      if (timer) clearTimeout(timer);
    };
  }, [delayMs]);
}

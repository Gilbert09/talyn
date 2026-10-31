import { useEffect, useRef, useState } from 'react';
import type { WorkbenchChat } from '@talyn/shared';

/** A counter that goes up each time one of the chats stops running. */
export function useTurnsEnded(chats: WorkbenchChat[] | undefined): number {
  const [count, setCount] = useState(0);
  const prev = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    let ended = false;
    const next = new Map<string, string>();
    for (const c of chats ?? []) {
      if (prev.current.get(c.id) === 'running' && c.status !== 'running') ended = true;
      next.set(c.id, c.status);
    }
    prev.current = next;
    if (ended) setCount((n) => n + 1);
  }, [chats]);
  return count;
}

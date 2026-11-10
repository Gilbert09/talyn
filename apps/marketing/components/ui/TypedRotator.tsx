"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const TYPE_MS = 45;
const DELETE_MS = 22;
/** How long a finished phrase stays on screen before it is deleted. */
const HOLD_MS = 2600;
/** The first phrase is already there on load, so it gets longer to be read. */
const FIRST_HOLD_MS = 3200;

/**
 * Types out each phrase in turn, deleting the last one first, then stops on
 * the first phrase after one pass.
 *
 * Three things are deliberate:
 * - The server renders `phrases[0]` in full. Search engines, link previews,
 *   no-JS visitors and the first paint all get the real headline, and the
 *   animation only starts after mount.
 * - Every phrase is also rendered, invisible, in the same grid cell, so the
 *   element is always as tall as its longest phrase. Without that, a phrase
 *   that wraps to a second line on a phone would push the whole page down
 *   while it was being typed.
 * - It runs once. Text that moves for ever is hard to read and needs a pause
 *   control (WCAG 2.2.2); one pass fits inside the ~28 s a median visitor
 *   spends on the page. Visitors who ask for reduced motion get the first
 *   phrase and no animation at all.
 *
 * At rest (server render, before the pass starts and after it ends) it is one
 * plain span holding `phrases[0]`, so a crawler or a screen reader reads the
 * heading as one sentence. Only while it types is the moving text
 * `aria-hidden`, with `phrases[0]` in a visually hidden copy and the sizing
 * copies beside it.
 */
export function TypedRotator({
  phrases,
  className,
}: {
  phrases: string[];
  className?: string;
}) {
  const [text, setText] = useState(phrases[0] ?? "");
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (phrases.length < 2) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // Each phrase after the first, then the first again to finish on it.
    const order = [...phrases.slice(1), phrases[0]];
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      });

    (async () => {
      let current = phrases[0];
      await wait(FIRST_HOLD_MS);
      if (cancelled) return;
      setRunning(true);
      for (const next of order) {
        for (let i = current.length; i >= 0; i--) {
          if (cancelled) return;
          setText(current.slice(0, i));
          await wait(DELETE_MS);
        }
        for (let i = 1; i <= next.length; i++) {
          if (cancelled) return;
          setText(next.slice(0, i));
          await wait(TYPE_MS);
        }
        current = next;
        if (next !== phrases[0]) await wait(HOLD_MS);
      }
      if (!cancelled) setRunning(false);
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phrases]);

  if (!running) {
    return <span className={cn("block", className)}>{text}</span>;
  }

  return (
    <span className={cn("block", className)}>
      <span className="sr-only">{phrases[0]}</span>
      <span aria-hidden className="grid">
        {phrases.map((p) => (
          <span key={p} className="invisible col-start-1 row-start-1">
            {p}
          </span>
        ))}
        <span className="col-start-1 row-start-1">
          {text}
          {/* A zero-size anchor with the caret positioned off it, so the
              caret can never make the line box taller. */}
          <span className="relative inline-block h-0 w-0">
            <span className="absolute left-[0.06em] top-[-0.82em] h-[0.92em] w-[0.06em] animate-caret bg-current" />
          </span>
        </span>
      </span>
    </span>
  );
}

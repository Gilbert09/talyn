import * as React from 'react';
import { cn } from '../../lib/utils';

const MODIFIERS = new Set(['⌘', '⇧', '⌥', '⌃', '⎋', '⏎', '⌫', '⇥', '↑', '↓', '←', '→']);

/** Between the steps of a sequence, as `formatKeys` writes it ("G then P"). */
const SEQUENCE_SEPARATOR = ' then ';

/** Split a shortcut string like "⌘⇧P" or "Ctrl+K" into individual keys. */
export function splitShortcut(shortcut: string): string[] {
  if (shortcut.includes('+') && shortcut.length > 1) {
    return shortcut.split('+').filter(Boolean);
  }
  const keys: string[] = [];
  let word = '';
  for (const ch of Array.from(shortcut)) {
    if (MODIFIERS.has(ch)) {
      if (word) keys.push(word);
      word = '';
      keys.push(ch);
    } else {
      word += ch;
    }
  }
  if (word) keys.push(word);
  return keys;
}

/** "G then P" → [['G'], ['P']]; a chord is one step. */
export function splitSequence(shortcut: string): string[][] {
  return shortcut.split(SEQUENCE_SEPARATOR).map(splitShortcut);
}

interface KbdProps extends React.HTMLAttributes<HTMLElement> {
  keys: string;
}

export function Kbd({ keys, className, ...props }: KbdProps) {
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)} {...props}>
      {splitSequence(keys).map((step, s) => (
        <React.Fragment key={s}>
          {s > 0 && <span className="px-0.5 text-[10px] text-muted-foreground">then</span>}
          {step.map((key, i) => (
            <kbd
              key={`${key}-${i}`}
              className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[10px] font-medium leading-none text-muted-foreground"
            >
              {key}
            </kbd>
          ))}
        </React.Fragment>
      ))}
    </span>
  );
}

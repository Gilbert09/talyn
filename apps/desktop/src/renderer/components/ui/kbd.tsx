import * as React from 'react';
import { cn } from '../../lib/utils';

const MODIFIERS = new Set(['⌘', '⇧', '⌥', '⌃', '⎋', '⏎', '⌫', '⇥', '↑', '↓', '←', '→']);

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

interface KbdProps extends React.HTMLAttributes<HTMLElement> {
  keys: string;
}

export function Kbd({ keys, className, ...props }: KbdProps) {
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)} {...props}>
      {splitShortcut(keys).map((key, i) => (
        <kbd
          key={`${key}-${i}`}
          className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[10px] font-medium leading-none text-muted-foreground"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

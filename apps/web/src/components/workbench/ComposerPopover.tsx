import { useEffect, useRef } from 'react';
import { FileText, Slash } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * What the caret is in the middle of typing: an `@file` mention anywhere, or a
 * `/command` at the very start of the message. Null when neither.
 */
export interface ComposerTrigger {
  kind: 'mention' | 'slash';
  query: string;
  /** Index of the `@` or `/` in the text. */
  start: number;
  /** The caret. */
  end: number;
}

export function findTrigger(text: string, caret: number): ComposerTrigger | null {
  const before = text.slice(0, caret);
  const slash = /^\/([^\s]*)$/.exec(before);
  if (slash) return { kind: 'slash', query: slash[1], start: 0, end: caret };
  const mention = /(^|\s)@([^\s@]*)$/.exec(before);
  if (mention) {
    const start = caret - mention[2].length - 1;
    return { kind: 'mention', query: mention[2], start, end: caret };
  }
  return null;
}

/** The text with the trigger replaced by the chosen item, and where the caret goes. */
export function applyTrigger(text: string, trigger: ComposerTrigger, value: string): { text: string; caret: number } {
  const insert = trigger.kind === 'mention' ? `@${value} ` : `/${value} `;
  const next = text.slice(0, trigger.start) + insert + text.slice(trigger.end);
  return { text: next, caret: trigger.start + insert.length };
}

export function ComposerPopover({
  kind,
  items,
  active,
  loading,
  onPick,
  onHover,
}: {
  kind: ComposerTrigger['kind'];
  items: string[];
  active: number;
  loading: boolean;
  onPick: (item: string) => void;
  onHover: (index: number) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const Icon = kind === 'mention' ? FileText : Slash;
  return (
    <div className="absolute bottom-full left-0 right-0 z-20 mb-1 max-h-60 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg">
      <div className="border-b px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {kind === 'mention' ? 'Files' : 'Commands and skills'}
      </div>
      {items.length === 0 ? (
        <p className="px-2 py-2 text-xs text-muted-foreground">
          {loading ? 'Loading…' : kind === 'mention' ? 'No matching file.' : 'No matching command.'}
        </p>
      ) : (
        <ul ref={listRef} className="max-h-52 overflow-y-auto py-1" role="listbox">
          {items.map((item, i) => (
            <li key={item} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(e) => {
                  // Keep the textarea's focus and caret.
                  e.preventDefault();
                  onPick(item);
                }}
                onMouseEnter={() => onHover(i)}
                className={cn(
                  'flex w-full items-center gap-2 px-2 py-1 text-left font-mono text-xs',
                  i === active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
                )}
              >
                <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span dir="rtl" className="min-w-0 truncate text-left">
                  <bdi>{item}</bdi>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

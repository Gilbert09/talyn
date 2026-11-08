import { useEffect, useRef } from 'react';
import { AtSign, FileText, Settings, Slash } from 'lucide-react';
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

/**
 * What a thread's `@` offers instead of files: repositories and sessions.
 * `labels` maps an item to the text shown; the item itself is what is inserted.
 */
export interface ComposerMentionSource {
  heading: string;
  empty: string;
  labels: Record<string, string>;
}

/** A `/` entry that opens a page of the app instead of going to the agent. */
export interface ComposerLink {
  id: string;
  label: string;
  description: string;
}

export function ComposerPopover({
  kind,
  items,
  active,
  loading,
  onPick,
  onHover,
  mentions,
  descriptions,
  links = [],
  onPickLink,
}: {
  kind: ComposerTrigger['kind'];
  items: string[];
  /** Index into `items`, then `links`. */
  active: number;
  loading: boolean;
  onPick: (item: string) => void;
  onHover: (index: number) => void;
  mentions?: ComposerMentionSource;
  /** One line under each item, by item. */
  descriptions?: Record<string, string>;
  links?: ComposerLink[];
  onPickLink?: (id: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const Icon = kind === 'mention' ? (mentions ? AtSign : FileText) : Slash;
  const rowClass = (index: number) =>
    cn(
      'flex w-full items-center gap-2 px-2 py-1 text-left text-xs',
      index === active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
    );
  return (
    <div className="absolute bottom-full left-0 right-0 z-20 mb-1 max-h-60 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg">
      <div className="border-b px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {kind === 'mention' ? (mentions?.heading ?? 'Files') : 'Commands and skills'}
      </div>
      {items.length === 0 && links.length === 0 ? (
        <p className="px-2 py-2 text-xs text-muted-foreground">
          {loading ? 'Loading…' : kind === 'mention' ? (mentions?.empty ?? 'No matching file.') : 'No matching command.'}
        </p>
      ) : (
        <div ref={listRef} className="max-h-52 overflow-y-auto py-1">
          {items.length > 0 && (
            <ul role="listbox">
              {items.map((item, i) => (
                <li key={item} role="option" aria-selected={i === active} data-index={i}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      // Keep the textarea's focus and caret.
                      e.preventDefault();
                      onPick(item);
                    }}
                    onMouseEnter={() => onHover(i)}
                    className={rowClass(i)}
                  >
                    <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
                    {mentions ? (
                      <span className="min-w-0 truncate font-mono">{mentions.labels[item] ?? item}</span>
                    ) : kind === 'mention' ? (
                      <span dir="rtl" className="min-w-0 truncate text-left font-mono">
                        <bdi>{item}</bdi>
                      </span>
                    ) : (
                      <>
                        <span className="min-w-0 max-w-[50%] shrink-0 truncate font-mono">{item}</span>
                        {descriptions?.[item] && (
                          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={descriptions[item]}>
                            {descriptions[item]}
                          </span>
                        )}
                      </>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {links.length > 0 && (
            <>
              <div
                className={cn(
                  'px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground',
                  items.length > 0 && 'mt-1 border-t',
                )}
              >
                Settings
              </div>
              <ul role="listbox" aria-label="Settings">
                {links.map((link, i) => {
                  const index = items.length + i;
                  return (
                    <li key={link.id} role="option" aria-selected={index === active} data-index={index}>
                      <button
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          onPickLink?.(link.id);
                        }}
                        onMouseEnter={() => onHover(index)}
                        className={rowClass(index)}
                      >
                        <Settings className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 max-w-[50%] shrink-0 truncate">{link.label}</span>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground" title={link.description}>
                          {link.description}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

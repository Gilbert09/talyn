import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { composerMarkdown, type ComposerLine, type ComposerMark } from '@talyn/shared';
import { cn } from '../../lib/utils';

/**
 * A textarea that shows its Markdown formatted while you type.
 *
 * The textarea stays the real input (caret, selection, IME, the `@` and `/`
 * popovers): its text is transparent, and a styled copy of the same text sits
 * behind it. The copy must wrap exactly like the textarea, so the styles only
 * change colour, background and decoration, never the width of a glyph (bold
 * is a text stroke, not a heavier font).
 */
export function MarkdownTextarea({
  value,
  textClassName,
  className,
  ref,
  onScroll,
  disabled,
  ...props
}: Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value'> & {
  value: string;
  /** Padding and type size. The textarea and the styled copy share them, so they line up. */
  textClassName: string;
  ref?: React.Ref<HTMLTextAreaElement>;
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => composerMarkdown(value), [value]);

  const setRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      inputRef.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
    },
    [ref],
  );

  // Keep the copy on the textarea's scroll position, and out of its scrollbar.
  const sync = useCallback(() => {
    const el = inputRef.current;
    const copy = copyRef.current;
    if (!el || !copy) return;
    copy.style.right = `${Math.max(0, el.offsetWidth - el.clientWidth)}px`;
    copy.scrollTop = el.scrollTop;
  }, []);

  useLayoutEffect(() => {
    sync();
    // The composer sizes the textarea after this effect: sync again once it has.
    const frame = window.requestAnimationFrame(sync);
    return () => window.cancelAnimationFrame(frame);
  }, [value, sync]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => observer.disconnect();
  }, [sync]);

  return (
    <div className="relative">
      <div
        ref={copyRef}
        aria-hidden
        data-attr="composer-formatting"
        className={cn(
          'pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-foreground',
          textClassName,
          disabled && 'opacity-50',
        )}
      >
        {lines.map((line, index) => (
          <ComposerLineView key={index} line={line} />
        ))}
      </div>
      <textarea
        {...props}
        ref={setRef}
        value={value}
        disabled={disabled}
        onScroll={(e) => {
          sync();
          onScroll?.(e);
        }}
        className={cn(
          'relative',
          textClassName,
          className,
          'text-transparent caret-foreground selection:bg-primary/25 selection:text-transparent',
        )}
      />
    </div>
  );
}

const LINE_CLASS: Record<ComposerLine['kind'], string | undefined> = {
  text: undefined,
  heading: undefined,
  list: undefined,
  quote: 'relative text-muted-foreground before:absolute before:inset-y-0 before:-left-2 before:w-0.5 before:rounded-full before:bg-border',
  fence: 'bg-muted/70',
  code: 'bg-muted/70',
};

const MARK_CLASS: Record<ComposerMark, string> = {
  marker: 'text-muted-foreground/60',
  bold: '[-webkit-text-stroke:0.45px_currentColor]',
  // A real slant would change glyph widths and move the caret off the text.
  italic: 'text-violet-700 dark:text-violet-300',
  strike: 'line-through decoration-muted-foreground',
  code: 'rounded-[3px] bg-muted text-rose-700 dark:text-rose-300',
  link: 'text-blue-600 underline decoration-blue-600/40 underline-offset-2 dark:text-blue-400 dark:decoration-blue-400/40',
  mention: 'rounded-[3px] bg-sky-500/10 text-sky-700 dark:text-sky-300',
  command: 'rounded-[3px] bg-primary/10 text-primary',
};

function ComposerLineView({ line }: { line: ComposerLine }) {
  return (
    <div className={LINE_CLASS[line.kind]}>
      {line.spans.length === 0
        ? '\u200b'
        : line.spans.map((span, index) =>
            span.marks.length === 0 ? (
              <React.Fragment key={index}>{span.text}</React.Fragment>
            ) : (
              <span key={index} className={cn(span.marks.map((mark) => MARK_CLASS[mark]))}>
                {span.text}
              </span>
            ),
          )}
    </div>
  );
}

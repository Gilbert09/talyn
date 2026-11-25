import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { closeFenceOnNewline, composerMarkdown, type ComposerLine, type ComposerMark } from '@talyn/shared';
import { cn } from '../../lib/utils';

/**
 * A textarea that shows its Markdown formatted while you type.
 *
 * The textarea stays the real input (caret, selection, IME, the `@` and `/`
 * popovers): its text is transparent, and a styled copy of the same text sits
 * behind it. The copy must wrap exactly like the textarea, so the styles only
 * change colour, background and decoration, never the width of a glyph (bold
 * is a text stroke, not a heavier font).
 *
 * A code fence's backticks only show while the caret is on their line, and a
 * new line after an opening fence adds the closing one.
 */
export function MarkdownTextarea({
  value,
  textClassName,
  className,
  ref,
  onScroll,
  onKeyDown,
  onSelect,
  onBlur,
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
  // The lines the caret or selection is on, while the textarea has focus.
  const [caretLines, setCaretLines] = useState<[number, number] | null>(null);

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

  const trackCaret = useCallback(() => {
    const el = inputRef.current;
    if (!el || document.activeElement !== el) {
      setCaretLines(null);
      return;
    }
    const lineOf = (at: number) => el.value.slice(0, at).split('\n').length - 1;
    const from = lineOf(el.selectionStart);
    const to = lineOf(el.selectionEnd);
    setCaretLines((old) => (old && old[0] === from && old[1] === to ? old : [from, to]));
  }, []);

  const keyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const el = e.currentTarget;
    const close = closeFenceOnNewline(el.value, el.selectionStart, el.selectionEnd);
    if (!close) return;
    e.preventDefault();
    insertText(el, close.insert);
    el.setSelectionRange(close.caret, close.caret);
    trackCaret();
  };

  useLayoutEffect(() => {
    trackCaret();
  }, [value, trackCaret]);

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
        {fenceSides(lines).map((side, index) => (
          <ComposerLineView
            key={index}
            line={lines[index]}
            side={side}
            showMarkers={caretLines !== null && index >= caretLines[0] && index <= caretLines[1]}
          />
        ))}
      </div>
      <textarea
        {...props}
        ref={setRef}
        value={value}
        disabled={disabled}
        onKeyDown={keyDown}
        onSelect={(e) => {
          trackCaret();
          onSelect?.(e);
        }}
        onBlur={(e) => {
          setCaretLines(null);
          onBlur?.(e);
        }}
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

/**
 * Inserts text at the selection as if typed, so undo still works. The
 * fallback (no execCommand, as in tests) fires the input event React reads.
 */
function insertText(el: HTMLTextAreaElement, text: string) {
  if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)) return;
  el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

type FenceSide = 'open' | 'close' | undefined;

/** Which fence lines open a code block and which close one: they alternate. */
function fenceSides(lines: ComposerLine[]): FenceSide[] {
  let open = false;
  return lines.map((line) => {
    if (line.kind !== 'fence') return undefined;
    open = !open;
    return open ? 'open' : 'close';
  });
}

const FENCE_RUN = /^\s*(`+|~+)/;

function ComposerLineView({ line, side, showMarkers }: { line: ComposerLine; side: FenceSide; showMarkers: boolean }) {
  if (line.kind === 'fence') {
    // The backticks hide away from the caret; a language name stays as a label.
    const text = line.spans.map((span) => span.text).join('');
    const run = FENCE_RUN.exec(text)?.[0] ?? '';
    return (
      <div className={cn(LINE_CLASS.fence, side === 'open' ? 'rounded-t-md' : 'rounded-b-md')} data-fence={side}>
        <span className={showMarkers ? MARK_CLASS.marker : 'text-transparent'}>{run}</span>
        {text.length > run.length ? <span className={MARK_CLASS.marker}>{text.slice(run.length)}</span> : null}
      </div>
    );
  }
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

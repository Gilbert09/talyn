import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';

// The native `title` tooltip waits about a second and cannot be styled. This
// layer shows every `title` in the app as a styled tooltip after a short
// delay, so icon buttons explain themselves quickly without each call site
// moving to a Radix <Tooltip>. While an element is hovered, its `title` moves
// to `data-title-tooltip` so the native tooltip does not show as well.

export const TITLE_TOOLTIP_OPEN_DELAY_MS = 150;
// After a tooltip closes, the next one in this window opens at once, so
// running the pointer along a row of icons reads each label without a wait.
export const TITLE_TOOLTIP_SKIP_DELAY_MS = 400;

const SAVED_ATTR = 'data-title-tooltip';
const GAP = 6;
const VIEWPORT_MARGIN = 8;
// An anchor larger than this (a whole row or card) gets its tooltip next to
// the pointer instead of under the anchor.
const MAX_ANCHORED_WIDTH = 240;
const MAX_ANCHORED_HEIGHT = 64;
const POINTER_OFFSET = 18;

interface TipState {
  text: string;
  anchor: DOMRect;
  pointer: { x: number; y: number };
}

/** React's current `title` prop for the element, when React rendered it. */
function reactTitle(el: Element): string | null | undefined {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
  if (!key) return undefined;
  const props = (el as unknown as Record<string, { title?: unknown } | undefined>)[key];
  return typeof props?.title === 'string' ? props.title : null;
}

function findTitled(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const el = target.closest(`[title], [${SAVED_ATTR}]`);
  return el instanceof HTMLElement && !(el instanceof HTMLIFrameElement) ? el : null;
}

export function TitleTooltipLayer() {
  const [tip, setTip] = useState<TipState | null>(null);

  useEffect(() => {
    let anchor: HTMLElement | null = null;
    let text = '';
    let openTimer: number | undefined;
    let connectedTimer: number | undefined;
    let observer: MutationObserver | null = null;
    let visible = false;
    let dismissed = false;
    let lastClosedAt = Number.NEGATIVE_INFINITY;
    const pointer = { x: 0, y: 0 };

    const hide = () => {
      window.clearTimeout(openTimer);
      openTimer = undefined;
      if (visible) lastClosedAt = Date.now();
      visible = false;
      setTip(null);
    };

    const show = () => {
      openTimer = undefined;
      if (!anchor || dismissed || !anchor.isConnected) return;
      visible = true;
      setTip({ text, anchor: anchor.getBoundingClientRect(), pointer: { ...pointer } });
    };

    // Move a `title` that React (or anything else) sets during the hover.
    const takeTitle = (el: HTMLElement) => {
      const value = el.getAttribute('title');
      if (value === null) return;
      el.setAttribute(SAVED_ATTR, value);
      el.removeAttribute('title');
      text = value;
    };

    const release = () => {
      hide();
      observer?.disconnect();
      observer = null;
      window.clearInterval(connectedTimer);
      connectedTimer = undefined;
      const el = anchor;
      anchor = null;
      dismissed = false;
      if (!el) return;
      const saved = el.getAttribute(SAVED_ATTR);
      el.removeAttribute(SAVED_ATTR);
      // React only writes `title` when the prop changes, so a prop removed
      // during the hover never reached the DOM. Restore what React has now.
      const current = reactTitle(el);
      const restore = current === undefined ? saved : current;
      if (restore !== null && el.getAttribute('title') === null) {
        el.setAttribute('title', restore);
      }
    };

    const capture = (el: HTMLElement) => {
      const value = el.getAttribute('title') ?? el.getAttribute(SAVED_ATTR);
      // `title=""` turns the tooltip off on purpose; leave it alone.
      if (!value || !value.trim()) return;
      anchor = el;
      takeTitle(el);
      text = value;
      observer = new MutationObserver(() => {
        if (!anchor) return;
        if (anchor.getAttribute('title') === null) return;
        takeTitle(anchor);
        if (visible) show();
      });
      observer.observe(el, { attributes: true, attributeFilter: ['title'] });
      // The anchor can leave the DOM under a still pointer (a row that was
      // archived), and no pointer event says so.
      connectedTimer = window.setInterval(() => {
        if (anchor && !anchor.isConnected) release();
      }, 250);
      const recent = Date.now() - lastClosedAt < TITLE_TOOLTIP_SKIP_DELAY_MS;
      if (recent) show();
      else openTimer = window.setTimeout(show, TITLE_TOOLTIP_OPEN_DELAY_MS);
    };

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      const el = findTitled(event.target);
      if (el === anchor) return;
      release();
      if (el) capture(el);
    };

    const onPointerMove = (event: PointerEvent) => {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
    };

    const onPointerOut = (event: PointerEvent) => {
      // Leaving the window: no pointerover follows.
      if (event.relatedTarget == null) release();
    };

    // Like the native tooltip: a press or a key hides it, and it stays hidden
    // until the pointer moves to another element.
    const dismiss = () => {
      if (!anchor) return;
      dismissed = true;
      hide();
    };

    // Only a scroll that moves the anchor matters; a chat that scrolls itself
    // elsewhere on the screen must not close the tooltip.
    const onScroll = (event: Event) => {
      const target = event.target;
      if (!anchor) return;
      if (target instanceof Document || (target instanceof Node && target.contains(anchor))) {
        dismiss();
      }
    };

    document.addEventListener('pointerover', onPointerOver, true);
    document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
    document.addEventListener('pointerout', onPointerOut, true);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', dismiss, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('blur', release);
    return () => {
      document.removeEventListener('pointerover', onPointerOver, true);
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerout', onPointerOut, true);
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', dismiss, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('blur', release);
      release();
    };
  }, []);

  if (!tip || typeof document === 'undefined') return null;
  return createPortal(<TitleTooltipBubble tip={tip} />, document.body);
}

function TitleTooltipBubble({ tip }: { tip: TipState }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { anchor, pointer } = tip;
    const anchored =
      anchor.width <= MAX_ANCHORED_WIDTH && anchor.height <= MAX_ANCHORED_HEIGHT;

    let left = anchored ? anchor.left + anchor.width / 2 - width / 2 : pointer.x;
    let top = anchored ? anchor.bottom + GAP : pointer.y + POINTER_OFFSET;
    if (top + height > vh - VIEWPORT_MARGIN) {
      top = (anchored ? anchor.top : pointer.y) - GAP - height;
    }
    left = Math.min(Math.max(left, VIEWPORT_MARGIN), vw - VIEWPORT_MARGIN - width);
    top = Math.max(top, VIEWPORT_MARGIN);
    setPosition({ left, top });
  }, [tip]);

  return (
    <div
      ref={ref}
      role="tooltip"
      data-testid="title-tooltip"
      style={{
        position: 'fixed',
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? 'visible' : 'hidden',
      }}
      className={cn(
        'pointer-events-none z-[1000] max-w-xs whitespace-pre-line break-words rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md',
        position && 'animate-in fade-in-0 zoom-in-95'
      )}
    >
      {tip.text}
    </div>
  );
}

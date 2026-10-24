import { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

function cssColor(name: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return `hsl(${raw})`;
}

/** xterm theme built from the app's CSS variables, so it follows light/dark. */
function buildTheme(): ITheme {
  const background = cssColor('--background');
  const foreground = cssColor('--foreground');
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: cssColor('--accent'),
    red: cssColor('--destructive'),
    green: cssColor('--success'),
    yellow: cssColor('--warning'),
    blue: cssColor('--info'),
    brightRed: cssColor('--destructive'),
    brightGreen: cssColor('--success'),
    brightYellow: cssColor('--warning'),
    brightBlue: cssColor('--info'),
  };
}

/**
 * One xterm.js terminal mounted in `ref`, fitted to its box and refitted when
 * the box changes size. `onResize` hears each fit's cols × rows, so a caller
 * can tell the PTY on the other end.
 */
export function useXterm(opts: { readOnly?: boolean; onResize?: (cols: number, rows: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [term, setTerm] = useState<Terminal | null>(null);
  const onResizeRef = useRef(opts.onResize);
  onResizeRef.current = opts.onResize;

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const t = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      cursorBlink: !opts.readOnly,
      disableStdin: Boolean(opts.readOnly),
      convertEol: Boolean(opts.readOnly),
      scrollback: 5000,
      theme: buildTheme(),
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(el);
    const doFit = () => {
      try {
        fit.fit();
        onResizeRef.current?.(t.cols, t.rows);
      } catch {
        // Not laid out yet (a hidden tab); the next resize fits it.
      }
    };
    doFit();
    const observer = new ResizeObserver(() => doFit());
    observer.observe(el);
    const themeObserver = new MutationObserver(() => {
      t.options.theme = buildTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    setTerm(t);
    return () => {
      observer.disconnect();
      themeObserver.disconnect();
      t.dispose();
      setTerm(null);
    };
  }, [opts.readOnly]);

  return { ref, term };
}

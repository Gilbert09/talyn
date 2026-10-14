import { useEffect, useRef, useState } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

function cssColor(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw ? `hsl(${raw})` : fallback;
}

/** xterm theme built from the app's CSS variables, so it follows light/dark. */
function buildTheme(): ITheme {
  const dark = document.documentElement.classList.contains('dark');
  const background = cssColor('--background', dark ? '#1f1d1a' : '#fcfbf8');
  const foreground = cssColor('--foreground', dark ? '#f5f3ee' : '#23201b');
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: cssColor('--accent', dark ? '#3a3631' : '#e6dfd1'),
    red: cssColor('--destructive', '#dc2626'),
    green: cssColor('--success', '#16a34a'),
    yellow: cssColor('--warning', '#ca8a04'),
    blue: cssColor('--info', '#2563eb'),
    brightRed: cssColor('--destructive', '#dc2626'),
    brightGreen: cssColor('--success', '#16a34a'),
    brightYellow: cssColor('--warning', '#ca8a04'),
    brightBlue: cssColor('--info', '#2563eb'),
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
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
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

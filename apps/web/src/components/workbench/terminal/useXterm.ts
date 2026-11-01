import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { CONSOLE_FONT_FAMILY, CONSOLE_FONT_SIZE, CONSOLE_THEME } from './consoleTheme';

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
      fontFamily: CONSOLE_FONT_FAMILY,
      fontSize: CONSOLE_FONT_SIZE,
      cursorBlink: !opts.readOnly,
      disableStdin: Boolean(opts.readOnly),
      convertEol: Boolean(opts.readOnly),
      scrollback: 5000,
      theme: CONSOLE_THEME,
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
    setTerm(t);
    return () => {
      observer.disconnect();
      t.dispose();
      setTerm(null);
    };
  }, [opts.readOnly]);

  return { ref, term };
}

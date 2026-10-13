import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const THEME = {
  background: '#151517',
  foreground: '#e4e4e7',
  cursor: '#e4e4e7',
  selectionBackground: '#3f3f46',
};

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
      theme: THEME,
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

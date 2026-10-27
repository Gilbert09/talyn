import { useEffect, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { Workbench } from '@talyn/shared';
import { api } from '../../../lib/api';
import { useXterm } from './useXterm';

/** Reconnect delays for the sandbox terminal socket, in ms. The last one repeats. */
export const TERMINAL_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

/** Close codes after which a retry cannot help. */
const FATAL_CLOSE_CODES = new Set([4401, 4403, 4404]);

/** The sandbox terminal uses first-frame authentication and binary input frames. */
export function ShellTerminal({ workbench, active }: { workbench: Workbench; active: boolean }) {
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeSink = useRef<((cols: number, rows: number) => void) | null>(null);
  const { ref, term } = useXterm({
    onResize: (cols, rows) => {
      sizeRef.current = { cols, rows };
      resizeSink.current?.(cols, rows);
    },
  });

  useEffect(() => {
    if (!term) return undefined;
    return connectSandbox(term, workbench.id, sizeRef, resizeSink);
  }, [term, workbench.id]);

  useEffect(() => {
    if (active) term?.focus();
  }, [active, term]);

  return <div ref={ref} className="h-full w-full px-2 py-1" />;
}

type SizeRef = { current: { cols: number; rows: number } | null };
type SinkRef = { current: ((cols: number, rows: number) => void) | null };

export function connectSandbox(term: Terminal, workbenchId: string, sizeRef: SizeRef, sinkRef: SinkRef): () => void {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let timer: number | null = null;
  let disposed = false;
  const encoder = new TextEncoder();

  const sendResize = (cols: number, rows: number) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  };
  sinkRef.current = sendResize;
  const input = term.onData((data) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
  });

  const connect = async () => {
    if (disposed) return;
    const auth = await api.workbenches.terminalAuthFrame();
    if (disposed) return;
    if (!auth) {
      term.writeln('\r\n\x1b[33m[signed out — sign in again to use the terminal]\x1b[0m');
      return;
    }
    const socket = new WebSocket(`${api.workbenches.terminalUrl(workbenchId)}?session=main`);
    socket.binaryType = 'arraybuffer';
    ws = socket;
    socket.onopen = () => {
      socket.send(auth);
      if (sizeRef.current) sendResize(sizeRef.current.cols, sizeRef.current.rows);
    };
    let firstOutput = true;
    socket.onmessage = (e) => {
      attempt = 0;
      if (firstOutput) { term.reset(); firstOutput = false; }
      if (typeof e.data === 'string') term.write(e.data);
      else term.write(new Uint8Array(e.data as ArrayBuffer));
    };
    socket.onclose = (e) => {
      if (disposed || ws !== socket) return;
      ws = null;
      if (FATAL_CLOSE_CODES.has(e.code) || (e.code === 1008 && e.reason === 'not_ready')) {
        term.writeln(`\r\n\x1b[31m[terminal closed: ${e.reason || `code ${e.code}`}]\x1b[0m`);
        return;
      }
      const delay = TERMINAL_BACKOFF_MS[Math.min(attempt, TERMINAL_BACKOFF_MS.length - 1)];
      attempt += 1;
      timer = window.setTimeout(() => void connect(), delay);
    };
  };
  void connect();

  return () => {
    disposed = true;
    sinkRef.current = null;
    input.dispose();
    if (timer !== null) window.clearTimeout(timer);
    ws?.close();
  };
}

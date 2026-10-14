import { randomUUID } from 'crypto';
import type * as Pty from 'node-pty';
import { loginShell, processEnv, shellArgs } from './environment';
import { stopGroup, type Emit } from './processes';

const SCROLLBACK_BYTES = 256 * 1024;
export type TerminalKind = 'terminal' | 'agent' | 'setup' | 'run' | 'archive';
interface Terminal {
  id: string;
  key: string;
  workbenchId: string;
  pty: Pty.IPty;
  buffer: Buffer;
  exited: boolean;
  exitCode?: number;
  stopping?: Promise<void>;
}
interface OpenInput {
  workbenchId: string;
  path: string;
  kind: TerminalKind;
  name?: string;
  command?: string;
  env?: Record<string, string>;
  onData?: (data: string) => void;
  onExit?: (exitCode: number) => void;
}

export class Terminals {
  private readonly terminals = new Map<string, Terminal>();
  private readonly opening = new Map<string, Promise<string>>();
  private closing = false;

  constructor(private readonly emit: Emit) {}

  async open(input: OpenInput): Promise<string> {
    if (this.closing) throw new Error('The runtime is shutting down');
    const key = JSON.stringify([
      input.workbenchId,
      input.kind,
      input.name ?? '',
    ]);
    const pending = this.opening.get(key);
    if (pending) return pending;
    const existing = [...this.terminals.values()].find(
      (terminal) => terminal.key === key && !terminal.exited,
    );
    if (existing) {
      setTimeout(
        () =>
          this.emit('workbench:terminal-data', {
            terminalId: existing.id,
            data: existing.buffer.toString('utf8'),
          }),
        0,
      );
      return existing.id;
    }
    const opening = this.create(input, key);
    this.opening.set(key, opening);
    try {
      return await opening;
    } finally {
      this.opening.delete(key);
    }
  }

  private async create(input: OpenInput, key: string): Promise<string> {
    const env = await processEnv(input.env);
    if (this.closing) throw new Error('The runtime is shutting down');
    const native = require('node-pty') as typeof Pty;
    const pty = native.spawn(
      loginShell(),
      shellArgs(input.command),
      {
        name: 'xterm-256color',
        cols: 100,
        rows: 30,
        cwd: input.path,
        env: Object.fromEntries(
          Object.entries(env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      },
    );
    const id = randomUUID();
    const terminal: Terminal = {
      id,
      key,
      workbenchId: input.workbenchId,
      pty,
      buffer: Buffer.alloc(0),
      exited: false,
    };
    this.terminals.set(id, terminal);
    pty.onData((data) => {
      const combined = Buffer.concat([terminal.buffer, Buffer.from(data)]);
      terminal.buffer = Buffer.from(
        combined.subarray(Math.max(0, combined.length - SCROLLBACK_BYTES)),
      );
      this.emit('workbench:terminal-data', { terminalId: id, data });
      input.onData?.(data);
    });
    pty.onExit(({ exitCode }) => {
      terminal.exited = true;
      terminal.exitCode = exitCode;
      this.emit('workbench:terminal-data', { terminalId: id, exitCode });
      input.onExit?.(exitCode);
      if (!terminal.stopping) this.terminals.delete(id);
    });
    return id;
  }

  write(id: string, data: string): void {
    const terminal = this.terminals.get(id);
    if (terminal && !terminal.exited) terminal.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 1 ||
      rows < 1 ||
      cols > 1000 ||
      rows > 1000
    )
      throw new Error('Invalid terminal size');
    const terminal = this.terminals.get(id);
    if (terminal && !terminal.exited) terminal.pty.resize(cols, rows);
  }

  async close(id: string): Promise<void> {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    terminal.stopping ??= stopGroup(terminal.pty.pid).finally(() => {
      try {
        terminal.pty.kill('SIGKILL');
      } catch {
        /* The terminal has already exited. */
      }
      this.terminals.delete(id);
    });
    await terminal.stopping;
  }

  async stopWorkbench(workbenchId: string): Promise<void> {
    await Promise.all(
      [...this.opening.values()].map((pending) =>
        pending.catch(() => undefined),
      ),
    );
    await Promise.all(
      [...this.terminals.values()]
        .filter((terminal) => terminal.workbenchId === workbenchId)
        .map((terminal) => this.close(terminal.id)),
    );
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.opening.values()]);
    await Promise.all([...this.terminals.keys()].map((id) => this.close(id)));
  }
}

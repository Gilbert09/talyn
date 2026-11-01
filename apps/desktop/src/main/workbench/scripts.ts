import net from 'net';
import path from 'path';
import {
  WORKBENCH_PORT_COUNT,
  workbenchEnv,
  type WorkbenchLocalBridge,
} from '@talyn/shared';
import { readConfig } from './config';
import { WorkbenchPaths } from './paths';
import { Terminals, type TerminalKind } from './terminals';
import type { Emit } from './processes';

/** True when nothing listens on `port` at 127.0.0.1: a quick listen, then close. */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

export const FIRST_SESSION_PORT = 55100;

/**
 * `TALYN_PORT` for each session: the first of {@link WORKBENCH_PORT_COUNT}
 * consecutive ports that are free on this computer and that no other session
 * holds. A session keeps its block until it is archived or the app quits.
 */
export class PortAllocator {
  private readonly ports = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly isFree: (port: number) => Promise<boolean> = portIsFree,
    private readonly first = FIRST_SESSION_PORT,
  ) {}

  allocate(workbenchId: string): Promise<number> {
    // One search at a time, so two sessions cannot both take a block.
    const pending = this.queue.then(() => this.find(workbenchId));
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async find(workbenchId: string): Promise<number> {
    const existing = this.ports.get(workbenchId);
    if (existing !== undefined) return existing;
    const held = [...this.ports.values()];
    let start = this.first;
    while (start + WORKBENCH_PORT_COUNT - 1 <= 65535) {
      const overlap = held.find(
        (port) => port < start + WORKBENCH_PORT_COUNT && start < port + WORKBENCH_PORT_COUNT,
      );
      if (overlap !== undefined) {
        start = overlap + WORKBENCH_PORT_COUNT;
        continue;
      }
      const busy = await this.firstBusy(start);
      if (busy === null) {
        this.ports.set(workbenchId, start);
        return start;
      }
      start = busy + 1;
    }
    throw new Error(
      `No ${WORKBENCH_PORT_COUNT} free ports in a row from ${this.first}. Stop some local servers, then try again.`,
    );
  }

  private async firstBusy(start: number): Promise<number | null> {
    for (let port = start; port < start + WORKBENCH_PORT_COUNT; port++) {
      if (!(await this.isFree(port))) return port;
    }
    return null;
  }

  release(workbenchId: string): void {
    this.ports.delete(workbenchId);
  }
}

export class Scripts {
  private readonly running = new Map<
    string,
    { workbenchId: string; name: string; kind: TerminalKind; id: string }
  >();
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;

  constructor(
    private readonly paths: WorkbenchPaths,
    private readonly terminals: Terminals,
    private readonly emit: Emit,
    readonly ports = new PortAllocator(),
  ) {}

  run(
    input: Parameters<WorkbenchLocalBridge['scripts']['run']>[0],
  ): Promise<void> {
    const pending = this.queue.then(() => this.start(input));
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  private async start(
    input: Parameters<WorkbenchLocalBridge['scripts']['run']>[0],
  ): Promise<void> {
    if (this.closing) throw new Error('The runtime is shutting down');
    const config = await readConfig(input.path);
    const kind =
      input.name === 'setup' || input.name === 'archive' ? input.name : 'run';
    const command = input.command.trim()
      ? input.command
      : kind === 'run'
        ? (config.run.find((script) => script.name === input.name)?.command ??
          config.run.find((script) => script.default)?.command)
        : config[kind]?.command;
    if (!command) throw new Error(`No ${input.name} script is configured`);
    if (kind === 'run' && config.runMode === 'nonconcurrent') {
      await Promise.all(
        [...this.running.values()]
          .filter((script) => script.kind === 'run')
          .map((script) => this.stopNow(script)),
      );
    }
    await this.stopNow(input);
    const state = await this.paths.load(input.path);
    const env = {
      ...input.env,
      ...workbenchEnv({
        workbenchPath: input.path,
        rootPath: state?.rootPath ?? input.path,
        name: state?.name ?? path.basename(input.path),
        defaultBranch: state?.baseBranch,
        port: await this.ports.allocate(input.workbenchId),
      }),
    };
    const key = this.key(input);
    const id = await this.terminals.open({
      ...input,
      kind,
      command,
      env,
      onData: (data) =>
        this.emit('workbench:script-frame', {
          workbenchId: input.workbenchId,
          name: input.name,
          stream: 'stdout',
          data,
        }),
      onExit: (exitCode) => {
        this.running.delete(key);
        this.emit('workbench:script-frame', {
          workbenchId: input.workbenchId,
          name: input.name,
          stream: 'exit',
          exitCode,
        });
      },
    });
    this.running.set(key, {
      workbenchId: input.workbenchId,
      name: input.name,
      kind,
      id,
    });
  }

  private key(input: { workbenchId: string; name: string }): string {
    return JSON.stringify([input.workbenchId, input.name]);
  }

  private async stopNow(input: {
    workbenchId: string;
    name: string;
  }): Promise<void> {
    const key = this.key(input);
    const running = this.running.get(key);
    if (!running) return;
    await this.terminals.close(running.id);
    this.running.delete(key);
  }

  stop(input: { workbenchId: string; name: string }): Promise<void> {
    const pending = this.queue.then(() => this.stopNow(input));
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  async stopWorkbench(workbenchId: string): Promise<void> {
    await this.queue;
    await Promise.all(
      [...this.running.values()]
        .filter((script) => script.workbenchId === workbenchId)
        .map((script) => this.stopNow(script)),
    );
    this.ports.release(workbenchId);
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    await this.queue;
    await Promise.all(
      [...this.running.values()].map((script) => this.stopNow(script)),
    );
  }
}

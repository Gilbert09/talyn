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

export class PortAllocator {
  private readonly ports = new Map<string, number>();

  allocate(workbenchId: string): number {
    const existing = this.ports.get(workbenchId);
    if (existing !== undefined) return existing;
    const used = new Set(this.ports.values());
    for (
      let port = 55100;
      port + WORKBENCH_PORT_COUNT - 1 <= 65535;
      port += WORKBENCH_PORT_COUNT
    ) {
      if (!used.has(port)) {
        this.ports.set(workbenchId, port);
        return port;
      }
    }
    throw new Error('No workbench port range is available');
  }

  release(workbenchId: string): void {
    this.ports.delete(workbenchId);
  }
}

export class Scripts {
  readonly ports = new PortAllocator();
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
        port: this.ports.allocate(input.workbenchId),
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

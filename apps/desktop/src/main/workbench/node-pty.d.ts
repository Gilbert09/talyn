/**
 * The part of node-pty this app uses. node-pty is a native module, so it lives
 * in release/app/package.json, and CI's typecheck never installs it there. An
 * import of its own typings from that folder passed on a developer machine and
 * failed every CI run.
 */
declare module 'node-pty' {
  export interface IPtyForkOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: { [key: string]: string };
  }

  export interface IDisposable {
    dispose(): void;
  }

  export interface IPty {
    readonly pid: number;
    readonly cols: number;
    readonly rows: number;
    onData(listener: (data: string) => void): IDisposable;
    onExit(listener: (event: { exitCode: number; signal?: number }) => void): IDisposable;
    write(data: string): void;
    resize(columns: number, rows: number): void;
    kill(signal?: string): void;
  }

  export function spawn(file: string, args: string[] | string, options: IPtyForkOptions): IPty;
}

import { execFile, spawn, type ChildProcess } from 'child_process';
import net from 'net';
import type { CoderStatus, CoderWorkspace } from '../../workbenchBridgeTypes';
import { loginPath } from './environment';

export interface CoderResult { code: number; stdout: string; stderr: string }
export interface CoderApp { slug: string; url: string; port?: number }

export function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('The command contains a null character.');
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function workspaceName(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value) || value.startsWith('-') || /^\.+$/.test(value)) {
    throw new Error('Invalid Coder workspace name. Set the workspace in Settings.');
  }
  return value;
}

export function remotePath(value: string): string {
  if (typeof value !== 'string' || !value || /['"\r\n\0]/.test(value) || !(value.startsWith('/') || value.startsWith('~/')) || value.split('/').includes('..')) {
    throw new Error('Use an absolute path or ~/path without quotes or newlines in Settings.');
  }
  return value.startsWith('~/') ? `"$HOME"/${shellQuote(value.slice(2))}` : shellQuote(value);
}

export function coderOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Set a valid Coder URL in Settings.');
  return url.origin;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';

export function parseWorkspaces(text: string): CoderWorkspace[] {
  const data: unknown = JSON.parse(text);
  const rows = Array.isArray(data) ? data : record(data).workspaces;
  if (!Array.isArray(rows)) throw new Error('Could not read Coder workspaces. Run: coder list --output json');
  return rows.map((row) => {
    const item = record(row);
    return {
      name: workspaceName(string(item.name)),
      owner: string(item.owner_name ?? item.owner),
      status: string(record(item.latest_build).status ?? item.status).toLowerCase(),
      template: string(item.template_name ?? item.template),
    };
  });
}

export function parseAppUrls(text: string): CoderApp[] {
  const apps: CoderApp[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const item = record(value);
    if (item.subdomain === true && typeof item.slug === 'string') {
      // Internal URLs alone do not identify the public app address.
      const address = string(item.external_url ?? item.public_url ?? item.url);
      try {
        const url = new URL(address);
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
          url.hostname !== 'localhost' && !net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && url.hostname.includes('.')) {
          let port: number | undefined;
          try { port = Number(new URL(string(item.internal_url ?? item.url)).port) || undefined; } catch { /* No internal URL. */ }
          apps.push({ slug: item.slug, url: url.href, port });
        }
      } catch { /* Unsupported app URLs use the port forward. */ }
    }
    Object.values(item).forEach((child) => { if (child && typeof child === 'object') visit(child); });
  };
  visit(JSON.parse(text));
  return apps;
}

export class CoderCli {
  private forwards = new Map<string, { child: ChildProcess; ready: Promise<string> }>();

  constructor(
    private execute: typeof execFile = execFile,
    private launch: typeof spawn = spawn,
    private getPath: () => Promise<string> = loginPath,
    private pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  private async call(args: string[], input?: string, timeout = 60_000): Promise<CoderResult> {
    const env = { ...process.env, PATH: await this.getPath(), NO_COLOR: '1' };
    return new Promise((resolve, reject) => {
      const child = this.execute('coder', args, { env, timeout, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') { reject(error); return; }
        resolve({ code: error?.code as number ?? 0, stdout, stderr });
      });
      child.stdin?.on('error', () => { /* The command result reports a closed input pipe. */ });
      child.stdin?.end(input);
    });
  }

  async status(expectedUrl?: string): Promise<CoderStatus> {
    const expected = expectedUrl ? coderOrigin(expectedUrl) : undefined;
    try {
      let result = await this.call(['whoami', '--output', 'json']);
      let url: string | undefined;
      let user: string | undefined;
      if (result.code && /unknown flag|unknown option|unrecognized|unsupported/i.test(result.stderr)) {
        result = await this.call(['whoami']);
        url = result.stdout.match(/https?:\/\/[^\s,]+/)?.[0];
        user = result.stdout.match(/authenticated as\s+([^\s!]+)/i)?.[1];
      } else if (!result.code) {
        const data: unknown = JSON.parse(result.stdout);
        const row = record(Array.isArray(data) ? data[0] : data);
        url = string(row.url) || undefined;
        user = string(row.username ?? record(row.user).username ?? row.user) || undefined;
      }
      return { installed: true, loggedIn: !result.code && Boolean(url && user) && (!expected || coderOrigin(url!) === expected), url, user };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { installed: false, loggedIn: false };
      throw error;
    }
  }

  async workspaces(timeout = 60_000): Promise<CoderWorkspace[]> {
    const result = await this.call(['list', '--output', 'json'], undefined, timeout);
    if (result.code) throw new Error(`Run: coder list --output json\n${result.stderr}`);
    try { return parseWorkspaces(result.stdout); }
    catch { throw new Error('Could not read Coder workspaces. Run: coder list --output json'); }
  }

  async start(workspace: string): Promise<void> {
    workspaceName(workspace);
    const deadline = Date.now() + 600_000;
    const result = await this.call(['start', '--yes', workspace], undefined, 600_000);
    if (result.code) throw new Error(`Run: coder start --yes ${workspace}\n${result.stderr}`);
    while (Date.now() < deadline) {
      const current = (await this.workspaces(Math.max(1, Math.min(60_000, deadline - Date.now())))).find((item) => item.name === workspace);
      if (current?.status === 'running') return;
      if (current?.status === 'failed') break;
      await this.pause(Math.min(5000, Math.max(0, deadline - Date.now())));
    }
    throw new Error(`The workspace did not start. Run: coder start --yes ${workspace}`);
  }

  exec(workspace: string, script: string, options: { input?: string } = {}): Promise<CoderResult> {
    // Coder joins command arguments before it sends them to the remote shell.
    return this.call(['ssh', workspaceName(workspace), '--', 'bash', '-lc', shellQuote(script)], options.input, 120_000);
  }

  async appUrls(workspace: string): Promise<CoderApp[]> {
    workspaceName(workspace);
    try {
      const result = await this.call(['show', workspace, '--output', 'json']);
      return result.code ? [] : parseAppUrls(result.stdout);
    } catch { return []; }
  }

  async portForward(workspace: string, port: number): Promise<string> {
    workspaceName(workspace);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Set a preview port from 1024 to 65535.');
    const key = `${workspace}:${port}`;
    const existing = this.forwards.get(key);
    if (existing) return existing.ready;
    const env = { ...process.env, PATH: await this.getPath(), NO_COLOR: '1' };
    await new Promise<void>((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', () => reject(new Error(`Local port ${port} is in use. Stop its process, then select Open.`)));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
    });
    const child = this.launch('coder', ['port-forward', workspace, '--tcp', `${port}:${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const ready = new Promise<string>((resolve, reject) => {
      let output = '';
      let closed = false;
      let probeSocket: net.Socket | undefined;
      let readyTimer: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        closed = true;
        clearTimeout(readyTimer);
        probeSocket?.destroy();
        child.kill();
        if (this.forwards.get(key)?.child === child) this.forwards.delete(key);
        reject(new Error(`The port forward timed out. Run: coder port-forward ${workspace} --tcp ${port}:${port}`));
      }, 60_000);
      const probe = () => {
        if (closed) return;
        const socket = net.connect({ host: '127.0.0.1', port });
        probeSocket = socket;
        socket.setTimeout(500);
        socket.once('connect', () => {
          socket.destroy();
          clearTimeout(timer);
          resolve(`http://localhost:${port}`);
        });
        socket.once('timeout', () => socket.destroy(new Error('Connection timed out.')));
        socket.once('error', () => { if (!closed) readyTimer = setTimeout(probe, 100); });
      };
      const onData = (data: Buffer) => {
        output = (output + data.toString()).slice(-8192);
        if (!readyTimer && /Forwarding|Listening/i.test(output)) readyTimer = setTimeout(probe, 100);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.once('error', (error) => {
        closed = true;
        clearTimeout(timer);
        clearTimeout(readyTimer);
        probeSocket?.destroy();
        if (this.forwards.get(key)?.child === child) this.forwards.delete(key);
        reject(error);
      });
      child.once('close', () => {
        closed = true;
        probeSocket?.destroy();
        clearTimeout(timer);
        clearTimeout(readyTimer);
        if (this.forwards.get(key)?.child === child) this.forwards.delete(key);
        reject(new Error(`The port forward stopped. Run: coder port-forward ${workspace} --tcp ${port}:${port}\n${output}`));
      });
    });
    this.forwards.set(key, { child, ready });
    return ready;
  }

  stopForwards(workspace?: string): void {
    for (const [key, forward] of this.forwards) {
      if (!workspace || key.startsWith(`${workspace}:`)) {
        forward.child.kill();
        this.forwards.delete(key);
      }
    }
  }
}

import { execFile, spawn, type ChildProcess } from 'child_process';
import net from 'net';
import os from 'os';
import path from 'path';
import type { CoderStatus, CoderWorkspace } from '../../workbenchBridgeTypes';
import { locate, loginPath } from './environment';

export interface CoderResult { code: number; stdout: string; stderr: string }
export interface CoderApp { slug: string; url: string; port?: number }

/**
 * Folders to search before the login PATH. `hogli devbox:setup` installs its
 * own CLI in ~/.hogli/bin and does not put it on PATH, and hogli prefers it.
 */
export function coderSearchDirs(home = os.homedir(), platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? [] : [path.posix.join(home, '.hogli', 'bin')];
}
export const CODER_SEARCH_TEXT = '~/.hogli/bin, /opt/homebrew/bin, /usr/local/bin, ~/.local/bin and your shell PATH';

// Go's net/http and the Coder SDK wording for a deployment that does not answer.
const NETWORK_ERROR = /dial tcp|no such host|connection refused|connection reset|i\/o timeout|context deadline exceeded|network is unreachable|no route to host|TLS handshake timeout|server misbehaving|Client\.Timeout|did not finish in/i;
const AUTH_ERROR = /not logged in|log ?in|unauthori[sz]ed|\b401\b|session token|expired|invalid token/i;

/** Tells a network failure from a sign-in failure in the CLI's output. */
export function classifyCoderFailure(output: string): 'unreachable' | 'not_logged_in' | 'error' {
  if (NETWORK_ERROR.test(output)) return 'unreachable';
  if (AUTH_ERROR.test(output)) return 'not_logged_in';
  return 'error';
}

/** A `coder` command that could not run, or that did not finish in time. */
export class CoderCommandError extends Error {
  constructor(message: string, readonly code: string, readonly stderr = '') { super(message); }
}

// A deployment that answers replies to whoami in a second or two. 30 s allows a
// slow tailnet path and still tells the person about a dead one quickly.
const STATUS_TIMEOUT_MS = 30_000;

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
    private find: () => Promise<string | null> = () => locate('coder', coderSearchDirs()),
  ) {}

  /** The absolute path of the CLI. An app opened from Finder has no shell PATH. */
  private async binary(): Promise<string> {
    const found = await this.find();
    if (!found) throw new CoderCommandError(`Talyn could not find the coder CLI. It looked in ${CODER_SEARCH_TEXT}.`, 'ENOENT');
    return found;
  }

  private async call(args: string[], input?: string, timeout = 60_000, sessionToken?: string): Promise<CoderResult> {
    const [file, PATH] = await Promise.all([this.binary(), this.getPath()]);
    const env = { ...process.env, PATH, NO_COLOR: '1', ...(sessionToken === undefined ? {} : { CODER_SESSION_TOKEN: sessionToken }) };
    const command = `coder ${args.slice(0, 2).join(' ')}`;
    return new Promise((resolve, reject) => {
      const child = this.execute(file, args, { env, timeout, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
          const output = String(stderr ?? '').trim();
          if (failure.killed || failure.signal) {
            reject(new CoderCommandError(`${command} did not finish in ${Math.round(timeout / 1000)} seconds.${output ? `\n${output}` : ''}`, 'ETIMEDOUT', output));
          } else if (failure.code === 'ENOENT') {
            reject(new CoderCommandError(`Talyn could not run ${file}. Install the Coder CLI again.`, 'ENOENT', output));
          } else {
            reject(new CoderCommandError(`Could not run ${command}: ${failure.message}${output ? `\n${output}` : ''}`, String(failure.code ?? 'ERROR'), output));
          }
          return;
        }
        resolve({ code: error?.code as number ?? 0, stdout, stderr });
      });
      child.stdin?.on('error', () => { /* The command result reports a closed input pipe. */ });
      child.stdin?.end(input);
    });
  }

  async login(url: string, token: string): Promise<void> {
    const origin = coderOrigin(url);
    if (typeof token !== 'string' || !token.trim() || /[\r\n\0]/.test(token.trim())) throw new Error('Paste a valid Coder session token.');
    const sessionToken = token.trim();
    const redact = (output: string) => output.split(sessionToken).join('[redacted]');
    try {
      // Coder reads CODER_SESSION_TOKEN for login. The token stays out of argv and CLI output returned to the renderer.
      const result = await this.call(['login', origin], undefined, 30_000, sessionToken);
      if (result.code) throw new Error(`coder login failed (${result.code}): ${redact((result.stderr || result.stdout).trim())}`);
    } catch (error) {
      throw new Error(redact(error instanceof Error ? error.message : String(error)));
    }
  }

  async status(expectedUrl?: string): Promise<CoderStatus> {
    const expected = expectedUrl ? coderOrigin(expectedUrl) : undefined;
    const binary = await this.find();
    if (!binary) return { installed: false, loggedIn: false, problem: 'not_installed' };
    try {
      let result = await this.call(['whoami', '--output', 'json'], undefined, STATUS_TIMEOUT_MS);
      let url: string | undefined;
      let user: string | undefined;
      if (result.code && /unknown flag|unknown option|unrecognized|unsupported/i.test(result.stderr)) {
        result = await this.call(['whoami'], undefined, STATUS_TIMEOUT_MS);
        url = result.stdout.match(/https?:\/\/[^\s,]+/)?.[0];
        user = result.stdout.match(/authenticated as\s+([^\s!]+)/i)?.[1];
      } else if (!result.code) {
        try {
          const data: unknown = JSON.parse(result.stdout);
          const row = record(Array.isArray(data) ? data[0] : data);
          url = string(row.url) || undefined;
          user = string(row.username ?? record(row.user).username ?? row.user) || undefined;
        } catch {
          return { installed: true, loggedIn: false, binary, problem: 'error', detail: `Could not read the output of coder whoami:\n${result.stdout.slice(0, 2000)}` };
        }
      }
      if (result.code) {
        const detail = `${result.stderr}\n${result.stdout}`.trim();
        // An unknown whoami failure is most often a sign-in problem. The detail shows the rest.
        const problem = classifyCoderFailure(detail) === 'unreachable' ? 'unreachable' : 'not_logged_in';
        return { installed: true, loggedIn: false, binary, url, user, problem, detail: detail || undefined };
      }
      if (!url || !user) return { installed: true, loggedIn: false, binary, url, user, problem: 'not_logged_in' };
      if (expected && coderOrigin(url) !== expected) return { installed: true, loggedIn: false, binary, url, user, problem: 'wrong_deployment' };
      return { installed: true, loggedIn: true, binary, url, user };
    } catch (error) {
      if (error instanceof CoderCommandError && error.code === 'ENOENT') return { installed: false, loggedIn: false, problem: 'not_installed', detail: error.message };
      const detail = error instanceof Error ? error.message : String(error);
      const unreachable = (error instanceof CoderCommandError && error.code === 'ETIMEDOUT') || classifyCoderFailure(detail) === 'unreachable';
      return { installed: true, loggedIn: false, binary, problem: unreachable ? 'unreachable' : 'error', detail };
    }
  }

  async workspaces(timeout = 60_000): Promise<CoderWorkspace[]> {
    const result = await this.call(['list', '--output', 'json'], undefined, timeout);
    if (result.code) throw new Error(`coder list failed. Run: coder list --output json\n${(result.stderr || result.stdout).trim()}`);
    try { return parseWorkspaces(result.stdout); }
    catch { throw new Error('Could not read Coder workspaces. Run: coder list --output json'); }
  }

  /** Starts a workspace and waits until it runs. `onStatus` gets each status it reports. */
  async start(workspace: string, onStatus: (status: string) => void = () => undefined): Promise<void> {
    workspaceName(workspace);
    const deadline = Date.now() + 600_000;
    onStatus('starting');
    const result = await this.call(['start', '--yes', workspace], undefined, 600_000);
    if (result.code) throw new Error(`coder start failed. Run: coder start --yes ${workspace}\n${(result.stderr || result.stdout).trim()}`);
    await this.waitUntilRunning(workspace, deadline, onStatus);
  }

  /** Polls `coder list` until the workspace runs, stops, or the deadline passes. */
  async waitUntilRunning(workspace: string, deadline: number, onStatus: (status: string) => void = () => undefined): Promise<void> {
    let last = 'unknown';
    while (Date.now() < deadline) {
      const current = (await this.workspaces(Math.max(1, Math.min(60_000, deadline - Date.now())))).find((item) => item.name === workspace);
      last = current?.status ?? 'missing';
      onStatus(last);
      if (last === 'running') return;
      // Not 'stopped': the list can show it for a moment after `coder start` returns.
      if (['failed', 'canceled', 'deleted', 'missing'].includes(last)) break;
      await this.pause(Math.min(5000, Math.max(0, deadline - Date.now())));
    }
    throw new Error(`The workspace did not start (status: ${last}). Run: coder start --yes ${workspace}`);
  }

  exec(workspace: string, script: string, options: { input?: string; timeout?: number } = {}): Promise<CoderResult> {
    // Coder joins command arguments before it sends them to the remote shell.
    return this.call(['ssh', workspaceName(workspace), '--', 'bash', '-lc', shellQuote(script)], options.input, options.timeout ?? 120_000);
  }

  async appUrls(workspace: string): Promise<CoderApp[]> {
    workspaceName(workspace);
    // A CLI that cannot run or answer is a real error. Output that is not JSON
    // only means an older CLI, and the caller then uses a port forward.
    const result = await this.call(['show', workspace, '--output', 'json']);
    if (result.code) return [];
    try { return parseAppUrls(result.stdout); } catch { return []; }
  }

  async portForward(workspace: string, port: number): Promise<string> {
    workspaceName(workspace);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Set a preview port from 1024 to 65535.');
    const key = `${workspace}:${port}`;
    const existing = this.forwards.get(key);
    if (existing) return existing.ready;
    const [file, PATH] = await Promise.all([this.binary(), this.getPath()]);
    const env = { ...process.env, PATH, NO_COLOR: '1' };
    await new Promise<void>((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', () => reject(new Error(`Local port ${port} is in use. Stop its process, then select Open.`)));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
    });
    const child = this.launch(file, ['port-forward', workspace, '--tcp', `${port}:${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
        reject(new Error(`Could not start the port forward: ${error.message}. Run: coder port-forward ${workspace} --tcp ${port}:${port}`));
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

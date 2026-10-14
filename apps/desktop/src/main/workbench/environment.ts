import { execFile } from 'child_process';
import { constants, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { WorkbenchLocalReadiness } from '@talyn/shared';

export function mergePath(
  shellPath = '',
  inheritedPath = process.env.PATH ?? '',
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const extra =
    platform === 'win32'
      ? [p.join(home, '.local', 'bin')]
      : [
          '/opt/homebrew/bin',
          '/usr/local/bin',
          p.join(home, '.local/bin'),
          p.join(home, '.claude/local'),
          '/usr/bin',
          '/bin',
          '/usr/sbin',
          '/sbin',
        ];
  return [
    ...new Set(
      [
        ...shellPath.split(p.delimiter),
        ...inheritedPath.split(p.delimiter),
        ...extra,
      ].filter(
        (entry) =>
          p.isAbsolute(entry) &&
          !entry.includes('\n') &&
          !entry.includes('\r'),
      ),
    ),
  ].join(p.delimiter);
}

export function loginShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
  return (
    process.env.SHELL ||
    (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  );
}

/** The arguments for `loginShell()`: an interactive shell, or one command. */
export function shellArgs(command?: string): string[] {
  if (process.platform === 'win32')
    return command === undefined ? [] : ['/d', '/s', '/c', command];
  return command === undefined ? ['-l'] : ['-lc', command];
}

let cachedPath: Promise<string> | undefined;

export function loginPath(): Promise<string> {
  // Windows has no login shell to ask; its PATH is already in the environment.
  if (process.platform === 'win32') cachedPath ??= Promise.resolve(mergePath());
  cachedPath ??= new Promise((resolve) => {
    execFile(
      loginShell(),
      ['-ilc', 'echo -n "$PATH"'],
      {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout) => {
        // Shell startup files can print messages before the path.
        const lastLine = error ? '' : stdout.trim().split(/\r?\n/).pop();
        resolve(mergePath(lastLine));
      },
    );
  });
  return cachedPath;
}

export async function processEnv(
  extra: Record<string, string> = {},
): Promise<NodeJS.ProcessEnv> {
  return {
    ...process.env,
    ...extra,
    PATH: mergePath(await loginPath(), extra.PATH ?? process.env.PATH),
  };
}

function executableNames(name: string): string[] {
  if (process.platform !== 'win32') return [name];
  const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean);
  return extensions.map((extension) => name + extension.toLowerCase());
}

async function locate(name: string): Promise<string | null> {
  const directories = (await loginPath()).split(path.delimiter);
  for (const directory of directories) {
    for (const file of executableNames(name)) {
      const candidate = path.join(directory, file);
      try {
        await fs.access(candidate, constants.X_OK);
        if ((await fs.stat(candidate)).isFile()) return candidate;
      } catch {
        /* Try the next candidate. */
      }
    }
  }
  return null;
}

export async function detectAgents(): Promise<{
  claude: string | null;
  codex: string | null;
}> {
  const [claude, codex] = await Promise.all([
    locate('claude'),
    locate('codex'),
  ]);
  return { claude, codex };
}

export function checkPty(): WorkbenchLocalReadiness['pty'] {
  try {
    require('node-pty');
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const READINESS_TTL_MS = 30_000;
let readinessCache: { at: number; value: WorkbenchLocalReadiness } | undefined;

export function resetReadinessCache(): void {
  readinessCache = undefined;
}

export async function localReadiness(
  force = false,
): Promise<WorkbenchLocalReadiness> {
  if (!force && readinessCache && Date.now() - readinessCache.at < READINESS_TTL_MS)
    return readinessCache.value;
  const [agents, gitPath] = await Promise.all([detectAgents(), locate('git')]);
  const found = (p: string | null) => (p ? { ok: true, path: p } : { ok: false });
  const value: WorkbenchLocalReadiness = {
    claude: found(agents.claude),
    codex: found(agents.codex),
    git: found(gitPath),
    pty: checkPty(),
  };
  readinessCache = { at: Date.now(), value };
  return value;
}

import { execFile } from 'child_process';
import { constants, promises as fs } from 'fs';
import os from 'os';
import path from 'path';

export function mergePath(
  shellPath = '',
  inheritedPath = process.env.PATH ?? '',
  home = os.homedir(),
): string {
  return [
    ...new Set(
      [
        ...shellPath.split(path.delimiter),
        ...inheritedPath.split(path.delimiter),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        path.join(home, '.local/bin'),
        path.join(home, '.claude/local'),
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ].filter(
        (entry) =>
          path.isAbsolute(entry) &&
          !entry.includes('\n') &&
          !entry.includes('\r'),
      ),
    ),
  ].join(path.delimiter);
}

export function loginShell(): string {
  return (
    process.env.SHELL ||
    (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  );
}

let cachedPath: Promise<string> | undefined;

export function loginPath(): Promise<string> {
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

export async function detectAgents(): Promise<{
  claude: string | null;
  codex: string | null;
}> {
  const directories = (await loginPath()).split(path.delimiter);
  const locate = async (name: string): Promise<string | null> => {
    for (const directory of directories) {
      const candidate = path.join(directory, name);
      try {
        await fs.access(candidate, constants.X_OK);
        if ((await fs.stat(candidate)).isFile()) return candidate;
      } catch {
        /* Try the next directory. */
      }
    }
    return null;
  };
  const [claude, codex] = await Promise.all([
    locate('claude'),
    locate('codex'),
  ]);
  return { claude, codex };
}

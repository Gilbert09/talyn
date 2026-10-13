import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

export const testEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

export function runGit(
  cwd: string,
  args: string[],
  input?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd, env: testEnv },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolve(stdout.trim());
      },
    );
    child.stdin?.end(input);
  });
}

export async function temporaryRepo(): Promise<{
  directory: string;
  repo: string;
}> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'talyn-workbench-test-'),
  );
  const repo = path.join(directory, 'source');
  await fs.mkdir(repo);
  await runGit(repo, ['init', '--initial-branch=main']);
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'initial\n');
  await fs.writeFile(path.join(repo, '.gitignore'), '.env*\n.context/\n');
  await runGit(repo, ['add', '.']);
  const tree = await runGit(repo, ['write-tree']);
  const commit = await runGit(
    repo,
    ['hash-object', '-t', 'commit', '-w', '--stdin'],
    `tree ${tree}\nauthor Test <test@example.com> 1700000000 +0000\ncommitter Test <test@example.com> 1700000000 +0000\n\nFixture\n`,
  );
  await runGit(repo, ['update-ref', 'refs/heads/main', commit]);
  return { directory, repo };
}

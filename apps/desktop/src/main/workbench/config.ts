import { promises as fs } from 'fs';
import path from 'path';
import { detectWorkbenchScripts, detectedScriptsToToml, resolveWorkbenchConfig } from '@talyn/shared';

const CONFIG_FILES = ['.talyn/settings.toml', 'conductor.json', '.conductor/settings.toml'];

async function detectScripts(worktree: string) {
  const files = await fs.readdir(worktree);
  const packageJson = files.includes('package.json')
    ? await fs.readFile(path.join(worktree, 'package.json'), 'utf8')
    : null;
  return detectWorkbenchScripts({ files, packageJson });
}

export async function readConfigWithDetection(worktree: string) {
  const config = await readConfig(worktree);
  if (config.source === 'none') config.detected = await detectScripts(worktree);
  return config;
}

export async function saveDetectedConfig(worktree: string): Promise<void> {
  const conflict = 'A repository config file already exists. Edit that file to change its scripts.';
  for (const relative of CONFIG_FILES) {
    try {
      await fs.lstat(path.join(worktree, relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(conflict);
  }
  const detected = await detectScripts(worktree);
  if (!detected.setup && !detected.run) throw new Error('No setup or run command was detected.');
  await fs.mkdir(path.join(worktree, '.talyn'), { recursive: true });
  try {
    await fs.writeFile(path.join(worktree, CONFIG_FILES[0]), detectedScriptsToToml(detected), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(conflict);
    throw error;
  }
}

export async function readConfig(worktree: string) {
  const read = async (relative: string): Promise<string | null> => {
    try {
      return await fs.readFile(path.join(worktree, relative), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const [talynToml, conductorJson, conductorToml] = await Promise.all([
    read('.talyn/settings.toml'),
    read('conductor.json'),
    read('.conductor/settings.toml'),
  ]);
  return resolveWorkbenchConfig({ talynToml, conductorJson, conductorToml });
}

import { promises as fs } from 'fs';
import path from 'path';
import { resolveWorkbenchConfig } from '@talyn/shared';

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

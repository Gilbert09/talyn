import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  CLAUDE_USER_INSTRUCTIONS_KEY,
  CODEX_USER_INSTRUCTIONS_KEY,
  claudeLocalKey,
  claudeRuleKey,
  inlineInstructionImports,
  type InstructionImportHost,
  type WorkbenchAgent,
  type WorkbenchInstructionCandidate,
  type WorkbenchInstructionTarget,
} from '@talyn/shared';

/**
 * The Claude and Codex instruction files on this machine, for the "Your
 * instructions" settings. Reads follow symlinks (a dotfiles repo is the usual
 * home of `~/.claude/CLAUDE.md`). Claude files have their `@path` imports
 * inlined, because the sandbox has none of the files they point at.
 */

async function readText(file: string): Promise<string | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return null;
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function importHost(home: string): InstructionImportHost {
  return {
    home,
    read: readText,
    realpath: async (file) => {
      try {
        return await fs.realpath(file);
      } catch {
        return null;
      }
    },
    dirname: path.dirname,
    join: (dir, relative) => path.resolve(dir, relative),
    isAbsolute: path.isAbsolute,
    display: (file) => displayPath(file, home),
  };
}

export function displayPath(file: string, home: string): string {
  const relative = path.relative(home, file);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
    return `~/${relative.split(path.sep).join('/')}`;
  return file;
}

/** Every `*.md` under `dir`, as paths relative to it with `/` separators. Follows symlinked folders once. */
async function markdownFiles(dir: string, seen = new Set<string>()): Promise<string[]> {
  let real: string;
  try {
    real = await fs.realpath(dir);
  } catch {
    return [];
  }
  if (seen.has(real)) return [];
  seen.add(real);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of entries.sort()) {
    const full = path.join(dir, name);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      for (const nested of await markdownFiles(full, seen))
        found.push(`${name}/${nested}`);
    } else if (stat.isFile() && name.endsWith('.md')) {
      found.push(name);
    }
  }
  return found;
}

async function candidate(
  input: {
    key: string;
    agent: WorkbenchAgent;
    target: WorkbenchInstructionTarget;
    repoFullName?: string;
    file: string;
  },
  home: string,
): Promise<WorkbenchInstructionCandidate | null> {
  const raw = await readText(input.file);
  if (raw === null) return null;
  const inlined =
    input.agent === 'claude'
      ? await inlineInstructionImports(raw, input.file, importHost(home))
      : { content: raw, imports: [], missingImports: [] };
  return {
    key: input.key,
    agent: input.agent,
    target: input.target,
    ...(input.repoFullName ? { repoFullName: input.repoFullName } : {}),
    displayPath: displayPath(input.file, home),
    bytes: Buffer.byteLength(inlined.content, 'utf8'),
    content: inlined.content,
    hash: createHash('sha256').update(inlined.content, 'utf8').digest('hex'),
    imports: inlined.imports,
    missingImports: inlined.missingImports,
  };
}

export async function discoverInstructionFiles(
  repoPaths: Record<string, string>,
  home = os.homedir(),
): Promise<WorkbenchInstructionCandidate[]> {
  const rulesDir = path.join(home, '.claude', 'rules');
  const inputs: Array<Parameters<typeof candidate>[0]> = [
    {
      key: CLAUDE_USER_INSTRUCTIONS_KEY,
      agent: 'claude',
      target: 'user',
      file: path.join(home, '.claude', 'CLAUDE.md'),
    },
    ...(await markdownFiles(rulesDir)).map((relative) => ({
      key: claudeRuleKey(relative),
      agent: 'claude' as const,
      target: 'user' as const,
      file: path.join(rulesDir, ...relative.split('/')),
    })),
    {
      key: CODEX_USER_INSTRUCTIONS_KEY,
      agent: 'codex',
      target: 'user',
      file: path.join(home, '.codex', 'AGENTS.md'),
    },
    ...Object.entries(repoPaths)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([repoFullName, root]) => ({
        key: claudeLocalKey(repoFullName),
        agent: 'claude' as const,
        target: 'repo' as const,
        repoFullName,
        file: path.join(root, 'CLAUDE.local.md'),
      })),
  ];
  const found = await Promise.all(inputs.map((input) => candidate(input, home)));
  return found.filter((c): c is WorkbenchInstructionCandidate => c !== null);
}

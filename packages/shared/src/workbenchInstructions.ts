import type { WorkbenchAgent } from './workbench.js';

/**
 * Instruction files from the user's own machine (`~/.claude/CLAUDE.md`,
 * `~/.claude/rules/*.md`, `~/.codex/AGENTS.md`, a repo's `CLAUDE.local.md`),
 * uploaded so a SANDBOX session gets them too. A local session reads the real
 * files and needs none of this.
 *
 * The content is stored only in `workbench_instruction_files`, never in the
 * workspace settings jsonb, and the list route never returns it.
 */

export type WorkbenchInstructionTarget = 'user' | 'repo';

/**
 * One file the desktop found on this machine. `content` is the file with its
 * `@path` imports already inlined, and `hash` is the sha256 (hex) of that.
 */
export interface WorkbenchInstructionCandidate {
  key: string;
  agent: WorkbenchAgent;
  target: WorkbenchInstructionTarget;
  repoFullName?: string;
  /** The path as a person reads it, with `~` for the home directory. */
  displayPath: string;
  bytes: number;
  content: string;
  hash: string;
  /** Display paths of the files inlined into `content`. */
  imports: string[];
  /** Display paths of imports that could not be read. Kept as text. */
  missingImports: string[];
}

/** A stored file, as the list route returns it. No content. */
export interface WorkbenchInstructionFile {
  key: string;
  agent: WorkbenchAgent;
  target: WorkbenchInstructionTarget;
  repoFullName: string | null;
  sourcePath: string;
  bytes: number;
  contentHash: string;
  enabled: boolean;
  updatedAt: string;
}

export interface PutWorkbenchInstructionFileInput {
  workspaceId: string;
  file: {
    key: string;
    agent: WorkbenchAgent;
    target: WorkbenchInstructionTarget;
    repoFullName?: string | null;
    sourcePath: string;
    /** Required when `enabled`. A file switched off keeps its row but not its content. */
    content?: string;
    enabled: boolean;
  };
}

/**
 * Every enabled file loads into the context of every turn. 256 KiB is about
 * 64k tokens, which is already a large part of a turn's context window.
 */
export const MAX_WORKBENCH_INSTRUCTION_BYTES = 256 * 1024;

export function instructionFileTooLargeMessage(bytes: number): string {
  const kb = Math.ceil(bytes / 1024);
  return `Instruction files load into every turn; this one is ${kb} KB. Trim it below 256 KB.`;
}

export const CLAUDE_USER_INSTRUCTIONS_KEY = 'claude-user';
export const CODEX_USER_INSTRUCTIONS_KEY = 'codex-user';
const CLAUDE_RULE_PREFIX = 'claude-rule:';
const CLAUDE_LOCAL_PREFIX = 'claude-local:';

export function claudeRuleKey(relativePath: string): string {
  return `${CLAUDE_RULE_PREFIX}${relativePath}`;
}

export function claudeLocalKey(repoFullName: string): string {
  return `${CLAUDE_LOCAL_PREFIX}${repoFullName}`;
}

/**
 * What a key names, or null when it is not one of the four shapes. The key
 * decides the agent, the target and the repository, so a body cannot claim a
 * Codex file is a Claude rule.
 */
export function parseWorkbenchInstructionKey(
  key: string,
): { agent: WorkbenchAgent; target: WorkbenchInstructionTarget; repoFullName?: string } | null {
  if (typeof key !== 'string' || key.length === 0 || key.length > 300) return null;
  if (key === CLAUDE_USER_INSTRUCTIONS_KEY) return { agent: 'claude', target: 'user' };
  if (key === CODEX_USER_INSTRUCTIONS_KEY) return { agent: 'codex', target: 'user' };
  if (key.startsWith(CLAUDE_RULE_PREFIX)) {
    const rel = key.slice(CLAUDE_RULE_PREFIX.length);
    const segments = rel.split('/');
    if (
      !rel.endsWith('.md') ||
      rel.startsWith('/') ||
      segments.some((s) => s === '' || s === '.' || s === '..' || /[\\\0\n\r]/.test(s))
    ) {
      return null;
    }
    return { agent: 'claude', target: 'user' };
  }
  if (key.startsWith(CLAUDE_LOCAL_PREFIX)) {
    const repoFullName = key.slice(CLAUDE_LOCAL_PREFIX.length);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoFullName)) return null;
    if (repoFullName.split('/').some((s) => /^\.+$/.test(s))) return null;
    return { agent: 'claude', target: 'repo', repoFullName };
  }
  return null;
}

// ============================================================================
// Claude Code `@path` imports
// ============================================================================

/** Claude Code follows imports at most this many hops deep. */
export const MAX_INSTRUCTION_IMPORT_DEPTH = 5;

/** File access for the inliner. Paths are whatever the host's own path module produces. */
export interface InstructionImportHost {
  home: string;
  /** The file's text, following symlinks; null when it is missing or unreadable. */
  read(path: string): Promise<string | null>;
  /** The resolved real path, or null when there is none. */
  realpath(path: string): Promise<string | null>;
  dirname(path: string): string;
  /** `dir` joined with a relative path, normalised. */
  join(dir: string, relative: string): string;
  isAbsolute(path: string): boolean;
  /** The path as a person reads it, with `~` for the home directory. */
  display(path: string): string;
}

export interface InlinedInstructions {
  content: string;
  imports: string[];
  missingImports: string[];
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const IMPORT_TOKEN = /(^|\s)@(\S+)/g;

/**
 * An `@token` that reads as a path: `~/…`, absolute, or relative with a `/`
 * or a `.` in it. A bare `@name` is a mention in prose, not an import.
 */
function importSpec(raw: string): string | null {
  const spec = raw.replace(/[,;:!?)\]]+$/, '').replace(/\.+$/, '');
  if (!spec) return null;
  if (spec.startsWith('~/') || spec.startsWith('/')) return spec;
  if (spec.includes('/') || spec.includes('.')) return spec;
  return null;
}

/** The line with inline code spans blanked out, so their `@` tokens are not read. */
function maskInlineCode(line: string): string {
  return line.replace(/(`+)[^`]*?\1/g, (m) => ' '.repeat(m.length));
}

/**
 * Inline Claude Code memory imports: each `@path` token outside code is
 * replaced by the file's content between two comments that name it. Relative
 * paths resolve against the directory of the importing file as it was
 * listed, then against its real directory (a symlinked `~/.claude/CLAUDE.md`
 * imports relative to `~/.claude`, the way Claude Code reads it). A missing
 * import stays as text. A cycle, or an import past the depth limit, stays as
 * text and is not reported missing.
 */
export async function inlineInstructionImports(
  content: string,
  filePath: string,
  host: InstructionImportHost,
  maxDepth = MAX_INSTRUCTION_IMPORT_DEPTH,
): Promise<InlinedInstructions> {
  const imports: string[] = [];
  const missingImports: string[] = [];
  const note = (list: string[], value: string) => {
    if (!list.includes(value)) list.push(value);
  };

  const identity = async (p: string) => (await host.realpath(p)) ?? p;

  async function expand(text: string, path: string, depth: number, chain: string[]): Promise<string> {
    if (depth >= maxDepth) return text;
    const dirs = [host.dirname(path)];
    const real = await host.realpath(path);
    if (real && host.dirname(real) !== dirs[0]) dirs.push(host.dirname(real));

    const lines = text.split('\n');
    let fence: string | null = null;
    const out: string[] = [];
    for (const line of lines) {
      const fenceMatch = line.match(FENCE);
      if (fence) {
        if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
        out.push(line);
        continue;
      }
      if (fenceMatch) {
        fence = fenceMatch[1];
        out.push(line);
        continue;
      }
      const masked = maskInlineCode(line);
      const replacements: Array<{ start: number; end: number; text: string }> = [];
      for (const m of masked.matchAll(IMPORT_TOKEN)) {
        const spec = importSpec(m[2]);
        if (!spec) continue;
        const start = (m.index ?? 0) + m[1].length;
        const end = start + 1 + spec.length;
        const candidates = spec.startsWith('~/')
          ? [host.join(host.home, spec.slice(2))]
          : host.isAbsolute(spec)
            ? [spec]
            : dirs.map((d) => host.join(d, spec));
        let found: { path: string; text: string } | null = null;
        for (const candidate of candidates) {
          const read = await host.read(candidate);
          if (read !== null) {
            found = { path: candidate, text: read };
            break;
          }
        }
        if (!found) {
          note(missingImports, host.display(candidates[0]));
          continue;
        }
        const id = await identity(found.path);
        if (chain.includes(id)) continue;
        const shown = host.display(found.path);
        note(imports, shown);
        const body = await expand(found.text, found.path, depth + 1, [...chain, id]);
        replacements.push({
          start,
          end,
          text: `<!-- imported from ${shown} -->\n${body.replace(/\n+$/, '')}\n<!-- end of ${shown} -->`,
        });
      }
      let result = line;
      for (const r of replacements.reverse()) {
        result = result.slice(0, r.start) + r.text + result.slice(r.end);
      }
      out.push(result);
    }
    return out.join('\n');
  }

  const expanded = await expand(content, filePath, 0, [await identity(filePath)]);
  return { content: expanded, imports, missingImports };
}

// ============================================================================
// Repository instructions: written in Talyn, per repository
// ============================================================================

/** Which agents a repository's instructions go to. */
export type RepositoryInstructionAgents = WorkbenchAgent | 'both';

export const REPOSITORY_INSTRUCTION_AGENTS: readonly RepositoryInstructionAgents[] = ['claude', 'codex', 'both'];

/**
 * The text goes into every turn of every session on the repository, as the
 * Mac files above do. 64 KiB is about 16k tokens: a long house style guide
 * fits, and a pasted codebase does not.
 */
export const MAX_REPOSITORY_INSTRUCTION_BYTES = 64 * 1024;

/** Put between a synced file and the Talyn text when both target one path. */
export const REPOSITORY_INSTRUCTIONS_HEADING = '## Talyn repository instructions';

export function repositoryInstructionsTooLargeMessage(bytes: number): string {
  const kb = Math.ceil(bytes / 1024);
  return `Repository instructions load into every turn; these are ${kb} KB. Trim them below 64 KB.`;
}

/** One repository's instructions. */
export interface RepositoryInstructions {
  repositoryId: string;
  body: string;
  agents: RepositoryInstructionAgents;
  bytes: number;
  updatedAt: string;
}

/** What the list returns: which repositories have instructions, never the text. */
export type RepositoryInstructionsSummary = Omit<RepositoryInstructions, 'body'>;

export interface PutRepositoryInstructionsInput {
  body: string;
  agents: RepositoryInstructionAgents;
}

/** The Mac file's text, then the Talyn text under its heading. Either may be empty. */
export function joinRepositoryInstructions(synced: string | null | undefined, body: string): string {
  const own = body.replace(/\s+$/, '');
  if (!own) return synced ?? '';
  const first = (synced ?? '').replace(/\s+$/, '');
  if (!first) return own;
  return `${first}\n\n${REPOSITORY_INSTRUCTIONS_HEADING}\n\n${own}`;
}

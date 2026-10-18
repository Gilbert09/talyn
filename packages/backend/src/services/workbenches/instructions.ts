import { createHash } from 'crypto';
import { v4 as uuid } from 'uuid';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import {
  instructionFileTooLargeMessage,
  MAX_WORKBENCH_INSTRUCTION_BYTES,
  parseWorkbenchInstructionKey,
  type PutWorkbenchInstructionFileInput,
  type WorkbenchAgent,
  type WorkbenchInstructionFile,
  type WorkbenchInstructionTarget,
} from '@talyn/shared';
import { getPoolDbClient, type Database } from '../../db/client.js';
import { workbenchInstructionFiles as filesTable } from '../../db/schema.js';
import { WorkbenchError } from './errors.js';
import { repoDirFor } from './sandboxRuntime.js';
import { shellPath, writeSandboxFiles, type SandboxFile } from './sandboxFiles.js';
import type { WorkbenchRow } from './store.js';

/**
 * The user's own instruction files, stored per workspace and copied into a
 * sandbox session before each turn. On the pool, like the rest of the
 * workbench store: the routes authorise first.
 *
 * In the box (the agent runs as `fleet`, with `$HOME` set by the exec):
 * - Claude: each user file becomes `$HOME/.claude/rules/talyn-<slug>.md`,
 *   which Claude Code loads as a user rule. `$HOME/.claude/CLAUDE.md` is the
 *   fleet's own briefing and is never touched. A repository's
 *   `CLAUDE.local.md` goes in the repository, listed in `.git/info/exclude`.
 * - Codex: one marked block at the end of `$HOME/.codex/AGENTS.md`, stripped
 *   and appended again on every sync, because Codex has no rules directory.
 */

const db = (): Database => getPoolDbClient();

export const INSTRUCTION_RULES_DIR = '~/.claude/rules';
export const CODEX_AGENTS_FILE = '~/.codex/AGENTS.md';
export const CODEX_BLOCK_START = '<!-- talyn:instructions:start -->';
export const CODEX_BLOCK_END = '<!-- talyn:instructions:end -->';
/** Marks a `CLAUDE.local.md` this sync wrote, so switching it off removes only ours. */
const CLAUDE_LOCAL_STAMP = 'talyn-claude-local';
const CODEX_BLOCK_TMP = '~/.talyn/codex-instructions.md';

/** Every column but `content`. The list never ships the text. */
const LIST_COLUMNS = {
  key: filesTable.key,
  agent: filesTable.agent,
  target: filesTable.target,
  repoFullName: filesTable.repoFullName,
  sourcePath: filesTable.sourcePath,
  bytes: filesTable.bytes,
  contentHash: filesTable.contentHash,
  enabled: filesTable.enabled,
  updatedAt: filesTable.updatedAt,
} as const;

type ListRow = Pick<typeof filesTable.$inferSelect, keyof typeof LIST_COLUMNS>;

function toPublic(row: ListRow): WorkbenchInstructionFile {
  return {
    key: row.key,
    agent: row.agent as WorkbenchAgent,
    target: row.target as WorkbenchInstructionTarget,
    repoFullName: row.repoFullName,
    sourcePath: row.sourcePath,
    bytes: row.bytes,
    contentHash: row.contentHash,
    enabled: row.enabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export async function listInstructionFiles(workspaceId: string): Promise<WorkbenchInstructionFile[]> {
  const rows = await db()
    .select(LIST_COLUMNS)
    .from(filesTable)
    .where(eq(filesTable.workspaceId, workspaceId))
    .orderBy(asc(filesTable.key));
  return rows.map(toPublic);
}

/** Check a PUT body. Throws a 400 (or a 413 for size) that says what is wrong. */
export function validateInstructionFile(file: PutWorkbenchInstructionFileInput['file'] | undefined): {
  key: string;
  agent: WorkbenchAgent;
  target: WorkbenchInstructionTarget;
  repoFullName: string | null;
  sourcePath: string;
  content: string;
  enabled: boolean;
} {
  if (!file || typeof file !== 'object') throw new WorkbenchError('file is required', 400, 'bad_instruction_file');
  const parsed = parseWorkbenchInstructionKey(file.key);
  if (!parsed) throw new WorkbenchError(`Unknown instruction file key "${String(file.key)}".`, 400, 'bad_instruction_key');
  if (file.agent !== parsed.agent) throw new WorkbenchError(`agent must be "${parsed.agent}" for this key`, 400, 'bad_instruction_file');
  if (file.target !== parsed.target) throw new WorkbenchError(`target must be "${parsed.target}" for this key`, 400, 'bad_instruction_file');
  const repoFullName = parsed.repoFullName ?? null;
  if ((file.repoFullName ?? null) !== repoFullName) {
    throw new WorkbenchError('repoFullName must match the key', 400, 'bad_instruction_file');
  }
  if (typeof file.sourcePath !== 'string' || !file.sourcePath.trim() || file.sourcePath.length > 1024) {
    throw new WorkbenchError('sourcePath must be a non-empty string', 400, 'bad_instruction_file');
  }
  if (typeof file.enabled !== 'boolean') throw new WorkbenchError('enabled must be a boolean', 400, 'bad_instruction_file');
  if (file.enabled && typeof file.content !== 'string') {
    throw new WorkbenchError('content must be a string', 400, 'bad_instruction_file');
  }
  if (file.content !== undefined && typeof file.content !== 'string') {
    throw new WorkbenchError('content must be a string', 400, 'bad_instruction_file');
  }
  // A file switched off keeps its row (so the next sync removes it from the
  // box) but not its text: switching it on uploads the file again.
  const content = file.enabled ? (file.content as string) : '';
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_WORKBENCH_INSTRUCTION_BYTES) {
    throw new WorkbenchError(instructionFileTooLargeMessage(bytes), 413, 'instruction_file_too_large');
  }
  return { key: file.key, ...parsed, repoFullName, sourcePath: file.sourcePath.trim(), content, enabled: file.enabled };
}

export async function putInstructionFile(
  workspaceId: string,
  input: PutWorkbenchInstructionFileInput['file'] | undefined,
): Promise<WorkbenchInstructionFile> {
  const file = validateInstructionFile(input);
  const values = {
    agent: file.agent,
    target: file.target,
    repoFullName: file.repoFullName,
    sourcePath: file.sourcePath,
    content: file.content,
    contentHash: file.content ? contentHash(file.content) : '',
    bytes: Buffer.byteLength(file.content, 'utf8'),
    enabled: file.enabled,
    updatedAt: new Date(),
  };
  const [row] = await db()
    .insert(filesTable)
    .values({ id: uuid(), workspaceId, key: file.key, ...values })
    .onConflictDoUpdate({ target: [filesTable.workspaceId, filesTable.key], set: values })
    .returning(LIST_COLUMNS);
  return toPublic(row);
}

export async function removeInstructionFile(workspaceId: string, key: string): Promise<boolean> {
  const rows = await db()
    .delete(filesTable)
    .where(and(eq(filesTable.workspaceId, workspaceId), eq(filesTable.key, key)))
    .returning({ key: filesTable.key });
  return rows.length > 0;
}

// ============================================================================
// The turn path
// ============================================================================

/** The rules file name for a Claude user key: `claude-user` → `talyn-user.md`. */
export function ruleFileName(key: string): string {
  const base = key
    .replace(/^claude-/, '')
    .replace(/\.md$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `talyn-${base || 'file'}.md`;
}

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

interface SyncRow {
  key: string;
  target: string;
  sourcePath: string;
  content: string;
}

/** `.git/info/exclude` gets `CLAUDE.local.md` once; the stamp says the file is ours. */
function claudeLocalBefore(repoDir: string): string {
  return [
    `cd ${shellPath(repoDir)}`,
    'ex=$(git rev-parse --git-path info/exclude)',
    'mkdir -p "$(dirname "$ex")"',
    'touch "$ex"',
    `if ! grep -qxF CLAUDE.local.md "$ex"; then`,
    `  if [ -s "$ex" ] && [ -n "$(tail -c1 "$ex")" ]; then echo >> "$ex"; fi`,
    '  echo CLAUDE.local.md >> "$ex"',
    'fi',
    `: > "$(git rev-parse --git-path ${CLAUDE_LOCAL_STAMP})"`,
    'cd /',
  ].join('\n');
}

/** Remove a `CLAUDE.local.md` an earlier sync wrote. Leaves one the user made in the box. */
function claudeLocalCleanup(repoDir: string): string {
  return [
    `if cd ${shellPath(repoDir)} 2>/dev/null; then`,
    `  stamp=$(git rev-parse --git-path ${CLAUDE_LOCAL_STAMP} 2>/dev/null || true)`,
    '  if [ -n "$stamp" ] && [ -e "$stamp" ]; then rm -f CLAUDE.local.md "$stamp"; fi',
    '  cd /',
    'fi',
  ].join('\n');
}

/** Delete every `talyn-*.md` in the rules directory that is not in `keep`. */
function staleRulesCleanup(keep: string[]): string {
  const dir = shellPath(INSTRUCTION_RULES_DIR);
  const remove = keep.length > 0 ? `case "\${f##*/}" in ${keep.join('|')}) ;; *) rm -f "$f" ;; esac` : 'rm -f "$f"';
  return [`for f in ${dir}/talyn-*.md; do`, '  [ -e "$f" ] || continue', `  ${remove}`, 'done'].join('\n');
}

/** Strip the old block (and trailing blank lines), then append the new one when there is one. */
function codexBlockScript(hasBlock: boolean): string {
  const file = shellPath(CODEX_AGENTS_FILE);
  const tmp = shellPath(`${CODEX_AGENTS_FILE}.talyn-tmp`);
  const awk =
    `awk -v s=${shellQuoteRaw(CODEX_BLOCK_START)} -v e=${shellQuoteRaw(CODEX_BLOCK_END)} ` +
    `'$0==s{skip=1;next} $0==e{skip=0;next} !skip{l[++n]=$0} END{while(n>0&&l[n]=="")n--; for(i=1;i<=n;i++)print l[i]}'`;
  const lines = [`mkdir -p ${shellPath('~/.codex')}`];
  if (hasBlock) {
    lines.push(
      `if [ -f ${file} ]; then ${awk} ${file} > ${tmp}; else : > ${tmp}; fi`,
      `{ if [ -s ${tmp} ]; then echo; fi; echo ${shellQuoteRaw(CODEX_BLOCK_START)}; cat ${shellPath(CODEX_BLOCK_TMP)}; echo; echo ${shellQuoteRaw(CODEX_BLOCK_END)}; } >> ${tmp}`,
      `mv -f ${tmp} ${file}`,
      `rm -f ${shellPath(CODEX_BLOCK_TMP)}`,
    );
  } else {
    lines.push(`if [ -f ${file} ] && grep -qxF ${shellQuoteRaw(CODEX_BLOCK_START)} ${file}; then ${awk} ${file} > ${tmp} && mv -f ${tmp} ${file}; fi`);
  }
  return lines.join('\n');
}

/** Always single-quoted: the markers contain `<` and `!`. */
function shellQuoteRaw(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Copy the workspace's switched-on files for `agent` into the sandbox, and
 * take away the ones switched off since. Skipped entirely when the workspace
 * has never stored a file for this agent, so a session that never used the
 * feature pays no exec for it.
 */
export async function syncInstructionFiles(row: WorkbenchRow, agent: WorkbenchAgent = row.agent as WorkbenchAgent): Promise<void> {
  const [any] = await db()
    .select({ key: filesTable.key })
    .from(filesTable)
    .where(and(eq(filesTable.workspaceId, row.workspaceId), eq(filesTable.agent, agent)))
    .limit(1);
  if (!any) return;

  const rows: SyncRow[] = await db()
    .select({ key: filesTable.key, target: filesTable.target, sourcePath: filesTable.sourcePath, content: filesTable.content })
    .from(filesTable)
    .where(
      and(
        eq(filesTable.workspaceId, row.workspaceId),
        eq(filesTable.agent, agent),
        eq(filesTable.enabled, true),
        or(
          eq(filesTable.target, 'user'),
          and(eq(filesTable.target, 'repo'), sql`lower(${filesTable.repoFullName}) = lower(${row.repoFullName})`),
        ),
      ),
    )
    .orderBy(asc(filesTable.key));

  await writeSandboxFiles(row, ...instructionSyncPlan(row, agent, rows));
}

/** The files to write and the scripts around them. Split out so a test can read it. */
export function instructionSyncPlan(
  row: Pick<WorkbenchRow, 'repoFullName'>,
  agent: WorkbenchAgent,
  rows: SyncRow[],
): [SandboxFile[], { before?: string; after: string }] {
  const repoDir = repoDirFor(row);
  if (agent === 'codex') {
    const body = rows
      .filter((r) => r.target === 'user')
      .map((r) => `<!-- from ${r.sourcePath} -->\n${r.content.replace(/\n+$/, '')}`)
      .join('\n\n');
    const files = body ? [{ path: CODEX_BLOCK_TMP, base64: b64(body) }] : [];
    return [files, { after: codexBlockScript(Boolean(body)) }];
  }

  const files: SandboxFile[] = [];
  const keep: string[] = [];
  for (const r of rows.filter((x) => x.target === 'user')) {
    let name = ruleFileName(r.key);
    if (keep.includes(name)) name = name.replace(/\.md$/, `-${contentHash(r.key).slice(0, 8)}.md`);
    keep.push(name);
    files.push({ path: `${INSTRUCTION_RULES_DIR}/${name}`, base64: b64(r.content) });
  }
  const local = rows.find((r) => r.target === 'repo');
  if (local) files.push({ path: `${repoDir}/CLAUDE.local.md`, base64: b64(local.content) });
  return [
    files,
    {
      ...(local ? { before: claudeLocalBefore(repoDir) } : {}),
      after: [
        `mkdir -p ${shellPath(INSTRUCTION_RULES_DIR)}`,
        staleRulesCleanup(keep),
        ...(local ? [] : [claudeLocalCleanup(repoDir)]),
      ].join('\n'),
    },
  ];
}
